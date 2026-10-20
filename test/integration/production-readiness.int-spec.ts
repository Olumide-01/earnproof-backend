import { ConflictException } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-base";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { sep53MessageHash } from "../../src/auth/wallet-signature";
import { METRIC_NAMES, registerCoreMetrics } from "../../src/common/observability/metrics.catalog";
import { MetricsRegistry } from "../../src/common/observability/metrics.registry";
import { Clock } from "../../src/common/time/clock";
import { verifySnapshot, resolveSigningKey } from "../../src/config/config-snapshot";
import { CONFIG_SOURCE, ConfigRolloutService } from "../../src/deployments/config-rollout.service";
import { ConfigRolloutStore, PrismaConfigRolloutStore } from "../../src/deployments/config-rollout.store";
import { MetricContribution } from "../../src/metrics/metric-rollup";
import { MetricRollupService } from "../../src/metrics/metric-rollup.service";
import { MetricRollupStore, PrismaMetricRollupStore } from "../../src/metrics/metric-rollup.store";
import { PaymentAccountResolver } from "../../src/payments/payment-account.resolver";
import { PaymentAccountRotationService } from "../../src/payments/payment-account-rotation.service";
import { FixedClock } from "../time/fixed-clock";
import { integrationDatabase } from "./harness/database";
import { createHash } from "crypto";
import { PrismaClient } from "@prisma/client";
import { integrationModule } from "./harness/nest";

/**
 * Prisma-backed persistence for #321, #329 and #330 against real PostgreSQL.
 *
 * The unit suites exercise the same services through in-memory stores. What
 * only a database can prove is asserted here: unique indexes under races,
 * skip-duplicate inserts, transactional rollback on a constraint violation,
 * conditional updates, and that signed JSON survives a JSONB round trip.
 */

const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const MINUTE = 60_000;
const clock = new FixedClock(T0);
let config: Record<string, unknown> = { health: { probeTimeoutMs: 2000 }, sessionSecret: "never-stored" };

const db = integrationDatabase();
const injector = integrationModule([
  { provide: Clock, useValue: clock },
  { provide: MetricsRegistry, useFactory: () => {
    const registry = new MetricsRegistry();
    registerCoreMetrics(registry);
    return registry;
  } },
  { provide: MetricRollupStore, useClass: PrismaMetricRollupStore },
  MetricRollupService,
  { provide: ConfigRolloutStore, useClass: PrismaConfigRolloutStore },
  { provide: CONFIG_SOURCE, useValue: () => config },
  ConfigRolloutService,
  PaymentAccountResolver,
  PaymentAccountRotationService,
]);

// Local helpers rather than ./harness/fixtures, which does not currently
// type-check against the schema (SupportedAsset.assetKey) on develop.
async function seedUser(prisma: PrismaClient, seed: string, overrides: { role?: "ADMIN" | "WORKER" } = {}) {
  const walletAddress = Keypair.fromRawEd25519Seed(createHash("sha256").update(seed).digest()).publicKey();
  return prisma.user.create({
    data: {
      id: `user-${seed}`,
      walletAddress,
      walletHash: `sha256:${createHash("sha256").update(walletAddress).digest("hex")}`,
      role: overrides.role ?? "WORKER",
    },
  });
}

async function race<T>(operations: Array<Promise<T>>): Promise<{ fulfilled: T[]; rejected: unknown[] }> {
  const results = await Promise.allSettled(operations);
  return {
    fulfilled: results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
    rejected: results.flatMap((r) => (r.status === "rejected" ? [r.reason] : [])),
  };
}

/** Resolves a provider registered under an abstract-class token. */
function byToken<T>(token: abstract new (...args: never[]) => T): T {
  return injector.get<T>(token as unknown as symbol);
}

beforeEach(() => {
  clock.set(T0);
  config = { health: { probeTimeoutMs: 2000 }, sessionSecret: "never-stored" };
});

