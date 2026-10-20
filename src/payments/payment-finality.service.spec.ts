import { ConfigService } from "@nestjs/config";
import { PaymentClassification, Prisma } from "@prisma/client";
import { HorizonClient } from "../stellar/horizon-client";
import {
  HorizonHttpResponse,
  HorizonRequest,
  HorizonTransport,
} from "../stellar/horizon-transport";
import { StellarService } from "../stellar/stellar.service";
import { PaymentFinalityService } from "./payment-finality.service";
import { PaymentsService } from "./payments.service";

/**
 * Checkpoint finality, end to end.
 *
 * The real sync, finality, Stellar and Horizon-client code runs against two
 * doubles: a simulated ledger that answers Horizon's payments, ledger and
 * operation endpoints, and an in-memory Prisma that evaluates the where
 * clauses the services issue. Reorganisations are scripted by editing the
 * simulated ledger between syncs, so every scenario is deterministic.
 */

const HORIZON = "https://horizon.synthetic.invalid";
const ACCOUNT = "GSYNTHETIC0RECEIVER0000000000000000000000000000000000000";
const OTHER_ACCOUNT = "GSYNTHETIC0OTHER000000000000000000000000000000000000000";
const SENDER = "GSYNTHETIC0SENDER000000000000000000000000000000000000000";
const USER = { id: "user_1", walletAddress: ACCOUNT };

function toid(ledger: number, tx = 1, op = 1): string {
  return ((BigInt(ledger) << BigInt(32)) | (BigInt(tx) << BigInt(12)) | BigInt(op)).toString();
}

function ledgerHash(ledger: number, fork = 0): string {
  return `${fork.toString(16).padStart(8, "0")}${ledger.toString(16).padStart(56, "0")}`;
}

// ---------------------------------------------------------------------------
// Simulated Horizon
// ---------------------------------------------------------------------------

interface WorldRecord {
  id: string;
  paging_token: string;
  type: "payment";
  transaction_hash: string;
  created_at: string;
  from: string;
  to: string;
  asset_type: "native";
  amount: string;
}

class SimulatedLedger implements HorizonTransport {
  readonly records: WorldRecord[] = [];
  readonly ledgers = new Map<number, string>();
  readonly requests: string[] = [];
  /** Serve every payments page with its records reversed. */
  reorderPages = false;

  addPayment(ledger: number, tx = 1, to = ACCOUNT): WorldRecord {
    const token = toid(ledger, tx);
    const record: WorldRecord = {
      id: token,
      paging_token: token,
      type: "payment",
      transaction_hash: `tx-${ledger}-${tx}`,
      created_at: new Date(Date.UTC(2026, 0, 1) + ledger * 5_000).toISOString(),
      from: SENDER,
      to,
      asset_type: "native",
      amount: "10.0000000",
    };
    this.records.push(record);
    if (!this.ledgers.has(ledger)) this.ledgers.set(ledger, ledgerHash(ledger));
    return record;
  }

  /** Replaces a ledger: new hash, and each of its operations now in a new transaction. */
  replaceLedger(ledger: number) {
    this.ledgers.set(ledger, ledgerHash(ledger, 1));
    for (const record of this.records) {
      if (BigInt(record.paging_token) >> BigInt(32) === BigInt(ledger)) {
        record.transaction_hash = `${record.transaction_hash}-fork`;
      }
    }
  }

  /** Drops an operation from the ledger view, as a reorganisation would. */
  removePayment(ledger: number, tx = 1) {
    const index = this.records.findIndex((record) => record.id === toid(ledger, tx));
    this.records.splice(index, 1);
  }

