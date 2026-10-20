import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { PaymentBackfillStatus } from "@prisma/client";
import { ApiErrorCode } from "../common/dto/api-error.dto";
import { AscendingPaymentsPage } from "../stellar/horizon-client";
import { NormalizedPayment } from "../stellar/stellar.types";
import {
  BACKFILL_PAGES_PER_LEASE,
  MAX_BACKFILL_ATTEMPTS,
  MAX_BACKFILL_LEDGER_SPAN,
  PaymentBackfillService,
  ledgerEndExclusive,
  ledgerStartCursor,
  planBackfillPage,
  validateBackfillRange,
} from "./payment-backfill.service";

const ADMIN = {
  id: "admin_1",
  walletAddress: "GADMIN",
  walletHash: "sha256:admin",
  role: "ADMIN",
} as never;
const WALLET = "GUSERWALLET";
const config = {
  getOrThrow: (key: string) =>
    key === "paymentEncryptionKey"
      ? "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
      : undefined,
};

/** TOID of operation `op` in transaction `tx` of `ledger`. */
function toid(ledger: number, tx = 1, op = 1): bigint {
  return (BigInt(ledger) << 32n) | (BigInt(tx) << 12n) | BigInt(op);
}

function payment(id: bigint, overrides: Partial<NormalizedPayment> = {}): NormalizedPayment {
  return {
    operationId: id.toString(),
    stellarTransactionHash: `tx_${id}`,
    sourceAddress: "GPAYER",
    destinationAddress: WALLET,
    assetCode: "USDC",
    assetIssuer: "GASSETISSUER",
    amount: "10.0000000",
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function page(ids: bigint[], nextCursor: string | null = "more"): AscendingPaymentsPage {
  return {
    records: ids.map((id) => ({ toid: id, payment: payment(id) })),
    nextCursor: nextCursor === "more" ? ids.at(-1)?.toString() ?? null : nextCursor,
    attempts: 1,
  };
}

describe("payment backfill range rules", () => {
  it("accepts a single ledger and the maximum span", () => {
    expect(validateBackfillRange(100, 100)).toBeNull();
    expect(validateBackfillRange(100, 100 + MAX_BACKFILL_LEDGER_SPAN - 1)).toBeNull();
  });

  it.each([
    ["one ledger over the maximum span", 100, 100 + MAX_BACKFILL_LEDGER_SPAN, "too_large"],
    ["an inverted range", 200, 100, "inverted"],
    ["the genesis ledger", 1, 10, "below_minimum"],
    ["a ledger beyond the column range", 10, 2_147_483_648, "above_maximum"],
    ["a fractional ledger", 10.5, 20, "not_integer"],
  ])("rejects %s", (_label, start, end, violation) => {
    expect(validateBackfillRange(start, end)).toBe(violation);
  });

  it("maps a ledger range onto half-open paging-token bounds", () => {
    expect(ledgerStartCursor(100) < toid(100, 1, 1)).toBe(true);
    expect(toid(100, 4095, 4095) < ledgerEndExclusive(100)).toBe(true);
    expect(ledgerEndExclusive(100)).toBe(ledgerStartCursor(101));
  });
});

describe("planBackfillPage", () => {
  const start = ledgerStartCursor(100);
  const end = ledgerEndExclusive(110);

  it("collects in-range payments and advances the checkpoint to the last record", () => {
    const plan = planBackfillPage(page([toid(100), toid(105)]), start, end);
    expect(plan.payments.map((p) => p.operationId)).toEqual([
      toid(100).toString(),
      toid(105).toString(),
    ]);
    expect(plan).toMatchObject({
      recordsSeen: 2,
      nextCheckpoint: toid(105),
      done: false,
      stalled: false,
    });
  });

  it("stops at the first record beyond the end ledger", () => {
    const plan = planBackfillPage(page([toid(110), toid(111), toid(112)]), start, end);
    expect(plan.payments.map((p) => p.operationId)).toEqual([toid(110).toString()]);
    expect(plan).toMatchObject({ done: true, nextCheckpoint: toid(110) });
  });

  it("never moves the checkpoint backward on a replayed page", () => {
    const checkpoint = toid(105);
    const plan = planBackfillPage(page([toid(101), toid(103), toid(105)]), checkpoint, end);
    expect(plan.payments).toEqual([]);
    expect(plan.nextCheckpoint >= checkpoint).toBe(true);
  });

  it("skips duplicate operations already behind the checkpoint", () => {
    const plan = planBackfillPage(page([toid(104), toid(106)]), toid(104), end);
    expect(plan.payments.map((p) => p.operationId)).toEqual([toid(106).toString()]);
  });

  it("completes on an exhausted feed", () => {
    expect(planBackfillPage(page([], null), start, end)).toMatchObject({
      done: true,
      nextCheckpoint: start,
    });
    expect(planBackfillPage(page([toid(101)], null), start, end)).toMatchObject({
      done: true,
      nextCheckpoint: toid(101),
    });
  });

  it("counts non-payment records toward progress without ingesting them", () => {
    const plan = planBackfillPage(
      {
        records: [
          { toid: toid(101), payment: null },
          { toid: toid(102), payment: payment(toid(102)) },
        ],
        nextCursor: toid(102).toString(),
        attempts: 1,
      },
      start,
      end,
    );
    expect(plan.recordsSeen).toBe(2);
    expect(plan.payments).toHaveLength(1);
  });

  it("advances past a page of malformed records using Horizon's cursor", () => {
    const plan = planBackfillPage(
      { records: [{ toid: null, payment: null }], nextCursor: toid(103).toString(), attempts: 1 },
      start,
      end,
    );
    expect(plan).toMatchObject({ nextCheckpoint: toid(103), stalled: false, done: false });
  });

  it("flags a page that makes no progress instead of looping", () => {
    const plan = planBackfillPage(
      { records: [{ toid: null, payment: null }], nextCursor: start.toString(), attempts: 1 },
      start,
      end,
    );
    expect(plan.stalled).toBe(true);
  });
});

type Job = {
  id: string;
  userId: string;
  startLedger: number;
  endLedger: number;
  status: PaymentBackfillStatus;
  checkpointCursor: string | null;
  pagesProcessed: number;
  recordsSeen: number;
  paymentsCreated: number;
  duplicatesSkipped: number;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  cancelRequestedAt: Date | null;
  lastErrorSafe: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * In-memory stand-in for the job table and the Payment unique index, enough
 * to exercise the worker's claim / commit / lease-check protocol end to end.
 */
function worldOf(initial: Partial<Job> = {}, existingOperationIds: string[] = []) {
  const job: Job = {
    id: "job_1",
    userId: "user_1",
    startLedger: 100,
    endLedger: 110,
    status: PaymentBackfillStatus.PENDING,
    checkpointCursor: null,
    pagesProcessed: 0,
    recordsSeen: 0,
    paymentsCreated: 0,
    duplicatesSkipped: 0,
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    cancelRequestedAt: null,
    lastErrorSafe: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...initial,
  };
  const stored = new Map<string, Record<string, unknown>>(
    existingOperationIds.map((id) => [id, { operationId: id, forwardSynced: true }]),
  );
  const writes: string[] = [];

  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      const current = (job as Record<string, unknown>)[key];
      if (value === null) return current === null;
      if (value && typeof value === "object" && "not" in (value as object)) {
        return current !== null;
      }
      if (value && typeof value === "object" && "lt" in (value as object)) {
        return current instanceof Date && current < (value as { lt: Date }).lt;
      }
      return current === value;
    });

  const apply = (data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in (value as object)) {
        (job as Record<string, number>)[key] += (value as { increment: number }).increment;
      } else {
        (job as Record<string, unknown>)[key] = value;
      }
    }
  };

  const prisma: any = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (!sql.includes('UPDATE "PaymentBackfillJob"')) throw new Error(`unexpected: ${sql}`);
      writes.push("claim");
      const now = values.find((value) => value instanceof Date) as Date;
      const claimable =
        job.cancelRequestedAt === null &&
        (job.status === PaymentBackfillStatus.PENDING ||
          (job.status === PaymentBackfillStatus.RUNNING &&
            job.leaseExpiresAt !== null &&
            job.leaseExpiresAt < now));
      if (!claimable) return [];
      const owner = values.find((value) => typeof value === "string" && value.startsWith("owner")) as string;
      const leaseUntil = values.filter((value) => value instanceof Date)[1] as Date;
      job.status = PaymentBackfillStatus.RUNNING;
      job.leaseOwner = owner;
      job.leaseExpiresAt = leaseUntil;
      job.attempts += 1;
      return [
        {
          id: job.id,
          userId: job.userId,
          startLedger: job.startLedger,
          endLedger: job.endLedger,
          checkpointCursor: job.checkpointCursor,
          attempts: job.attempts,
        },
      ];
    }),
    user: { findUnique: jest.fn().mockResolvedValue({ walletAddress: WALLET }) },
    supportedAsset: {
      findMany: jest.fn().mockResolvedValue([{ code: "USDC", issuer: "GASSETISSUER" }]),
    },
    payment: {
      createMany: jest.fn(async ({ data, skipDuplicates }: { data: Array<Record<string, unknown>>; skipDuplicates: boolean }) => {
        writes.push("payment.createMany");
        expect(skipDuplicates).toBe(true);
        let count = 0;
        for (const row of data) {
          if (stored.has(row.operationId as string)) continue;
          stored.set(row.operationId as string, row);
          count += 1;
        }
        return { count };
      }),
      upsert: jest.fn(() => {
        throw new Error("backfill must never rewrite an existing payment");
      }),
      update: jest.fn(() => {
        throw new Error("backfill must never rewrite an existing payment");
      }),
      updateMany: jest.fn(() => {
        throw new Error("backfill must never rewrite an existing payment");
      }),
    },
    paymentBackfillJob: {
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push("job.updateMany");
        const { id, ...rest } = where;
        if (id !== undefined && id !== job.id) return { count: 0 };
        if (!matches(rest)) return { count: 0 };
        apply(data);
        return { count: 1 };
      }),
    },
  };
  prisma.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) => {
    // Page and checkpoint commit atomically: roll back on throw.
    const snapshot = { ...job };
    const storedBefore = new Map(stored);
    try {
      return await callback(prisma);
    } catch (error) {
      Object.assign(job, snapshot);
      stored.clear();
      for (const [key, value] of storedBefore) stored.set(key, value);
      throw error;
    }
  });

  return { job, stored, writes, prisma };
}