function actorOf(user: { id: string; walletAddress: string; walletHash: string; role: string }): AuthenticatedUser {
  return { id: user.id, walletAddress: user.walletAddress, walletHash: user.walletHash, role: user.role };
}

function contribution(overrides: Partial<MetricContribution> = {}): MetricContribution {
  return {
    sourceId: "src-a",
    captureSeq: 1,
    metric: METRIC_NAMES.httpRequestsTotal,
    kind: "COUNTER",
    seriesKey: "method=GET,route=/proofs,status_class=2xx",
    bucketStartMs: T0,
    sum: 3,
    count: null,
    bucketCounts: null,
    capturedAtMs: T0 + MINUTE,
    ...overrides,
  };
}

describe("metric rollup persistence (#330)", () => {
  const store = () => byToken(MetricRollupStore);

  it("skips a retried contribution with the same idempotency key", async () => {
    expect(await store().insertContributions([contribution()])).toBe(1);
    expect(await store().insertContributions([contribution(), contribution({ captureSeq: 2 })])).toBe(1);
    expect(await db.prisma.operationalMetricContribution.count()).toBe(2);
  });

  it("round-trips histogram bucket counts and sets rollups instead of incrementing", async () => {
    const histogram = contribution({
      metric: METRIC_NAMES.httpRequestDurationMs,
      kind: "HISTOGRAM",
      seriesKey: "method=GET,route=/proofs",
      sum: 707,
      count: 2,
      bucketCounts: [1, 1, 2],
    });
    await store().insertContributions([histogram]);
    expect(await store().listContributions(T0, T0 + MINUTE)).toEqual([histogram]);

    const rollup = {
      tier: "MINUTE" as const,
      metric: histogram.metric,
      kind: "HISTOGRAM" as const,
      seriesKey: histogram.seriesKey,
      bucketStartMs: T0,
      sum: 707,
      count: 2,
      bucketCounts: [1, 1, 2],
      sampleCount: 1,
    };
    await store().upsertRollups([rollup]);
    await store().upsertRollups([rollup]);
    expect(await store().listRollups("MINUTE", T0, T0 + MINUTE)).toEqual([rollup]);
  });

  it("only ever moves a watermark forward, including when replicas race to create it", async () => {
    await Promise.all([
      store().advanceWatermark("MINUTE", T0 + 2 * MINUTE),
      store().advanceWatermark("MINUTE", T0 + MINUTE),
      store().advanceWatermark("MINUTE", T0 + 3 * MINUTE),
    ]);
    await store().advanceWatermark("MINUTE", T0);
    expect(await store().getWatermark("MINUTE")).toBe(T0 + 3 * MINUTE);
  });

  it("rolls captured traffic up and keeps unabsorbed data through cleanup", async () => {
    const service = injector.get(MetricRollupService);
    const registry = injector.get(MetricsRegistry);
    service.resetBaseline();

    registry.increment(METRIC_NAMES.httpRequestsTotal, { route: "/proofs", method: "GET", status_class: "2xx" }, 4);
    clock.advanceMs(MINUTE);
    await service.collect();
    clock.set(T0 + MINUTE + 150_000);
    await service.rollup();

    const minutes = await store().listRollups("MINUTE", T0, T0 + MINUTE, METRIC_NAMES.httpRequestsTotal);
    expect(minutes.reduce((total, row) => total + row.sum, 0)).toBe(4);

    // Past raw retention, but the hour tier has not absorbed the minute yet.
    clock.set(T0 + 7 * 3_600_000);
    expect((await service.cleanup()).MINUTE).toBe(0);
  });
});