  async get(request: HorizonRequest): Promise<HorizonHttpResponse> {
    const url = new URL(request.url);
    this.requests.push(`${url.pathname}${url.search}`);

    const ledgerMatch = /^\/ledgers\/(\d+)$/.exec(url.pathname);
    if (ledgerMatch) {
      const sequence = Number(ledgerMatch[1]);
      const hash = this.ledgers.get(sequence);
      return hash ? ok({ sequence, hash }) : notFound();
    }

    const operationMatch = /^\/operations\/(.+)$/.exec(url.pathname);
    if (operationMatch) {
      const record = this.records.find((r) => r.id === decodeURIComponent(operationMatch[1]));
      return record
        ? ok({ id: record.id, paging_token: record.paging_token, transaction_hash: record.transaction_hash })
        : notFound();
    }

    if (url.pathname.endsWith("/payments")) {
      const order = url.searchParams.get("order") ?? "asc";
      const cursor = url.searchParams.get("cursor");
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const sorted = [...this.records].sort((a, b) =>
        compare(BigInt(a.paging_token), BigInt(b.paging_token)) * (order === "asc" ? 1 : -1),
      );
      const after = cursor
        ? sorted.filter((r) =>
            order === "asc"
              ? BigInt(r.paging_token) > BigInt(cursor)
              : BigInt(r.paging_token) < BigInt(cursor),
          )
        : sorted;
      const page = after.slice(0, limit);
      const next = page.length > 0 ? page[page.length - 1].paging_token : cursor;
      return ok({
        _embedded: { records: this.reorderPages ? [...page].reverse() : page },
        _links: { next: { href: `${HORIZON}/accounts/x/payments?cursor=${next ?? ""}` } },
      });
    }

    return notFound();
  }

  paymentReads(): string[] {
    return this.requests.filter((request) => request.includes("/payments"));
  }
}

/** Rows without `updatedAt`, which every write touches. */
function withoutTimestamps(rows: Row[]): Row[] {
  return rows.map((row) => {
    const copy = { ...row };
    delete copy.updatedAt;
    return copy;
  });
}

function compare(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ok(body: unknown): HorizonHttpResponse {
  return { status: 200, body, headers: {} };
}

function notFound(): HorizonHttpResponse {
  return { status: 404, body: {}, headers: {} };
}

// ---------------------------------------------------------------------------
// In-memory Prisma
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some((c) => matches(row, c));
    if (key === "NOT") return !matches(row, condition as Row);
    const value = row[key] ?? null;
    if (condition === null) return value === null;
    if (typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as Row;
      if ("gte" in c && !(value !== null && (value as number) >= (c.gte as number))) return false;
      if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
      if ("notIn" in c && (value === null || (c.notIn as unknown[]).includes(value))) return false;
      if ("not" in c) {
        if (c.not === null ? value === null : value === null || value === c.not) return false;
      }
      return true;
    }
    return value === condition;
  });
}

function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in (value as Row)) {
      row[key] = (row[key] as number) + ((value as Row).increment as number);
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = new Date();
}

function pick(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key] ?? null]));
}

class MemoryPrisma {
  readonly payments: Row[] = [];
  readonly checkpoints: Row[] = [];
  readonly audits: Row[] = [];
  private sequence = 0;

  supportedAsset = {
    findMany: async () => [{ code: "XLM", issuer: null, network: "testnet" }],
  };

  payment = {
    findMany: async ({ where, select }: { where?: Row; select?: Row }) =>
      this.payments.filter((row) => matches(row, where)).map((row) => pick(row, select)),
    findFirst: async ({
      where,
      orderBy,
      select,
    }: {
      where?: Row;
      orderBy?: Record<string, "asc" | "desc">;
      select?: Row;
    }) => {
      const rows = this.payments.filter((row) => matches(row, where));
      if (orderBy) {
        const [[key, direction]] = Object.entries(orderBy);
        rows.sort((a, b) => ((a[key] as number) - (b[key] as number)) * (direction === "asc" ? 1 : -1));
      }
      return rows[0] ? pick(rows[0], select) : null;
    },
    upsert: async ({ where, update, create }: { where: Row; update: Row; create: Row }) => {
      const existing = this.payments.find((row) => row.operationId === where.operationId);
      if (existing) {
        apply(existing, update);
        return existing;
      }
      const row: Row = {
        id: `payment_${++this.sequence}`,
        finalityHoldAt: null,
        finalityHoldReason: null,
        createdAt: new Date(),
        ...create,
      };
      this.payments.push(row);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = this.payments.filter((row) => matches(row, where));
      rows.forEach((row) => apply(row, data));
      return { count: rows.length };
    },
    count: async ({ where }: { where: Row }) =>
      this.payments.filter((row) => matches(row, where)).length,
  };

