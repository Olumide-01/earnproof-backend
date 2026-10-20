import { ArgumentsHost, HttpStatus } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { ResourceStatus } from "@prisma/client";
import { ApiKeyService } from "../api-keys/api-key.service";
import { ApiErrorCode } from "../common/dto/api-error.dto";
import { GlobalExceptionFilter } from "../common/filters/global-exception.filter";
import { METRIC_NAMES, registerCoreMetrics } from "../common/observability/metrics.catalog";
import { MetricsRegistry } from "../common/observability/metrics.registry";
import { validateEnv } from "../config/env.validation";
import { PaymentsService } from "../payments/payments.service";
import { OrganizationQuotaService } from "./organization-quota.service";
import { QuotaExceededException, windowStart } from "./quota.types";

// ---------------------------------------------------------------------------
// In-memory database with the two guarantees quota enforcement relies on:
//   1. `SELECT … FOR UPDATE` on an organization row blocks other transactions
//      locking the same row until the holder commits or rolls back;
//   2. the usage upsert is one atomic statement.
// A failed transaction undoes only its own writes (an undo log, as Postgres
// does) — never writes other transactions committed meanwhile. Every
// statement yields, so concurrent callers genuinely interleave.
// ---------------------------------------------------------------------------

type Key = { id: string; organizationId: string; status: ResourceStatus; expiresAt: Date | null };
type Hook = { id: string; organizationId: string; status: ResourceStatus };
type Usage = { organizationId: string; quota: string; windowStart: Date; count: number };

const tick = () => new Promise((resolve) => setImmediate(resolve));

function createDb(opts: { honourRowLocks?: boolean } = {}) {
  const honourRowLocks = opts.honourRowLocks ?? true;
  const state = {
    orgs: [{ id: "org_a", createdById: "user_a", status: ResourceStatus.ACTIVE, createdAt: new Date(0) }],
    keys: [] as Key[],
    hooks: [] as Hook[],
    usage: [] as Usage[],
    audit: [] as unknown[],
  };
  const locks = new Map<string, Promise<void>>();
  let seq = 0;

  const count = <T,>(rows: T[], pred: (r: T) => boolean) => rows.filter(pred).length;

  function client(held: Array<() => void>, undo: Array<() => void>) {
    return {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("FOR UPDATE")) {
          const orgId = values[0] as string;
          if (honourRowLocks) {
            while (locks.has(orgId)) await locks.get(orgId);
            let release!: () => void;
            locks.set(orgId, new Promise<void>((r) => (release = r)));
            held.push(() => {
              locks.delete(orgId);
              release();
            });
          }
          await tick();
          return [{ id: orgId }];
        }
        if (sql.includes('INSERT INTO "OrganizationQuotaUsage"')) {
          const [organizationId, quota, start, limit] = values as [string, string, Date, number];
          await tick();
          // Atomic: no await between the read and the write.
          const row = state.usage.find(
            (u) => u.organizationId === organizationId && u.quota === quota && u.windowStart.getTime() === start.getTime(),
          );
          if (!row) {
            const created = { organizationId, quota, windowStart: start, count: 1 };
            state.usage.push(created);
            undo.push(() => state.usage.splice(state.usage.indexOf(created), 1));
            return [{ count: 1 }];
          }
          if (row.count < limit) {
            row.count += 1;
            undo.push(() => (row.count -= 1));
            return [{ count: row.count }];
          }
          return [];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
      organization: {
        findFirst: async ({ where }: { where: { createdById: string; status: ResourceStatus } }) =>
          state.orgs.find((o) => o.createdById === where.createdById && o.status === where.status) ?? null,
      },
      apiKey: {
        count: async ({ where }: { where: { organizationId: string } }) => {
          await tick();
          const now = new Date();
          return count(state.keys, (k) =>
            k.organizationId === where.organizationId &&
            k.status === ResourceStatus.ACTIVE &&
            (k.expiresAt === null || k.expiresAt > now));
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          await tick();
          const row = {
            id: `key_${++seq}`,
            organizationId: data.organizationId as string,
            status: ResourceStatus.ACTIVE,
            expiresAt: (data.expiresAt as Date | undefined) ?? null,
            prefix: data.prefix,
            name: data.name,
            createdAt: new Date(),
            scopeAssignments: [],
          };
          state.keys.push(row);
          undo.push(() => state.keys.splice(state.keys.indexOf(row), 1));
          return row;
        },
      },
      webhook: {
        count: async ({ where }: { where: { organizationId: string } }) => {
          await tick();
          return count(state.hooks, (h) => h.organizationId === where.organizationId && h.status !== ResourceStatus.DELETED);
        },
      },
      organizationQuotaUsage: {
        findMany: async ({ where }: { where: { organizationId: string; OR: Array<{ quota: string; windowStart: Date }> } }) =>
          state.usage
            .filter((u) => u.organizationId === where.organizationId)
            .filter((u) => where.OR.some((c) => c.quota === u.quota && c.windowStart.getTime() === u.windowStart.getTime()))
            .map((u) => ({ quota: u.quota, count: u.count })),
      },
      auditLog: {
        create: async ({ data }: { data: unknown }) => {
          await tick();
          state.audit.push(data);
          undo.push(() => state.audit.splice(state.audit.indexOf(data), 1));
          return data;
        },
      },
    };
  }

  // Outside a transaction every statement autocommits: nothing to undo.
  const root = client([], []);
  const db = {
    ...root,
    $transaction: async <T,>(fn: (tx: ReturnType<typeof client>) => Promise<T>): Promise<T> => {
      const held: Array<() => void> = [];
      const undo: Array<() => void> = [];
      try {
        return await fn(client(held, undo));
      } catch (error) {
        undo.reverse().forEach((revert) => revert());
        throw error;
      } finally {
        held.forEach((release) => release());
      }
    },
  };
  return { db, state };
}