describe("config rollout persistence (#329)", () => {
  const service = () => injector.get(ConfigRolloutService);
  let admin: AuthenticatedUser;

  beforeEach(async () => {
    admin = actorOf(await seedUser(db.prisma, "rollout-admin", { role: "ADMIN" }));
  });

  it("stores a snapshot whose signature still verifies after a JSONB round trip", async () => {
    const captured = await service().captureSnapshot(admin);
    const read = await service().getSnapshot(captured.id);
    const key = resolveSigningKey({ credentialSigningSecret: process.env.CREDENTIAL_SIGNING_SECRET })!;

    expect(read.verified).toBe(true);
    expect(verifySnapshot(read.document, key)).toEqual({ valid: true });
    const row = await db.prisma.configSnapshot.findUniqueOrThrow({ where: { id: captured.id } });
    expect(JSON.stringify(row)).not.toContain("never-stored");
  });

  it("deduplicates concurrent captures of the same configuration", async () => {
    const { fulfilled } = await race([service().captureSnapshot(admin), service().captureSnapshot(admin)]);
    expect(new Set(fulfilled.map((snapshot) => snapshot.id)).size).toBe(1);
    expect(await db.prisma.configSnapshot.count()).toBe(1);
  });

  it("enforces one open rollout per environment with the unique index", async () => {
    const baseline = await service().captureSnapshot(admin);
    config = { health: { probeTimeoutMs: 3000 } };
    const target = await service().captureSnapshot(admin);
    const input = { snapshotId: target.id, environment: "production", baselineSnapshotId: baseline.id };

    const { fulfilled, rejected } = await race([
      service().createRollout(admin, input),
      service().createRollout(admin, input),
    ]);
    expect(fulfilled).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(ConflictException);
  });

  it("applies exactly one of two concurrent promotions and frees the environment on completion", async () => {
    const baseline = await service().captureSnapshot(admin);
    config = { health: { probeTimeoutMs: 3000 } };
    const target = await service().captureSnapshot(admin);
    let view = await service().createRollout(admin, {
      snapshotId: target.id,
      environment: "staging",
      baselineSnapshotId: baseline.id,
      stages: [100],
    });
    view = await service().recordGate(admin, view.id, {
      expectedVersion: view.version,
      stageIndex: 0,
      checks: ["readiness", "error_rate", "latency"].map((name) => ({ name, passed: true, observedAtMs: T0 })),
    });

    const { fulfilled, rejected } = await race([
      service().promote(admin, view.id, view.version),
      service().promote(admin, view.id, view.version),
    ]);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const row = await db.prisma.configRollout.findUniqueOrThrow({ where: { id: view.id } });
    expect(row).toMatchObject({ status: "COMPLETED", openEnvironmentKey: null });
    expect(await db.prisma.configRolloutEvent.count({ where: { rolloutId: view.id, type: "COMPLETED" } })).toBe(1);
  });
});