  paymentSyncCheckpoint = {
    findUnique: async ({ where }: { where: Row }) => {
      const row = this.checkpoints.find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Row }) => {
      if (this.checkpoints.some((r) => r.userId === data.userId)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        });
      }
      const row: Row = {
        id: `checkpoint_${++this.sequence}`,
        status: "VERIFIED",
        divergenceReason: null,
        divergedAt: null,
        reconciliationCursor: null,
        version: 0,
        ...data,
      };
      this.checkpoints.push(row);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = this.checkpoints.filter((row) => matches(row, where));
      rows.forEach((row) => apply(row, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const before = this.checkpoints.length;
      const keep = this.checkpoints.filter((row) => !matches(row, where));
      this.checkpoints.splice(0, this.checkpoints.length, ...keep);
      return { count: before - keep.length };
    },
  };

  auditLog = {
    create: async ({ data }: { data: Row }) => {
      this.audits.push(data);
      return data;
    },
  };

  $transaction = async <T>(fn: (tx: this) => Promise<T>) => fn(this);

  checkpoint(): Row {
    return this.checkpoints.find((row) => row.userId === USER.id) as Row;
  }

  paymentAt(ledger: number, tx = 1): Row {
    return this.payments.find((row) => row.operationId === toid(ledger, tx)) as Row;
  }

  held(): string[] {
    return this.payments
      .filter((row) => row.finalityHoldAt !== null)
      .map((row) => row.operationId as string)
      .sort();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const baseConfig = {
  getOrThrow: jest.fn((key: string) => {
    const values: Record<string, string> = {
      paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      "stellar.horizonUrl": HORIZON,
    };
    return values[key];
  }),
} as unknown as ConfigService;

function harness(settings: { historyLedgers?: number; reconciliationMaxPages?: number } = {}) {
  const world = new SimulatedLedger();
  const prisma = new MemoryPrisma();
  const horizon = new HorizonClient({ horizonUrl: HORIZON, transport: world, sleep: async () => undefined });
  const stellar = new StellarService(baseConfig, horizon);
  const finalityConfig = {
    get: (key: string) =>
      ({
        "stellar.finality.historyLedgers": settings.historyLedgers,
        "stellar.finality.reconciliationMaxPages": settings.reconciliationMaxPages,
      })[key],
  } as unknown as ConfigService;
  const finality = new PaymentFinalityService(prisma as never, stellar, finalityConfig);
  const service = new PaymentsService(prisma as never, stellar, baseConfig, finality);
  return { world, prisma, finality, service, sync: (user = USER) => service.syncPayments(user) };
}

const originalFetch = global.fetch;
beforeEach(() => {
  // Memo enrichment reads transactions through global fetch; it is not under
  // test here, so every transaction has no memo.
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ memo_type: "none" }),
  }) as never;
});
afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Establishing and resuming
// ---------------------------------------------------------------------------

