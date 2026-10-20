import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { IssuerAddressRotationStatus, Prisma, ResourceStatus } from "@prisma/client";
import { Keypair } from "@stellar/stellar-base";
import { FixedClock } from "../../test/time/fixed-clock";
import { AuthenticatedUser } from "../auth/auth.types";
import {
  BASE_RETRY_DELAY_MS,
  IssuerAddressRotationService,
  MAX_ROTATION_ATTEMPTS,
  ROTATION_LEASE_MS,
  RotationErrorCode,
} from "./issuer-address-rotation.service";
import {
  IssuerRegistryAddressRead,
  IssuerRegistryRotationResult,
} from "./issuer-registry.service";

const ADMIN: AuthenticatedUser = {
  id: "user_admin",
  walletAddress: "GADMIN",
  walletHash: `sha256:${"a".repeat(64)}`,
  role: "ADMIN",
};

const address = (seed: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();
const CURRENT = address(41);
const TARGET = address(42);
const OTHER = address(43);

type Row = Record<string, unknown>;

/**
 * In-memory tables with the semantics the service depends on: conditional
 * `updateMany` is atomic, the unique indexes are enforced (raising P2002 like
 * PostgreSQL), and `$transaction` restores every table when it throws.
 */
class Store {
  issuers: Row[] = [];
  rotations: Row[] = [];
  history: Row[] = [];
  audit: Row[] = [];
  failAudit = false;
  private seq = 0;

  private matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, condition]) => {
      if (key === "OR") {
        return (condition as Row[]).some((branch) => this.matches(row, branch));
      }
      const value = row[key];
      if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
        const c = condition as { in?: unknown[]; lt?: Date; lte?: Date; not?: unknown };
        if ("in" in c) return c.in!.includes(value);
        if ("lt" in c) return value instanceof Date && value < c.lt!;
        if ("lte" in c) return value instanceof Date && value <= c.lte!;
        if ("not" in c) return value !== c.not;
      }
      return value === condition;
    });
  }

  private apply(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in (value as Row)) {
        row[key] = (row[key] as number) + ((value as { increment: number }).increment);
      } else {
        row[key] = value;
      }
    }
  }

  private unique(rows: Row[], row: Row, fields: string[]) {
    for (const field of fields) {
      if (row[field] == null) continue;
      if (rows.some((other) => other !== row && other[field] === row[field])) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: [field] },
        });
      }
    }
  }

  private table(rows: Row[], uniques: string[] = [], defaults: () => Row = () => ({})) {
    const find = (where: Row) => rows.find((row) => this.matches(row, where)) ?? null;
    return {
      findUnique: async ({ where }: { where: Row }) => find(where),
      findUniqueOrThrow: async ({ where }: { where: Row }) => {
        const row = find(where);
        if (!row) throw new Error("not found");
        return row;
      },
      findFirst: async ({ where }: { where: Row }) => find(where),
      findMany: async ({ where, take }: { where?: Row; take?: number }) =>
        rows.filter((row) => this.matches(row, where)).slice(0, take ?? rows.length),
      create: async ({ data }: { data: Row }) => {
        const row = { ...defaults(), ...data };
        rows.push(row);
        try {
          this.unique(rows, row, uniques);
        } catch (error) {
          rows.pop();
          throw error;
        }
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = find(where);
        if (!row) throw new Error("record not found");
        this.apply(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = rows.filter((row) => this.matches(row, where));
        const before = hit.map((row) => ({ ...row }));
        hit.forEach((row) => this.apply(row, data));
        try {
          hit.forEach((row) => this.unique(rows, row, uniques));
        } catch (error) {
          hit.forEach((row, index) => Object.assign(row, before[index]));
          throw error;
        }
        return { count: hit.length };
      },
    };
  }

  client(): Record<string, unknown> {
    return {
      issuer: this.table(this.issuers, ["stellarAddress"]),
      issuerAddressRotation: this.table(this.rotations, ["openIssuerKey", "openTargetKey"], () => ({
        id: `rotation_${++this.seq}`,
        status: IssuerAddressRotationStatus.PENDING,
        attemptCount: 0,
        lastAttemptAt: null,
        leaseExpiresAt: null,
        transactionHash: null,
        lastError: null,
        confirmedAt: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      })),
      issuerAddressHistory: this.table(this.history, ["rotationId"]),
      auditLog: {
        create: async ({ data }: { data: Row }) => {
          if (this.failAudit) throw new Error("audit store unavailable");
          this.audit.push(data);
          return data;
        },
      },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        const tables = [this.issuers, this.rotations, this.history, this.audit];
        const snapshot = tables.map((rows) => rows.map((row) => ({ ...row })));
        try {
          return await run(this.client());
        } catch (error) {
          tables.forEach((rows, index) => rows.splice(0, rows.length, ...snapshot[index]));
          throw error;
        }
      },
    };
  }
}