function quotaService(db: unknown, limits: Record<string, number> = {}) {
  const metrics = new MetricsRegistry();
  registerCoreMetrics(metrics);
  const config = { get: (key: string) => limits[key.replace("quotas.", "")] };
  return { quotas: new OrganizationQuotaService(db as never, config as never, metrics), metrics };
}

function rejections(metrics: MetricsRegistry, quota: string): number {
  const metric = metrics.snapshot().find((m) => m.name === METRIC_NAMES.quotaRejectionsTotal);
  if (!metric || metric.type !== "counter") return 0;
  return metric.series.find((s) => s.labels.quota === quota)?.value ?? 0;
}

describe("OrganizationQuotaService — concurrent quotas", () => {
  it("never lets concurrent API key creations exceed the limit", async () => {
    const { db, state } = createDb();
    const { quotas, metrics } = quotaService(db, { maxActiveApiKeys: 5 });
    const apiKeys = new ApiKeyService(db as never, quotas);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        apiKeys.createKey({ organizationId: "org_a", createdBy: "user_a", name: `k${i}` })),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(failures).toHaveLength(15);
    failures.forEach((f) => expect(f.reason).toBeInstanceOf(QuotaExceededException));
    // No partial writes: exactly one audit entry per surviving key.
    expect(state.keys).toHaveLength(5);
    expect(state.audit).toHaveLength(5);
    expect(rejections(metrics, "api_keys")).toBe(15);
  });

  it("negative control: without the row lock the same burst overshoots", async () => {
    const { db, state } = createDb({ honourRowLocks: false });
    const { quotas } = quotaService(db, { maxActiveApiKeys: 5 });
    const apiKeys = new ApiKeyService(db as never, quotas);

    await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        apiKeys.createKey({ organizationId: "org_a", createdBy: "user_a", name: `k${i}` })),
    );

    // Proves the lock, not the count, is what makes the quota unbypassable.
    expect(state.keys.length).toBeGreaterThan(5);
  });

  it("counts only active, unexpired keys, and rejects exactly at the limit", async () => {
    const { db, state } = createDb();
    const { quotas } = quotaService(db, { maxActiveApiKeys: 3 });
    state.keys.push(
      { id: "revoked", organizationId: "org_a", status: ResourceStatus.REVOKED, expiresAt: null },
      { id: "expired", organizationId: "org_a", status: ResourceStatus.ACTIVE, expiresAt: new Date(Date.now() - 1000) },
      { id: "other_org", organizationId: "org_b", status: ResourceStatus.ACTIVE, expiresAt: null },
      { id: "live_1", organizationId: "org_a", status: ResourceStatus.ACTIVE, expiresAt: null },
      { id: "live_2", organizationId: "org_a", status: ResourceStatus.ACTIVE, expiresAt: null },
    );

    // limit - 1 in use: allowed.
    await expect(db.$transaction((tx) => quotas.assertCapacity(tx as never, "org_a", "api_keys"))).resolves.toBeUndefined();
    state.keys.push({ id: "live_3", organizationId: "org_a", status: ResourceStatus.ACTIVE, expiresAt: null });
    // limit in use: rejected.
    await expect(db.$transaction((tx) => quotas.assertCapacity(tx as never, "org_a", "api_keys"))).rejects.toBeInstanceOf(QuotaExceededException);
  });

  it("counts disabled webhooks but not deleted ones", async () => {
    const { db, state } = createDb();
    const { quotas } = quotaService(db, { maxWebhooks: 2 });
    state.hooks.push(
      { id: "h1", organizationId: "org_a", status: ResourceStatus.SUSPENDED },
      { id: "h2", organizationId: "org_a", status: ResourceStatus.DELETED },
    );

    await expect(db.$transaction((tx) => quotas.assertCapacity(tx as never, "org_a", "webhooks"))).resolves.toBeUndefined();
    state.hooks.push({ id: "h3", organizationId: "org_a", status: ResourceStatus.ACTIVE });
    await expect(db.$transaction((tx) => quotas.assertCapacity(tx as never, "org_a", "webhooks"))).rejects.toMatchObject({ quota: "webhooks", limit: 2 });
  });
});