describe("checkpoint establishment", () => {
  it("anchors the first checkpoint to the newest record and its ledger hash", async () => {
    const { world, prisma, sync } = harness();
    [100, 101, 102].forEach((ledger) => world.addPayment(ledger));

    const result = await sync();

    expect(result.finality).toEqual({ status: "verified", heldPayments: 0, orphanedPayments: 0 });
    expect(prisma.checkpoint()).toMatchObject({
      status: "VERIFIED",
      pagingToken: toid(102),
      operationId: toid(102),
      transactionHash: "tx-102-1",
      ledgerSequence: 102,
      ledgerHash: ledgerHash(102),
    });
    expect(prisma.paymentAt(101)).toMatchObject({ pagingToken: toid(101), ledgerSequence: 101 });
  });

  it("stays unverified, without failing the sync, when the anchor ledger cannot be read", async () => {
    const { world, prisma, sync } = harness();
    world.addPayment(100);
    world.ledgers.delete(100);

    const result = await sync();

    expect(result.created).toBe(1);
    expect(result.finality.status).toBe("unverified");
    expect(prisma.checkpoints).toHaveLength(0);
  });

  it("establishes nothing for a wallet with no payments", async () => {
    const { prisma, sync } = harness();
    const result = await sync();
    expect(result.finality.status).toBe("unverified");
    expect(prisma.checkpoints).toHaveLength(0);
  });
});