/**
 * The issuer registry contract, simulated with the same rules as
 * `rotate_issuer_address`: revoked issuers, unchanged addresses and addresses
 * already registered to any issuer are rejected.
 */
class FakeContract {
  addresses = new Map<string, string>();
  revoked = new Set<string>();
  isConfigured = true;
  readFails = false;
  /** Apply the rotation, then report failure: a timeout after the ledger closed. */
  timeoutAfterApplying = false;
  /** Report success without applying: not yet visible when read back. */
  submitWithoutApplying = false;
  submissions = 0;

  async readIssuerAddress(issuerId: string): Promise<IssuerRegistryAddressRead> {
    if (this.readFails) return { state: "failed", error: "unreachable" };
    const current = this.addresses.get(issuerId);
    return current
      ? { state: "found", issuerAddress: current }
      : { state: "failed", error: "IssuerNotFound" };
  }

  async rotateIssuerAddress(issuerId: string, newAddress: string): Promise<IssuerRegistryRotationResult> {
    this.submissions += 1;
    const current = this.addresses.get(issuerId);
    if (!current || this.revoked.has(issuerId) || current === newAddress) {
      return { state: "failed", error: "contract rejected" };
    }
    if ([...this.addresses.values()].includes(newAddress)) {
      return { state: "failed", error: "IssuerAddressAlreadyRegistered" };
    }
    if (this.submitWithoutApplying) {
      return { state: "submitted", transactionHash: "f".repeat(64) };
    }
    this.addresses.set(issuerId, newAddress);
    if (this.timeoutAfterApplying) {
      return { state: "failed", error: "timed out" };
    }
    return { state: "submitted", transactionHash: "b".repeat(64) };
  }
}

function setup(issuerOverrides: Row = {}) {
  const store = new Store();
  const contract = new FakeContract();
  const clock = new FixedClock("2026-06-01T00:00:00.000Z");
  store.issuers.push({
    id: "issuer_1",
    organizationId: "org_1",
    stellarAddress: CURRENT,
    status: ResourceStatus.ACTIVE,
    contractSyncedStatus: ResourceStatus.ACTIVE,
    revision: 3,
    ...issuerOverrides,
  });
  contract.addresses.set("issuer_1", CURRENT);
  const service = new IssuerAddressRotationService(store.client() as never, contract as never, clock);
  const issuer = () => store.issuers[0];
  const request = (overrides: Partial<{ newStellarAddress: string; expectedRevision: number }> = {}) =>
    service.requestRotation(ADMIN, "issuer_1", {
      newStellarAddress: TARGET,
      expectedRevision: 3,
      ...overrides,
    });
  return { store, contract, clock, service, issuer, request };
}

function expectIssuerUnchanged(ctx: ReturnType<typeof setup>) {
  expect(ctx.issuer().stellarAddress).toBe(CURRENT);
  expect(ctx.store.history).toHaveLength(0);
}