describe("payment account rotation persistence (#321)", () => {
  const rotations = () => injector.get(PaymentAccountRotationService);
  const resolver = () => injector.get(PaymentAccountResolver);
  const sign = (keypair: Keypair, message: string) => keypair.sign(sep53MessageHash(message)).toString("base64");

  async function verifiedRotation(seed: string, backfillFromLedger?: number) {
    const user = actorOf(await seedUser(db.prisma, seed));
    await db.prisma.paymentSyncCheckpoint.create({
      data: {
        userId: user.id,
        pagingToken: "4294967296001",
        operationId: "4294967296001",
        transactionHash: "a".repeat(64),
        ledgerSequence: 1_000_000,
        ledgerHash: "b".repeat(64),
        verifiedAt: new Date(T0),
      },
    });
    const target = Keypair.random();
    const requested = await rotations().request(user, { network: "testnet", newAccountId: target.publicKey(), backfillFromLedger });
    const view = await rotations().verify(user, requested.id, sign(target, requested.challengeMessage!));
    return { user, target, view };
  }

  it("hands off atomically: retire, activate, remove the checkpoint and queue the backfill", async () => {
    const { user, target, view } = await verifiedRotation("rotation-handoff", 999_000);

    const activated = await rotations().activate(user, view.id, view.version);

    expect(activated).toMatchObject({ status: "ACTIVATED", finalCheckpoint: { ledgerSequence: 1_000_000 } });
    expect(await db.prisma.paymentSyncCheckpoint.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.prisma.paymentBackfillJob.findMany({ where: { userId: user.id } })).toEqual([
      expect.objectContaining({ accountId: target.publicKey(), startLedger: 999_000, endLedger: 1_000_000 }),
    ]);
    await expect(resolver().current(user)).resolves.toMatchObject({ accountId: target.publicKey(), source: "rotation" });

    // requested, verified, activated: appended to the hash chain inside each
    // transaction, never as default (sequence 0, empty hash) rows.
    const audit = await db.prisma.auditLog.findMany({
      where: { resourceType: "payment_account_rotation", resourceId: view.id },
      orderBy: { sequence: "asc" },
    });
    expect(audit.map((row) => row.action)).toEqual([
      "payment_account.rotation_requested",
      "payment_account.rotation_verified",
      "payment_account.rotation_activated",
    ]);
    expect(audit.map((row) => row.sequence)).toEqual([BigInt(1), BigInt(2), BigInt(3)]);
    audit.forEach((row, i) => {
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.prevHash).toBe(i === 0 ? null : audit[i - 1].hash);
    });
  });

  it("lets exactly one of two concurrent activations commit", async () => {
    const { user, view } = await verifiedRotation("rotation-race", 999_000);

    const { fulfilled, rejected } = await race([
      rotations().activate(user, view.id, view.version),
      rotations().activate(user, view.id, view.version),
    ]);

    expect(fulfilled).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(ConflictException);
    expect(await db.prisma.paymentBackfillJob.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.prisma.paymentMonitoredAccount.count({ where: { userId: user.id, status: "ACTIVE" } })).toBe(1);
  });

  it("rolls back every write when the new account is claimed by another user (unique index)", async () => {
    const { user, target, view } = await verifiedRotation("rotation-claimed");
    const other = await seedUser(db.prisma, "rotation-other");
    await db.prisma.paymentMonitoredAccount.create({
      data: {
        id: "epoch-other",
        userId: other.id,
        network: "testnet",
        accountId: target.publicKey(),
        status: "ACTIVE",
        activatedAt: new Date(T0),
        activeUserKey: `${other.id}:testnet`,
        activeAccountKey: `testnet:${target.publicKey()}`,
      },
    });

    await expect(rotations().activate(user, view.id, view.version)).rejects.toThrow(ConflictException);

    expect(await db.prisma.paymentSyncCheckpoint.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.prisma.paymentMonitoredAccount.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.prisma.paymentAccountRotation.findUniqueOrThrow({ where: { id: view.id } })).toMatchObject({
      status: "VERIFIED",
    });
  });

  it("restores the old account and checkpoint on rollback and cancels the queued backfill", async () => {
    const { user, view } = await verifiedRotation("rotation-rollback", 999_000);
    const active = await rotations().activate(user, view.id, view.version);

    await rotations().rollback(user, active.id, { expectedVersion: active.version, reason: "wrong_account" });

    await expect(resolver().current(user)).resolves.toMatchObject({ accountId: user.walletAddress });
    expect(await db.prisma.paymentSyncCheckpoint.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({
      pagingToken: "4294967296001",
      status: "VERIFIED",
    });
    expect(await db.prisma.paymentBackfillJob.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({
      status: "CANCELLED",
    });
  });

  it("allows only one open rotation per user", async () => {
    const user = actorOf(await seedUser(db.prisma, "rotation-open"));
    const { fulfilled, rejected } = await race([
      rotations().request(user, { network: "testnet", newAccountId: Keypair.random().publicKey() }),
      rotations().request(user, { network: "testnet", newAccountId: Keypair.random().publicKey() }),
    ]);
    expect(fulfilled).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(ConflictException);
  });
});