describe("normal restarts", () => {
  it("verifies the checkpoint before reading, then resumes forward from it", async () => {
    const { world, prisma, sync } = harness();
    [100, 101].forEach((ledger) => world.addPayment(ledger));
    await sync();
    world.requests.length = 0;
    [102, 103].forEach((ledger) => world.addPayment(ledger));

    const result = await sync();

    // The checkpoint's ledger and operation are proved first; only then is
    // the payments feed read, forward from the checkpoint.
    expect(world.requests[0]).toBe("/ledgers/101");
    expect(world.requests[1]).toBe(`/operations/${toid(101)}`);
    const [firstRead] = world.paymentReads();
    expect(firstRead).toContain("order=asc");
    expect(firstRead).toContain(`cursor=${toid(101)}`);

    expect(result).toMatchObject({ totalFetched: 2, created: 2, updated: 0 });
    expect(result.finality.status).toBe("verified");
    expect(prisma.checkpoint()).toMatchObject({ pagingToken: toid(103), ledgerSequence: 103 });
  });

  it("leaves the checkpoint in place when nothing new arrived", async () => {
    const { world, prisma, sync } = harness();
    world.addPayment(100);
    await sync();

    const result = await sync();

    expect(result).toMatchObject({ totalFetched: 0, created: 0 });
    expect(result.finality.status).toBe("verified");
    expect(prisma.checkpoint()).toMatchObject({ pagingToken: toid(100), status: "VERIFIED" });
  });

  it("does not move a checkpoint a concurrent sync already advanced", async () => {
    const { world, prisma, sync } = harness();
    world.addPayment(100);
    await sync();
    world.addPayment(101);

    // Two syncs of the same wallet race; both verify the same checkpoint
    // version, and only one may advance it.
    const [a, b] = await Promise.all([sync(), sync()]);

    expect([a.finality.status, b.finality.status].sort()).toEqual(["unverified", "verified"]);
    expect(prisma.checkpoint()).toMatchObject({ pagingToken: toid(101), version: 1 });
    expect(prisma.payments.filter((row) => row.operationId === toid(101))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Divergence
// ---------------------------------------------------------------------------

describe("replaced ledger responses", () => {
  it("detects a replaced checkpoint ledger and reconciles affected payments", async () => {
    const { world, prisma, sync } = harness();
    [100, 101, 102].forEach((ledger) => world.addPayment(ledger));
    await sync();
    prisma.paymentAt(102).classification = PaymentClassification.INCOME;

    world.replaceLedger(102);
    world.requests.length = 0;
    const result = await sync();

    // Divergence was found before any page was read.
    expect(world.requests.slice(0, 2)).toEqual(["/ledgers/102", `/operations/${toid(102)}`]);
    expect(world.paymentReads()[0]).toContain("order=desc");

    // The replaced payment was rebuilt from the new view, and the owner's
    // classification — which described the old payment — was reset.
    expect(prisma.paymentAt(102)).toMatchObject({
      stellarTransactionHash: "tx-102-1-fork",
      classification: PaymentClassification.UNKNOWN,
      finalityHoldAt: null,
    });
    expect(result.finality).toEqual({ status: "verified", heldPayments: 0, orphanedPayments: 0 });
    expect(prisma.checkpoint()).toMatchObject({
      status: "VERIFIED",
      ledgerHash: ledgerHash(102, 1),
      transactionHash: "tx-102-1-fork",
      divergenceReason: null,
    });
    expect(prisma.audits.map((audit) => audit.action)).toEqual([
      "payment.ledger.diverged",
      "payment.ledger.reconciled",
    ]);
  });

  it("treats a stored operation that now names another transaction as a divergence", async () => {
    const { world, prisma, sync } = harness();
    world.addPayment(100);
    await sync();
    // An operation already stored (from an earlier, pre-checkpoint sync)
    // arrives in the forward read with a different transaction.
    const incoming = world.addPayment(101);
    await prisma.payment.upsert({
      where: { operationId: incoming.id },
      update: {},
      create: {
        userId: USER.id,
        operationId: incoming.id,
        stellarTransactionHash: "tx-stale",
        ledgerSequence: 101,
        isEligible: true,
        classification: PaymentClassification.INCOME,
      },
    });

    const result = await sync();

    expect(prisma.audits[0]).toMatchObject({
      action: "payment.ledger.diverged",
      metadata: expect.objectContaining({ reason: "record_replaced" }),
    });
    expect(prisma.paymentAt(101)).toMatchObject({
      stellarTransactionHash: incoming.transaction_hash,
      classification: PaymentClassification.UNKNOWN,
      finalityHoldAt: null,
    });
    expect(result.finality.status).toBe("verified");
  });

  it("reassigns an operation position that now pays a different wallet owner", async () => {
    const { world, prisma, sync } = harness();
    world.addPayment(100);
    await sync();
    const incoming = world.addPayment(101);
    prisma.payments.push({
      id: "foreign",
      userId: "user_2",
      operationId: incoming.id,
      stellarTransactionHash: incoming.transaction_hash,
      ledgerSequence: 101,
      finalityHoldAt: null,
      isEligible: true,
      classification: PaymentClassification.INCOME,
    });

    await sync();

    expect(prisma.paymentAt(101)).toMatchObject({
      userId: USER.id,
      classification: PaymentClassification.UNKNOWN,
    });
  });
});

describe("missing ledger responses", () => {
  it("orphans a payment the reconciled ledger no longer contains", async () => {
    const { world, prisma, sync } = harness();
    [100, 101, 102].forEach((ledger) => world.addPayment(ledger));
    await sync();

    world.removePayment(102);
    const result = await sync();

    expect(prisma.audits[0]).toMatchObject({
      metadata: expect.objectContaining({ reason: "checkpoint_record_missing" }),
    });
    expect(prisma.paymentAt(102)).toMatchObject({
      isEligible: false,
      finalityHoldReason: "orphaned",
    });
    expect(prisma.paymentAt(102).finalityHoldAt).not.toBeNull();
    expect(prisma.held()).toEqual([toid(102)]);
    expect(result.finality).toEqual({ status: "verified", heldPayments: 1, orphanedPayments: 1 });
    // The checkpoint re-anchors to the newest payment that still exists.
    expect(prisma.checkpoint()).toMatchObject({ pagingToken: toid(101), status: "VERIFIED" });
  });

  it("detects a checkpoint ledger Horizon no longer has", async () => {
    const { world, prisma, sync } = harness();
    world.addPayment(100);
    await sync();

    world.ledgers.delete(100);
    world.removePayment(100);
    const result = await sync();

    expect(prisma.audits[0]).toMatchObject({
      metadata: expect.objectContaining({ reason: "ledger_missing" }),
    });
    // Nothing confirmed remains to anchor to; the next sync starts afresh.
    expect(prisma.checkpoints).toHaveLength(0);
    expect(result.finality.orphanedPayments).toBe(1);
  });

  it("releases an orphaned payment if a later consistent view contains it again", async () => {
    const { world, prisma, sync } = harness();
    [100, 101].forEach((ledger) => world.addPayment(ledger));
    await sync();
    const removed = world.records.find((r) => r.id === toid(101)) as WorldRecord;
    world.removePayment(101);
    await sync();
    expect(prisma.paymentAt(101).finalityHoldReason).toBe("orphaned");

    world.records.push(removed);
    world.replaceLedger(100);
    await sync();

    expect(prisma.paymentAt(101)).toMatchObject({
      finalityHoldAt: null,
      finalityHoldReason: null,
      isEligible: true,
    });
  });
});

describe("reordered ledger responses", () => {
  it("writes nothing from a reordered forward read and holds the window", async () => {
    const { world, prisma, sync } = harness();
    [100, 101].forEach((ledger) => world.addPayment(ledger));
    await sync();
    [102, 103].forEach((ledger) => world.addPayment(ledger));
    world.reorderPages = true;

    const result = await sync();

    expect(result).toMatchObject({ created: 0, updated: 0 });
    expect(result.finality).toMatchObject({ status: "diverged", reason: "out_of_order" });
    expect(prisma.payments).toHaveLength(2);
    expect(prisma.held()).toEqual([toid(100), toid(101)]);
    expect(prisma.checkpoint()).toMatchObject({ status: "DIVERGED", divergenceReason: "out_of_order" });
  });

  it("recovers once Horizon serves a consistent view again", async () => {
    const { world, prisma, sync } = harness();
    [100, 101].forEach((ledger) => world.addPayment(ledger));
    await sync();
    [102, 103].forEach((ledger) => world.addPayment(ledger));
    world.reorderPages = true;
    await sync();

    world.reorderPages = false;
    const result = await sync();

    expect(result.finality).toEqual({ status: "verified", heldPayments: 0, orphanedPayments: 0 });
    expect(prisma.payments).toHaveLength(4);
    expect(prisma.checkpoint()).toMatchObject({ status: "VERIFIED", pagingToken: toid(103) });
  });
});

// ---------------------------------------------------------------------------
// Recovery properties
// ---------------------------------------------------------------------------

describe("recovery", () => {
  it("is idempotent while the view stays inconsistent", async () => {
    const { world, prisma, sync } = harness();
    [100, 101].forEach((ledger) => world.addPayment(ledger));
    await sync();
    [102, 103].forEach((ledger) => world.addPayment(ledger));
    world.reorderPages = true;

    await sync();
    const heldAfterFirst = prisma.held();
    expect(heldAfterFirst).toEqual([toid(100), toid(101)]);
    const holdTimes = prisma.payments.map((row) => row.finalityHoldAt);
    await sync();
    await sync();

    expect(prisma.held()).toEqual(heldAfterFirst);
    expect(prisma.payments.map((row) => row.finalityHoldAt)).toEqual(holdTimes);
    expect(prisma.audits.filter((a) => a.action === "payment.ledger.diverged")).toHaveLength(1);
  });

  it("places no holds from stale evidence once a concurrent sync re-verified the checkpoint", async () => {
    const { world, prisma, finality, sync } = harness();
    [100, 101].forEach((ledger) => world.addPayment(ledger));
    await sync();
    const stale = { ...prisma.checkpoint() };
    // Another sync diverged and fully reconciled meanwhile: same anchor,
    // newer version, VERIFIED again.
    prisma.checkpoint().version = 2;

    const plan = await finality.diverge(USER.id, stale as never, "out_of_order");

    expect(plan.mode).toBe("resume");
    expect(prisma.held()).toEqual([]);
    expect(prisma.audits).toHaveLength(0);
    expect(prisma.checkpoint()).toMatchObject({ status: "VERIFIED", version: 2 });
  });

  it("is idempotent once reconciled", async () => {
    const { world, prisma, sync } = harness();
    [100, 101].forEach((ledger) => world.addPayment(ledger));
    await sync();
    world.replaceLedger(101);
    await sync();
    const snapshot = JSON.stringify(withoutTimestamps(prisma.payments));

    const result = await sync();

    expect(result.finality.status).toBe("verified");
    expect(JSON.stringify(withoutTimestamps(prisma.payments))).toBe(snapshot);
    expect(prisma.audits.filter((a) => a.action === "payment.ledger.reconciled")).toHaveLength(1);
  });

  it("never holds or orphans payments older than the configured history window", async () => {
    const { world, prisma, sync } = harness({ historyLedgers: 10 });
    [50, 95, 100].forEach((ledger) => world.addPayment(ledger));
    await sync();

    // Ledger 50 is beyond the window (floor = 100 - 10 = 90): even though it
    // disappears too, it is final and untouched.
    world.removePayment(50);
    world.replaceLedger(100);
    const result = await sync();

    expect(prisma.paymentAt(50)).toMatchObject({ finalityHoldAt: null, isEligible: true });
    expect(prisma.audits[0]).toMatchObject({
      metadata: expect.objectContaining({ floorLedger: 90, heldPayments: 2 }),
    });
    expect(world.paymentReads().at(-1)).toContain("order=desc");
    expect(result.finality.status).toBe("verified");
  });

  it("continues a reconciliation deeper than one read on the next sync", async () => {
    const { world, prisma, sync } = harness({ reconciliationMaxPages: 1 });
    // 250 payments: more than one 200-record page.
    for (let ledger = 1_000; ledger < 1_250; ledger += 1) world.addPayment(ledger);
    await sync();
    expect(prisma.checkpoint()).toMatchObject({ pagingToken: toid(1_249) });

    world.removePayment(1_010);
    world.replaceLedger(1_249);

    const first = await sync();
    expect(first.finality.status).toBe("reconciling");
    expect(prisma.checkpoint()).toMatchObject({
      status: "DIVERGED",
      reconciliationCursor: toid(1_050),
    });
    // The first read proved ledgers above 1050; everything at or below it is
    // still held, and nothing has been orphaned yet.
    expect(prisma.paymentAt(1_100).finalityHoldAt).toBeNull();
    expect(prisma.paymentAt(1_020).finalityHoldAt).not.toBeNull();
    expect(prisma.paymentAt(1_010).finalityHoldReason).toBe("ledger_hash_mismatch");

    const second = await sync();
    const [continued] = world.paymentReads().slice(-1);
    expect(continued).toContain(`cursor=${toid(1_050)}`);
    expect(second.finality).toEqual({ status: "verified", heldPayments: 1, orphanedPayments: 1 });
    expect(prisma.paymentAt(1_010).finalityHoldReason).toBe("orphaned");
    expect(prisma.checkpoint()).toMatchObject({
      status: "VERIFIED",
      pagingToken: toid(1_249),
      ledgerHash: ledgerHash(1_249, 1),
      reconciliationCursor: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe("ownership", () => {
  it("holds only the diverged wallet's payments", async () => {
    const { world, prisma, sync } = harness();
    world.addPayment(100);
    await sync();
    prisma.payments.push({
      id: "other_user_payment",
      userId: "user_2",
      operationId: toid(100, 9),
      stellarTransactionHash: "tx-other",
      ledgerSequence: 100,
      finalityHoldAt: null,
      isEligible: true,
    });

    world.addPayment(101);
    world.reorderPages = true;
    world.addPayment(102);
    await sync();

    expect(prisma.payments.find((row) => row.id === "other_user_payment")).toMatchObject({
      finalityHoldAt: null,
    });
  });

  it("keeps audit metadata free of addresses, amounts and transaction hashes", async () => {
    const { world, prisma, sync } = harness();
    world.addPayment(100, 1, ACCOUNT);
    world.addPayment(100, 2, OTHER_ACCOUNT);
    await sync();
    world.replaceLedger(100);
    await sync();

    const serialized = JSON.stringify(prisma.audits);
    expect(serialized).not.toContain(ACCOUNT);
    expect(serialized).not.toContain(SENDER);
    expect(serialized).not.toContain("tx-100");
    expect(serialized).not.toContain("10.0000000");
  });
});