describe("IssuerAddressRotationService", () => {
  describe("successful rotation", () => {
    it("submits, confirms against the contract, then adopts the address", async () => {
      const ctx = setup();

      const view = await ctx.request();

      expect(view).toMatchObject({
        status: IssuerAddressRotationStatus.CONFIRMED,
        fromAddress: CURRENT,
        toAddress: TARGET,
        transactionHash: "b".repeat(64),
        attemptCount: 1,
      });
      expect(ctx.issuer()).toMatchObject({ stellarAddress: TARGET, revision: 5 });
      expect(ctx.contract.addresses.get("issuer_1")).toBe(TARGET);
      expect(ctx.contract.submissions).toBe(1);
    });

    it("preserves the retired address in history", async () => {
      const ctx = setup();

      const view = await ctx.request();

      expect(ctx.store.history).toEqual([
        {
          issuerId: "issuer_1",
          stellarAddress: CURRENT,
          retiredAt: ctx.clock.now(),
          rotationId: view.id,
          transactionHash: "b".repeat(64),
        },
      ]);
    });

    it("closes the rotation so the issuer and target are free again", async () => {
      const ctx = setup();

      await ctx.request();

      expect(ctx.store.rotations[0]).toMatchObject({
        openIssuerKey: null,
        openTargetKey: null,
        leaseExpiresAt: null,
      });
    });

    it("audits the request and the confirmation with public addresses and organization", async () => {
      const ctx = setup();

      const view = await ctx.request();

      expect(ctx.store.audit.map((row) => [row.action, row.actorType, row.actorId])).toEqual([
        ["issuer.address_rotation.requested", "user", ADMIN.id],
        ["issuer.address_rotation.confirmed", "user", ADMIN.id],
      ]);
      expect(ctx.store.audit[1]).toMatchObject({
        resourceType: "issuer_address_rotation",
        resourceId: view.id,
        metadata: {
          organizationId: "org_1",
          issuerId: "issuer_1",
          fromAddress: CURRENT,
          toAddress: TARGET,
          transactionHash: "b".repeat(64),
        },
      });
    });
  });

  describe("request validation", () => {
    it.each([
      ["an invalid address", { newStellarAddress: "GNOTANADDRESS" }, BadRequestException],
      ["the current address", { newStellarAddress: CURRENT }, BadRequestException],
      ["a stale revision", { expectedRevision: 2 }, ConflictException],
    ])("rejects %s and changes nothing", async (_label, overrides, type) => {
      const ctx = setup();

      await expect(ctx.request(overrides)).rejects.toBeInstanceOf(type);
      expect(ctx.store.rotations).toHaveLength(0);
      expect(ctx.issuer().revision).toBe(3);
      expect(ctx.contract.submissions).toBe(0);
    });

    it("rejects an unknown issuer", async () => {
      const ctx = setup();

      await expect(
        ctx.service.requestRotation(ADMIN, "missing", { newStellarAddress: TARGET, expectedRevision: 0 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a revoked issuer, which the contract would refuse", async () => {
      const ctx = setup({ status: ResourceStatus.REVOKED });

      await expect(ctx.request()).rejects.toThrow("A revoked issuer's address cannot be rotated");
    });

    it("rejects an issuer the contract has never registered", async () => {
      const ctx = setup({ contractSyncedStatus: null });

      await expect(ctx.request()).rejects.toThrow("not registered in the contract");
    });

    it("rejects a target registered to another issuer (conflicting registration)", async () => {
      const ctx = setup();
      ctx.store.issuers.push({ id: "issuer_2", stellarAddress: TARGET, revision: 0 });

      await expect(ctx.request()).rejects.toThrow("already registered to an issuer");
    });

    it("rejects a target some issuer used to hold", async () => {
      const ctx = setup();
      ctx.store.history.push({ issuerId: "issuer_9", stellarAddress: TARGET, rotationId: "old" });

      await expect(ctx.request()).rejects.toThrow("previously used by an issuer");
    });

    it("refuses when the registry is not configured, since nothing could confirm it", async () => {
      const ctx = setup();
      ctx.contract.isConfigured = false;

      await expect(ctx.request()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(ctx.store.rotations).toHaveLength(0);
    });

    it("allows only one open rotation per issuer", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;
      await ctx.request();

      await expect(ctx.request({ newStellarAddress: OTHER, expectedRevision: 4 })).rejects.toThrow(
        "already in progress",
      );
    });

    it("never lets two issuers rotate onto the same address at once", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;
      ctx.store.issuers.push({
        id: "issuer_2",
        organizationId: "org_1",
        stellarAddress: OTHER,
        status: ResourceStatus.ACTIVE,
        contractSyncedStatus: ResourceStatus.ACTIVE,
        revision: 0,
      });
      await ctx.request();

      await expect(
        ctx.service.requestRotation(ADMIN, "issuer_2", { newStellarAddress: TARGET, expectedRevision: 0 }),
      ).rejects.toThrow("already the target of another rotation");
    });

    it("claims the revision, so a second command from the same view is stale", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;
      await ctx.request();

      expect(ctx.issuer().revision).toBe(4);
    });
  });

  describe("the database never claims an unconfirmed address", () => {
    it("keeps the old address when the submission fails", async () => {
      const ctx = setup();
      ctx.contract.revoked.add("issuer_1");

      const view = await ctx.request();

      expect(view).toMatchObject({
        status: IssuerAddressRotationStatus.PENDING,
        lastError: RotationErrorCode.SUBMISSION_FAILED,
        nextAttemptAt: new Date(ctx.clock.nowMs() + BASE_RETRY_DELAY_MS),
      });
      expectIssuerUnchanged(ctx);
    });

    it("keeps the old address when the submission reports success the contract does not show", async () => {
      const ctx = setup();
      ctx.contract.submitWithoutApplying = true;

      const view = await ctx.request();

      expect(view).toMatchObject({
        status: IssuerAddressRotationStatus.SUBMITTED,
        lastError: RotationErrorCode.CONFIRMATION_PENDING,
        transactionHash: "f".repeat(64),
      });
      expectIssuerUnchanged(ctx);
    });

    it("keeps the old address when the registry cannot be read", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;

      const view = await ctx.request();

      expect(view.lastError).toBe(RotationErrorCode.REGISTRY_READ_FAILED);
      expect(ctx.contract.submissions).toBe(0);
      expectIssuerUnchanged(ctx);
    });

    it("rolls the adoption back when the audit write fails, leaving the rotation open", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;
      const pending = await ctx.request();
      ctx.contract.readFails = false;
      ctx.store.failAudit = true;

      await expect(ctx.service.reconcile(pending.id)).rejects.toThrow("audit store unavailable");

      expectIssuerUnchanged(ctx);
      expect(ctx.store.rotations[0]).toMatchObject({
        status: IssuerAddressRotationStatus.SUBMITTED,
        openIssuerKey: "issuer_1",
        leaseExpiresAt: null,
      });
    });
  });

  describe("idempotent retries", () => {
    it("finalizes without resubmitting when a timed-out submission actually landed", async () => {
      const ctx = setup();
      ctx.contract.timeoutAfterApplying = true;

      const first = await ctx.request();
      expect(first.status).toBe(IssuerAddressRotationStatus.PENDING);
      expectIssuerUnchanged(ctx);

      // Process restart: a new service instance reconciles from stored state.
      ctx.clock.set(first.nextAttemptAt!);
      const restarted = new IssuerAddressRotationService(
        ctx.store.client() as never,
        ctx.contract as never,
        ctx.clock,
      );
      await expect(restarted.reconcileDue()).resolves.toBe(1);

      expect(ctx.issuer().stellarAddress).toBe(TARGET);
      expect(ctx.contract.submissions).toBe(1);
      expect(ctx.store.rotations[0]).toMatchObject({ status: IssuerAddressRotationStatus.CONFIRMED });
    });

    it("confirms on a later pass once a submitted rotation becomes visible", async () => {
      const ctx = setup();
      ctx.contract.submitWithoutApplying = true;
      const submitted = await ctx.request();

      ctx.contract.addresses.set("issuer_1", TARGET);
      const confirmed = await ctx.service.reconcile(submitted.id);

      expect(confirmed.status).toBe(IssuerAddressRotationStatus.CONFIRMED);
      expect(confirmed.transactionHash).toBe("f".repeat(64));
      expect(ctx.issuer().stellarAddress).toBe(TARGET);
    });

    it("does nothing when reconciling a closed rotation again", async () => {
      const ctx = setup();
      const confirmed = await ctx.request();
      const auditBefore = ctx.store.audit.length;

      await expect(ctx.service.reconcile(confirmed.id)).resolves.toMatchObject({
        status: IssuerAddressRotationStatus.CONFIRMED,
      });
      expect(ctx.store.audit).toHaveLength(auditBefore);
      expect(ctx.store.history).toHaveLength(1);
      expect(ctx.contract.submissions).toBe(1);
    });

    it("lets only one of several concurrent reconcilers act, via the lease", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;
      const pending = await ctx.request();
      ctx.contract.readFails = false;

      await Promise.all([
        ctx.service.reconcile(pending.id),
        ctx.service.reconcile(pending.id),
        ctx.service.reconcile(pending.id),
      ]);

      expect(ctx.contract.submissions).toBe(1);
      expect(ctx.store.history).toHaveLength(1);
      expect(ctx.issuer().stellarAddress).toBe(TARGET);
    });

    it("respects a live lease and takes over an expired one", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;
      const pending = await ctx.request();
      ctx.contract.readFails = false;
      ctx.store.rotations[0].leaseExpiresAt = new Date(ctx.clock.nowMs() + ROTATION_LEASE_MS);

      await ctx.service.reconcile(pending.id);
      expect(ctx.contract.submissions).toBe(0);

      ctx.clock.set(ctx.clock.nowMs() + ROTATION_LEASE_MS + 1);
      await ctx.service.reconcile(pending.id);
      expect(ctx.issuer().stellarAddress).toBe(TARGET);
    });

    it("backs off exponentially and fails after the attempt limit", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;
      const pending = await ctx.request();

      for (let attempt = 2; attempt <= MAX_ROTATION_ATTEMPTS; attempt += 1) {
        const before = ctx.clock.nowMs();
        const view = await ctx.service.reconcile(pending.id);
        if (attempt < MAX_ROTATION_ATTEMPTS) {
          expect(view.nextAttemptAt!.getTime() - before).toBe(
            Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), 30 * 60_000),
          );
        } else {
          expect(view).toMatchObject({
            status: IssuerAddressRotationStatus.FAILED,
            lastError: RotationErrorCode.RETRIES_EXHAUSTED,
          });
        }
      }
      expectIssuerUnchanged(ctx);
      expect(ctx.store.audit.at(-1)).toMatchObject({
        action: "issuer.address_rotation.failed",
        actorType: "system",
        actorId: null,
        metadata: expect.objectContaining({ reason: RotationErrorCode.RETRIES_EXHAUSTED }),
      });
    });

    it("only reconciles rotations that are due", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;
      await ctx.request();

      await expect(ctx.service.reconcileDue()).resolves.toBe(0);
      ctx.clock.set(ctx.clock.nowMs() + BASE_RETRY_DELAY_MS);
      await expect(ctx.service.reconcileDue()).resolves.toBe(1);
    });
  });

  describe("conflicts", () => {
    it("fails without touching the issuer when the contract holds a third address", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;
      const pending = await ctx.request();
      ctx.contract.readFails = false;
      ctx.contract.addresses.set("issuer_1", OTHER);

      const view = await ctx.service.reconcile(pending.id);

      expect(view).toMatchObject({
        status: IssuerAddressRotationStatus.FAILED,
        lastError: RotationErrorCode.CONTRACT_ADDRESS_CONFLICT,
      });
      expectIssuerUnchanged(ctx);
      expect(ctx.contract.submissions).toBe(0);
      // The issuer and the target are released for a corrected request.
      expect(ctx.store.rotations[0]).toMatchObject({ openIssuerKey: null, openTargetKey: null });
    });

    it("fails for review when the database cannot follow a confirmed contract change", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;
      const pending = await ctx.request();
      ctx.contract.readFails = false;
      // Another issuer row took the target locally after the request.
      ctx.store.issuers.push({ id: "issuer_2", stellarAddress: TARGET, revision: 0 });

      const view = await ctx.service.reconcile(pending.id);

      expect(view).toMatchObject({
        status: IssuerAddressRotationStatus.FAILED,
        lastError: RotationErrorCode.DATABASE_ADDRESS_CONFLICT,
      });
      expectIssuerUnchanged(ctx);
    });

    it("fails for review when the issuer's local address changed underneath the rotation", async () => {
      const ctx = setup();
      ctx.contract.readFails = true;
      const pending = await ctx.request();
      ctx.contract.readFails = false;
      ctx.issuer().stellarAddress = OTHER;

      const view = await ctx.service.reconcile(pending.id);

      expect(view.lastError).toBe(RotationErrorCode.DATABASE_ADDRESS_CONFLICT);
      expect(ctx.store.history).toHaveLength(0);
    });
  });

  describe("listing and manual reconcile", () => {
    it("lists rotations and retired addresses for an issuer", async () => {
      const ctx = setup();
      const view = await ctx.request();

      await expect(ctx.service.listForIssuer("issuer_1")).resolves.toMatchObject({
        rotations: [{ id: view.id, status: IssuerAddressRotationStatus.CONFIRMED }],
        addressHistory: [{ stellarAddress: CURRENT, rotationId: view.id }],
      });
    });

    it("refuses to reconcile a rotation through another issuer's path", async () => {
      const ctx = setup();
      const view = await ctx.request();

      await expect(ctx.service.reconcileForIssuer(ADMIN, "issuer_2", view.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(ctx.service.listForIssuer("missing")).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