describe("OrganizationQuotaService — windowed quotas", () => {
  const NOW = new Date("2026-09-10T14:25:00.000Z");

  it("admits exactly the limit under a concurrent burst", async () => {
    const { db, state } = createDb();
    const { quotas, metrics } = quotaService(db, { proofRequestsPerDay: 10 });

    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () => db.$transaction((tx) => quotas.consume(tx as never, "org_a", "proof_requests", NOW))),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(state.usage).toEqual([
      { organizationId: "org_a", quota: "proof_requests", windowStart: new Date("2026-09-10T00:00:00.000Z"), count: 10 },
    ]);
    expect(rejections(metrics, "proof_requests")).toBe(20);
  });

  it("resets at the window boundary and reports the reset time", async () => {
    const { db } = createDb();
    const { quotas } = quotaService(db, { syncsPerHour: 1 });
    const endOfHour = new Date("2026-09-10T14:59:59.999Z");
    const nextHour = new Date("2026-09-10T15:00:00.000Z");

    await quotas.consume(db as never, "org_a", "sync_frequency", NOW);
    const error = await quotas.consume(db as never, "org_a", "sync_frequency", endOfHour).catch((e) => e);
    expect(error).toBeInstanceOf(QuotaExceededException);
    expect(error.resetsAt).toEqual(nextHour);
    await expect(quotas.consume(db as never, "org_a", "sync_frequency", nextHour)).resolves.toBeUndefined();
  });

  it("rolls consumption back when the guarded operation fails", async () => {
    const { db, state } = createDb();
    const { quotas } = quotaService(db, { proofRequestsPerDay: 1 });

    await expect(
      db.$transaction(async (tx) => {
        await quotas.consumeForUser(tx as never, "user_a", "proof_requests", NOW);
        throw new Error("proof issuance failed after the quota check");
      }),
    ).rejects.toThrow("proof issuance failed");

    expect(state.usage).toHaveLength(0);
    // The single unit is still available.
    await expect(db.$transaction((tx) => quotas.consumeForUser(tx as never, "user_a", "proof_requests", NOW))).resolves.toBe("org_a");
  });

  it("does not charge users outside any active organization", async () => {
    const { db, state } = createDb();
    const { quotas } = quotaService(db, { proofRequestsPerDay: 1 });

    await expect(quotas.consumeForUser(db as never, "user_without_org", "proof_requests", NOW)).resolves.toBeNull();
    expect(state.usage).toHaveLength(0);
  });

  it("keeps organizations isolated from each other", async () => {
    const { db, state } = createDb();
    const { quotas } = quotaService(db, { proofRequestsPerDay: 1 });

    await quotas.consume(db as never, "org_a", "proof_requests", NOW);
    await expect(quotas.consume(db as never, "org_b", "proof_requests", NOW)).resolves.toBeUndefined();
    expect(state.usage.map((u) => [u.organizationId, u.count])).toEqual([["org_a", 1], ["org_b", 1]]);
  });

  it("computes fixed UTC windows", () => {
    expect(windowStart("proof_requests", NOW).toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(windowStart("sync_frequency", NOW).toISOString()).toBe("2026-09-10T14:00:00.000Z");
  });
});