function serviceWith(prisma: unknown, pages: Array<AscendingPaymentsPage | Error>) {
  const cursors: string[] = [];
  const stellar = {
    readPaymentsPageAscending: jest.fn(async (_address: string, options: { cursor: string }) => {
      cursors.push(options.cursor);
      const next = pages.shift();
      if (!next) return page([], null);
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const service = new PaymentBackfillService(prisma as never, stellar as never, config as never);
  return { service, stellar, cursors };
}

describe("PaymentBackfillService worker", () => {
  it("processes pages to completion and inserts only new payments", async () => {
    const world = worldOf();
    const { service, cursors } = serviceWith(world.prisma, [
      page([toid(100), toid(101)]),
      page([toid(105), toid(111)]),
    ]);

    await expect(service.runLease("owner-a")).resolves.toBe("completed");

    expect(cursors).toEqual([
      ledgerStartCursor(100).toString(),
      toid(101).toString(),
    ]);
    expect(world.job).toMatchObject({
      status: PaymentBackfillStatus.COMPLETED,
      checkpointCursor: toid(105).toString(),
      pagesProcessed: 2,
      paymentsCreated: 3,
      duplicatesSkipped: 0,
      leaseOwner: null,
    });
    expect([...world.stored.keys()]).not.toContain(toid(111).toString());
  });

  it("deduplicates against payments normal sync already stored and leaves them untouched", async () => {
    const existing = toid(101).toString();
    const world = worldOf({}, [existing]);
    const { service } = serviceWith(world.prisma, [page([toid(100), toid(101), toid(102)], null)]);

    await service.runLease("owner-a");

    expect(world.job).toMatchObject({ paymentsCreated: 2, duplicatesSkipped: 1 });
    expect(world.stored.get(existing)).toEqual({ operationId: existing, forwardSynced: true });
    expect(world.prisma.payment.upsert).not.toHaveBeenCalled();
  });

  it("stores payments encrypted, unclassified, and eligible only for supported assets", async () => {
    const world = worldOf();
    const { service } = serviceWith(world.prisma, [
      {
        records: [
          { toid: toid(100), payment: payment(toid(100)) },
          { toid: toid(101), payment: payment(toid(101), { assetCode: "XLM", assetIssuer: null }) },
        ],
        nextCursor: null,
        attempts: 1,
      },
    ]);

    await service.runLease("owner-a");

    const supported = world.stored.get(toid(100).toString()) as Record<string, unknown>;
    const unsupported = world.stored.get(toid(101).toString()) as Record<string, unknown>;
    expect(supported).toMatchObject({
      userId: "user_1",
      classification: "UNKNOWN",
      isEligible: true,
      amountEncrypted: expect.stringMatching(/^enc:v0:/),
    });
    expect(supported.amountEncrypted).not.toContain("10.0000000");
    expect(supported).not.toHaveProperty("memo");
    expect(unsupported.isEligible).toBe(false);
  });

  it("yields after a bounded number of pages and keeps its checkpoint", async () => {
    const world = worldOf();
    const pages = Array.from({ length: BACKFILL_PAGES_PER_LEASE + 2 }, (_, index) =>
      page([toid(100 + index)]),
    );
    const { service } = serviceWith(world.prisma, pages);

    await expect(service.runLease("owner-a")).resolves.toBe("yielded");

    expect(world.job).toMatchObject({
      status: PaymentBackfillStatus.PENDING,
      leaseOwner: null,
      pagesProcessed: BACKFILL_PAGES_PER_LEASE,
      checkpointCursor: toid(100 + BACKFILL_PAGES_PER_LEASE - 1).toString(),
    });
  });

  it("resumes a restarted job from its committed checkpoint", async () => {
    // A worker crashed after committing ledger 104; its lease has expired.
    const world = worldOf({
      status: PaymentBackfillStatus.RUNNING,
      checkpointCursor: toid(104).toString(),
      leaseOwner: "owner-dead",
      leaseExpiresAt: new Date(Date.now() - 1_000),
      pagesProcessed: 3,
    });
    const { service, cursors } = serviceWith(world.prisma, [page([toid(105), toid(106)], null)]);

    await expect(service.runLease("owner-b")).resolves.toBe("completed");

    expect(cursors[0]).toBe(toid(104).toString());
    expect(world.job).toMatchObject({ pagesProcessed: 4, paymentsCreated: 2 });
  });

  it("does not claim a running job whose lease is still valid", async () => {
    const world = worldOf({
      status: PaymentBackfillStatus.RUNNING,
      leaseOwner: "owner-live",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const { service, stellar } = serviceWith(world.prisma, [page([toid(100)])]);

    await expect(service.runLease("owner-b")).resolves.toBe("idle");
    expect(stellar.readPaymentsPageAscending).not.toHaveBeenCalled();
  });

  it("rolls back a page committed after the lease was lost", async () => {
    const world = worldOf();
    const { service } = serviceWith(world.prisma, [page([toid(100)])]);
    world.prisma.user.findUnique.mockImplementationOnce(async () => {
      // Another worker takes over while this one is mid-page.
      world.job.leaseOwner = "owner-other";
      return { walletAddress: WALLET };
    });

    await expect(service.runLease("owner-a")).resolves.toBe("lease_lost");

    expect(world.stored.size).toBe(0);
    expect(world.job).toMatchObject({ pagesProcessed: 0, checkpointCursor: null });
  });

  describe("cancellation", () => {
    it("stops a running job at the next page boundary and keeps committed pages", async () => {
      const world = worldOf();
      const { service } = serviceWith(world.prisma, [page([toid(100)]), page([toid(101)])]);
      let pagesRead = 0;
      world.prisma.user.findUnique.mockImplementation(async () => {
        pagesRead += 1;
        if (pagesRead === 2) world.job.cancelRequestedAt = new Date();
        return { walletAddress: WALLET };
      });

      await expect(service.runLease("owner-a")).resolves.toBe("cancelled");

      expect(world.job).toMatchObject({
        status: PaymentBackfillStatus.CANCELLED,
        pagesProcessed: 1,
        checkpointCursor: toid(100).toString(),
      });
      expect([...world.stored.keys()]).toEqual([toid(100).toString()]);
    });

    it("finalizes a cancellation whose worker disappeared", async () => {
      const world = worldOf({
        status: PaymentBackfillStatus.RUNNING,
        leaseOwner: "owner-dead",
        leaseExpiresAt: new Date(Date.now() - 1_000),
        cancelRequestedAt: new Date(Date.now() - 5_000),
      });
      const { service, stellar } = serviceWith(world.prisma, []);

      await expect(service.runLease("owner-b")).resolves.toBe("idle");

      expect(world.job.status).toBe(PaymentBackfillStatus.CANCELLED);
      expect(stellar.readPaymentsPageAscending).not.toHaveBeenCalled();
    });
  });

  describe("failures", () => {
    it("releases the job for retry on a Horizon failure without a safe-message leak", async () => {
      const world = worldOf();
      const { service } = serviceWith(world.prisma, [new Error(`boom ${WALLET}`)]);

      await expect(service.runLease("owner-a")).resolves.toBe("retrying");

      expect(world.job).toMatchObject({
        status: PaymentBackfillStatus.PENDING,
        lastErrorSafe: "horizon_unavailable",
        leaseOwner: null,
      });
    });

    it("fails after repeated claims without progress", async () => {
      const world = worldOf({ attempts: MAX_BACKFILL_ATTEMPTS - 1 });
      const { service } = serviceWith(world.prisma, [new Error("down")]);

      await expect(service.runLease("owner-a")).resolves.toBe("failed");
      expect(world.job.status).toBe(PaymentBackfillStatus.FAILED);
    });

    it("resets the attempt count whenever a page commits", async () => {
      const world = worldOf({ attempts: MAX_BACKFILL_ATTEMPTS - 1 });
      const { service } = serviceWith(world.prisma, [page([toid(100)]), new Error("down")]);

      await expect(service.runLease("owner-a")).resolves.toBe("retrying");
      expect(world.job.status).toBe(PaymentBackfillStatus.PENDING);
    });
  });

  it("writes only its own job row and new payments (normal sync state is untouched)", async () => {
    const world = worldOf();
    const { service } = serviceWith(world.prisma, [page([toid(100), toid(101)], null)]);

    await service.runLease("owner-a");

    expect(new Set(world.writes)).toEqual(
      new Set(["claim", "job.updateMany", "payment.createMany"]),
    );
  });
});

describe("PaymentBackfillService operator API", () => {
  function operatorHarness(overrides: Record<string, unknown> = {}) {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "user_1" }]),
      paymentBackfillJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "job_1",
          checkpointCursor: null,
          pagesProcessed: 0,
          recordsSeen: 0,
          paymentsCreated: 0,
          duplicatesSkipped: 0,
          attempts: 0,
          cancelRequestedAt: null,
          lastErrorSafe: null,
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        })),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow: jest.fn(),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      ...overrides,
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma));
    const service = new PaymentBackfillService(prisma, {} as never, config as never);
    return { service, prisma };
  }

  async function expectCode(promise: Promise<unknown>, type: any, code: string) {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(type);
    expect((error as any).getResponse()).toMatchObject({ code });
  }

  it("persists a validated job and audits it in the same transaction", async () => {
    const { service, prisma } = operatorHarness();

    const job = await service.createJob(ADMIN, { userId: "user_1", startLedger: 100, endLedger: 200 });

    expect(job).toMatchObject({
      status: PaymentBackfillStatus.PENDING,
      startLedger: 100,
      endLedger: 200,
      cancelRequested: false,
    });
    expect(prisma.paymentBackfillJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requestedById: "admin_1", userId: "user_1" }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "payment_backfill.requested",
        metadata: { startLedger: 100, endLedger: 200 },
      }),
    });
  });

  it("locks the user row before checking for overlap", async () => {
    const { service, prisma } = operatorHarness();

    await service.createJob(ADMIN, { userId: "user_1", startLedger: 100, endLedger: 200 });

    const [strings] = prisma.$queryRaw.mock.calls[0];
    expect(strings.join("?")).toMatch(/FROM "User" WHERE "id" = \? FOR UPDATE/);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.paymentBackfillJob.findFirst.mock.invocationCallOrder[0],
    );
  });

  it("rejects an oversized range before touching the database", async () => {
    const { service, prisma } = operatorHarness();

    await expectCode(
      service.createJob(ADMIN, { userId: "user_1", startLedger: 100, endLedger: 100 + MAX_BACKFILL_LEDGER_SPAN }),
      BadRequestException,
      ApiErrorCode.INVALID_INPUT,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a job overlapping an active one for the same user", async () => {
    const { service, prisma } = operatorHarness();
    prisma.paymentBackfillJob.findFirst.mockResolvedValue({ id: "job_existing" });

    await expectCode(
      service.createJob(ADMIN, { userId: "user_1", startLedger: 150, endLedger: 250 }),
      ConflictException,
      ApiErrorCode.CONFLICT,
    );
    expect(prisma.paymentBackfillJob.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        status: { in: [PaymentBackfillStatus.PENDING, PaymentBackfillStatus.RUNNING] },
        startLedger: { lte: 250 },
        endLedger: { gte: 150 },
      },
      select: { id: true },
    });
    expect(prisma.paymentBackfillJob.create).not.toHaveBeenCalled();
  });

  it("returns not-found for an unknown user", async () => {
    const { service } = operatorHarness({ $queryRaw: jest.fn().mockResolvedValue([]) });

    await expectCode(
      service.createJob(ADMIN, { userId: "ghost", startLedger: 100, endLedger: 200 }),
      NotFoundException,
      ApiErrorCode.NOT_FOUND,
    );
  });

  describe("cancelJob", () => {
    const stored = {
      id: "job_1",
      userId: "user_1",
      startLedger: 100,
      endLedger: 200,
      checkpointCursor: null,
      pagesProcessed: 0,
      recordsSeen: 0,
      paymentsCreated: 0,
      duplicatesSkipped: 0,
      attempts: 0,
      lastErrorSafe: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("cancels a pending job immediately", async () => {
      const { service, prisma } = operatorHarness();
      prisma.paymentBackfillJob.findUnique.mockResolvedValue({ id: "job_1", status: "PENDING" });
      prisma.paymentBackfillJob.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.paymentBackfillJob.findUniqueOrThrow.mockResolvedValue({
        ...stored,
        status: PaymentBackfillStatus.CANCELLED,
        cancelRequestedAt: new Date(),
        completedAt: new Date(),
      });

      await expect(service.cancelJob(ADMIN, "job_1")).resolves.toMatchObject({
        status: PaymentBackfillStatus.CANCELLED,
        cancelRequested: true,
      });
      expect(prisma.paymentBackfillJob.updateMany).toHaveBeenCalledTimes(1);
    });

    it("flags a running job for cancellation at its next page boundary", async () => {
      const { service, prisma } = operatorHarness();
      prisma.paymentBackfillJob.findUnique.mockResolvedValue({ id: "job_1", status: "RUNNING" });
      prisma.paymentBackfillJob.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.paymentBackfillJob.findUniqueOrThrow.mockResolvedValue({
        ...stored,
        status: PaymentBackfillStatus.RUNNING,
        cancelRequestedAt: new Date(),
        completedAt: null,
      });

      await expect(service.cancelJob(ADMIN, "job_1")).resolves.toMatchObject({
        status: PaymentBackfillStatus.RUNNING,
        cancelRequested: true,
      });
      expect(prisma.paymentBackfillJob.updateMany.mock.calls[1][0]).toEqual({
        where: { id: "job_1", status: PaymentBackfillStatus.RUNNING, cancelRequestedAt: null },
        data: { cancelRequestedAt: expect.any(Date) },
      });
    });

    it("refuses to cancel a finished job", async () => {
      const { service, prisma } = operatorHarness();
      prisma.paymentBackfillJob.findUnique.mockResolvedValue({ id: "job_1", status: "COMPLETED" });

      await expectCode(service.cancelJob(ADMIN, "job_1"), ConflictException, ApiErrorCode.CONFLICT);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("returns not-found for an unknown job", async () => {
      const { service, prisma } = operatorHarness();
      prisma.paymentBackfillJob.findUnique.mockResolvedValue(null);

      await expectCode(service.cancelJob(ADMIN, "nope"), NotFoundException, ApiErrorCode.NOT_FOUND);
    });
  });
});