describe("OrganizationQuotaService — usage report", () => {
  it("reports usage, limits, and reset context without identifiers", async () => {
    const { db, state } = createDb();
    const { quotas } = quotaService(db, { maxActiveApiKeys: 5, maxWebhooks: 2, proofRequestsPerDay: 100, syncsPerHour: 4 });
    const now = new Date("2026-09-10T14:25:00.000Z");
    state.keys.push({ id: "secret_key_id", organizationId: "org_a", status: ResourceStatus.ACTIVE, expiresAt: null });
    state.hooks.push({ id: "secret_hook_id", organizationId: "org_a", status: ResourceStatus.ACTIVE });
    await quotas.consume(db as never, "org_a", "sync_frequency", now);
    await quotas.consume(db as never, "org_a", "sync_frequency", now);

    const report = await quotas.getUsage("org_a", now);

    expect(report.quotas).toEqual([
      { quota: "api_keys", type: "concurrent", limit: 5, used: 1, remaining: 4, window: null, windowStart: null, resetsAt: null },
      { quota: "webhooks", type: "concurrent", limit: 2, used: 1, remaining: 1, window: null, windowStart: null, resetsAt: null },
      { quota: "proof_requests", type: "windowed", limit: 100, used: 0, remaining: 100, window: "P1D", windowStart: "2026-09-10T00:00:00.000Z", resetsAt: "2026-09-11T00:00:00.000Z" },
      { quota: "sync_frequency", type: "windowed", limit: 4, used: 2, remaining: 2, window: "PT1H", windowStart: "2026-09-10T14:00:00.000Z", resetsAt: "2026-09-10T15:00:00.000Z" },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/secret_key_id|secret_hook_id/);
  });

  it("uses the documented defaults when nothing is configured", () => {
    const { quotas } = quotaService(createDb().db);
    expect(["api_keys", "webhooks", "proof_requests", "sync_frequency"].map((q) => quotas.limitFor(q as never))).toEqual([25, 10, 1000, 12]);
  });
});

describe("quota rejection vs rate limiting", () => {
  function classify(exception: unknown) {
    const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = {
      switchToHttp: () => ({ getRequest: () => ({ headers: {}, requestId: "req_1" }), getResponse: () => res }),
    } as unknown as ArgumentsHost;
    new GlobalExceptionFilter().catch(exception, host);
    return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
  }

  it("uses a distinct error code from ordinary throttling", () => {
    const quota = classify(new QuotaExceededException("proof_requests", 10, new Date("2026-09-11T00:00:00.000Z")));
    const throttled = classify(new ThrottlerException());

    expect(quota.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(quota.body.code).toBe(ApiErrorCode.QUOTA_EXCEEDED);
    expect(quota.body.message).toContain("2026-09-11T00:00:00.000Z");
    expect(throttled.body.code).toBe(ApiErrorCode.TOO_MANY_REQUESTS);
  });
});

describe("payment sync frequency quota", () => {
  it("rejects before contacting Horizon or writing payments", async () => {
    const stellar = { fetchIncomingPayments: jest.fn(), fetchTransaction: jest.fn() };
    const prisma = { payment: { upsert: jest.fn() } };
    const quotas = {
      consumeForUser: jest.fn().mockRejectedValue(new QuotaExceededException("sync_frequency", 12, new Date())),
    };
    const service = new PaymentsService(
      prisma as never,
      stellar as never,
      { getOrThrow: () => "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" } as never,
      quotas as never,
    );

    await expect(service.syncPayments({ id: "user_a", walletAddress: "GA" })).rejects.toBeInstanceOf(QuotaExceededException);
    expect(quotas.consumeForUser).toHaveBeenCalledWith(prisma, "user_a", "sync_frequency");
    expect(stellar.fetchIncomingPayments).not.toHaveBeenCalled();
    expect(prisma.payment.upsert).not.toHaveBeenCalled();
  });
});

describe("quota configuration", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    SESSION_SECRET: "session_secret_123",
    CREDENTIAL_SIGNING_SECRET: "credential_secret_123",
    PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  };

  it("applies documented defaults", () => {
    expect(validateEnv(base)).toMatchObject({
      QUOTA_MAX_ACTIVE_API_KEYS: 25,
      QUOTA_MAX_WEBHOOKS: 10,
      QUOTA_PROOF_REQUESTS_PER_DAY: 1000,
      QUOTA_SYNCS_PER_HOUR: 12,
      WEBHOOK_MAX_DELIVERY_ATTEMPTS: 5,
      WEBHOOK_REDRIVE_MAX_BATCH: 25,
    });
  });

  it.each([
    ["QUOTA_MAX_WEBHOOKS", "0"],
    ["QUOTA_SYNCS_PER_HOUR", "-1"],
    ["QUOTA_PROOF_REQUESTS_PER_DAY", "1.5"],
    ["WEBHOOK_MAX_DELIVERY_ATTEMPTS", "21"],
  ])("rejects %s=%s", (key, value) => {
    expect(() => validateEnv({ ...base, [key]: value })).toThrow(/Invalid environment/);
  });
});
