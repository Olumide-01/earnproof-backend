import { BadRequestException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FixedClock } from "../../test/time/fixed-clock";
import { METRIC_NAMES, registerCoreMetrics } from "../common/observability/metrics.catalog";
import { MetricsRegistry } from "../common/observability/metrics.registry";
import { MAX_PENDING_CAPTURES, MetricRollupService } from "./metric-rollup.service";
import { InMemoryMetricRollupStore } from "./testing/in-memory-metric-rollup.store";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const GRACE = 120_000;
const SETTLE = 30_000;

const LABELS = { route: "/proofs", method: "GET", status_class: "2xx" };

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    "metricsRollup.enabled": true,
    "metricsRollup.latenessGraceMs": GRACE,
    "metricsRollup.settleDelayMs": SETTLE,
    "metricsRollup.rawRetentionHours": 6,
    "metricsRollup.minuteRetentionDays": 3,
    "metricsRollup.hourRetentionDays": 90,
    "metricsRollup.dayRetentionDays": 730,
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function setup(overrides: Record<string, unknown> = {}) {
  const clock = new FixedClock(T0);
  const registry = new MetricsRegistry();
  registerCoreMetrics(registry);
  const store = new InMemoryMetricRollupStore();
  const service = new MetricRollupService(store, registry, config(overrides), clock);
  service.onModuleInit();
  const hit = (times = 1) => registry.increment(METRIC_NAMES.httpRequestsTotal, LABELS, times);
  return { clock, registry, store, service, hit };
}

/** Sum of every minute rollup for the request counter. */
function minuteTotal(store: InMemoryMetricRollupStore): number {
  return [...store.rollups.values()]
    .filter((r) => r.tier === "MINUTE" && r.metric === METRIC_NAMES.httpRequestsTotal)
    .reduce((total, r) => total + r.sum, 0);
}

describe("MetricRollupService", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("does not attribute activity from before boot to any minute", async () => {
    const clock = new FixedClock(T0);
    const registry = new MetricsRegistry();
    registerCoreMetrics(registry);
    registry.increment(METRIC_NAMES.httpRequestsTotal, LABELS, 100);
    const store = new InMemoryMetricRollupStore();
    const service = new MetricRollupService(store, registry, config(), clock);
    service.onModuleInit();

    clock.advanceMs(MINUTE);
    await service.collect();

    expect(store.contributions.size).toBe(0);
  });

  it("rolls captured deltas up through minute, hour and day tiers", async () => {
    const { clock, store, service, hit } = setup();

    // Two minutes of traffic: 3 then 4 requests.
    hit(3);
    clock.advanceMs(MINUTE);
    await service.collect();
    hit(4);
    clock.advanceMs(MINUTE);
    await service.collect();

    // Seal the whole first day, then roll everything up.
    clock.set(T0 + DAY + GRACE + SETTLE);
    for (let i = 0; i < 20; i += 1) await service.rollup();

    const byTier = (tier: string) =>
      [...store.rollups.values()].filter((r) => r.tier === tier && r.metric === METRIC_NAMES.httpRequestsTotal);
    expect(byTier("MINUTE").map((r) => [r.bucketStartMs - T0, r.sum])).toEqual([
      [0, 3],
      [MINUTE, 4],
    ]);
    expect(byTier("HOUR")).toEqual([expect.objectContaining({ bucketStartMs: T0, sum: 7, sampleCount: 2 })]);
    expect(byTier("DAY")).toEqual([expect.objectContaining({ bucketStartMs: T0, sum: 7, sampleCount: 2 })]);
    expect(store.watermarks.get("DAY")).toBe(T0 + DAY);
  });

  it("aggregates histograms with count, sum and bucket counts", async () => {
    const { clock, registry, store, service } = setup();
    registry.observe(METRIC_NAMES.httpRequestDurationMs, 7, { route: "/proofs", method: "GET" });
    registry.observe(METRIC_NAMES.httpRequestDurationMs, 700, { route: "/proofs", method: "GET" });
    clock.advanceMs(MINUTE);
    await service.collect();
    clock.set(T0 + MINUTE + GRACE + SETTLE);
    await service.rollup();

    const rollup = [...store.rollups.values()].find((r) => r.metric === METRIC_NAMES.httpRequestDurationMs);
    expect(rollup).toMatchObject({ kind: "HISTOGRAM", sum: 707, count: 2 });
    expect(rollup?.bucketCounts?.reduce((a, b) => Math.max(a, b), 0)).toBe(2);
  });

  describe("retries never double-count", () => {
    it("retries a failed write with the same keys on the next capture", async () => {
      const { clock, store, service, hit } = setup();
      hit(5);
      clock.advanceMs(MINUTE);
      store.failNextInsert = { afterCommit: false };
      await service.collect();
      expect(store.contributions.size).toBe(0);
      expect((await service.status()).pendingCaptures).toBe(1);

      hit(2);
      clock.advanceMs(MINUTE);
      await service.collect();

      clock.set(T0 + 2 * MINUTE + GRACE + SETTLE);
      await service.rollup();
      expect(minuteTotal(store)).toBe(7);
      expect((await service.status()).pendingCaptures).toBe(0);
    });

    it("skips a retried write that had actually committed", async () => {
      const { clock, store, service, hit } = setup();
      hit(5);
      clock.advanceMs(MINUTE);
      store.failNextInsert = { afterCommit: true };
      await service.collect();
      expect(store.contributions.size).toBe(1);

      clock.advanceMs(MINUTE);
      await service.collect();

      clock.set(T0 + 2 * MINUTE + GRACE + SETTLE);
      await service.rollup();
      expect(minuteTotal(store)).toBe(5);
    });

    it("serialises concurrent collections so a delta is captured once", async () => {
      const { clock, store, service, hit } = setup();
      hit(9);
      clock.advanceMs(MINUTE);
      await Promise.all([service.collect(), service.collect(), service.collect()]);
      const total = [...store.contributions.values()].reduce((sum, c) => sum + c.sum, 0);
      expect(total).toBe(9);
    });
  });

  describe("late-sample policy", () => {
    async function retryAt(offsetAfterBucketEnd: number) {
      const { clock, store, service, hit } = setup();
      hit(5);
      clock.advanceMs(MINUTE);
      store.failNextInsert = { afterCommit: false };
      await service.collect();
      clock.set(T0 + MINUTE + offsetAfterBucketEnd);
      const result = await service.collect();
      return { store, service, result };
    }

    it("accepts a retry one millisecond before the grace deadline", async () => {
      const { store } = await retryAt(GRACE - 1);
      expect(store.contributions.size).toBe(1);
    });

    it("drops and counts a retry exactly at the grace deadline", async () => {
      const { store, service, result } = await retryAt(GRACE);
      expect(store.contributions.size).toBe(0);
      expect(result.dropped).toBe(1);
      expect((await service.status()).lateContributionsDropped).toBe(1);
    });

    it("bounds the retry buffer while the store is down", async () => {
      const { clock, store, service, hit } = setup({ "metricsRollup.latenessGraceMs": 3_600_000 });
      for (let i = 0; i < MAX_PENDING_CAPTURES + 3; i += 1) {
        hit();
        clock.advanceMs(MINUTE);
        store.failNextInsert = { afterCommit: false };
        await service.collect();
      }
      const status = await service.status();
      expect(status.pendingCaptures).toBe(MAX_PENDING_CAPTURES);
      expect(status.overflowCapturesDropped).toBe(3);
    });
  });

  describe("sealing and replay", () => {
    it("does not roll up a minute until it is sealed, to the millisecond", async () => {
      const { clock, store, service, hit } = setup();
      hit();
      clock.advanceMs(MINUTE);
      await service.collect();

      clock.set(T0 + MINUTE + GRACE + SETTLE - 1);
      await service.rollup();
      expect(store.rollups.size).toBe(0);

      clock.set(T0 + MINUTE + GRACE + SETTLE);
      await service.rollup();
      expect(minuteTotal(store)).toBe(1);
    });

    it("produces identical aggregates when rollups are replayed", async () => {
      const { clock, store, service, hit } = setup();
      hit(3);
      clock.advanceMs(MINUTE);
      await service.collect();
      clock.set(T0 + HOUR + GRACE + SETTLE);
      await service.rollup();
      await service.rollup();
      const first = structuredClone([...store.rollups.values()]);

      // Force a full replay from scratch over the same sealed inputs.
      store.rollups.clear();
      store.watermarks.clear();
      await service.rollup();
      await service.rollup();

      expect([...store.rollups.values()]).toEqual(first);
    });

    it("lets two replicas roll up concurrently without changing the result", async () => {
      const { clock, registry, store, service, hit } = setup();
      const replica = new MetricRollupService(store, registry, config(), clock);
      hit(4);
      clock.advanceMs(MINUTE);
      await service.collect();
      clock.set(T0 + HOUR + GRACE + SETTLE);

      await Promise.all([service.rollup(), replica.rollup(), service.rollup(), replica.rollup()]);
      await Promise.all([service.rollup(), replica.rollup()]);

      expect(minuteTotal(store)).toBe(4);
      const hours = [...store.rollups.values()].filter((r) => r.tier === "HOUR");
      expect(hours).toEqual([expect.objectContaining({ sum: 4, sampleCount: 1 })]);
    });

    it("never moves a watermark backwards", async () => {
      const { store } = setup();
      await store.advanceWatermark("MINUTE", T0 + 2 * MINUTE);
      await store.advanceWatermark("MINUTE", T0 + MINUTE);
      expect(store.watermarks.get("MINUTE")).toBe(T0 + 2 * MINUTE);
    });

    it("re-baselines instead of attributing a delta when the clock steps backwards", async () => {
      const { clock, store, service, hit } = setup();
      hit(3);
      clock.advanceMs(-MINUTE);
      await service.collect();
      expect(store.contributions.size).toBe(0);
    });
  });

  describe("retention", () => {
    it("never deletes a tier the tier above has not absorbed", async () => {
      const { clock, store, service, hit } = setup();
      hit();
      clock.advanceMs(MINUTE);
      await service.collect();
      // Well past raw and minute retention, but nothing rolled up yet.
      clock.set(T0 + 10 * DAY);

      const deleted = await service.cleanup();

      expect(deleted).toMatchObject({ contribution: 0, MINUTE: 0 });
      expect(store.contributions.size).toBe(1);
    });

    it("deletes absorbed data once it is past retention", async () => {
      const { clock, store, service, hit } = setup();
      hit();
      clock.advanceMs(MINUTE);
      await service.collect();
      clock.set(T0 + DAY + GRACE + SETTLE);
      for (let i = 0; i < 20; i += 1) await service.rollup();

      clock.set(T0 + 10 * DAY);
      const deleted = await service.cleanup();

      expect(deleted).toMatchObject({ contribution: 1, MINUTE: 1, HOUR: 0, DAY: 0 });
      expect([...store.rollups.values()].map((r) => r.tier).sort()).toEqual(["DAY", "HOUR"]);
    });

    it("keeps data until exactly its retention cutoff", async () => {
      const { clock, service, hit } = setup();
      hit();
      clock.advanceMs(MINUTE);
      await service.collect();
      clock.set(T0 + MINUTE + GRACE + SETTLE);
      await service.rollup();

      // Contribution bucket T0; cutoff now - 6h. At now = T0 + 6h it is not yet < cutoff.
      clock.set(T0 + 6 * HOUR);
      expect((await service.cleanup()).contribution).toBe(0);
      clock.set(T0 + 6 * HOUR + 1);
      expect((await service.cleanup()).contribution).toBe(1);
    });
  });

  describe("query", () => {
    async function populated() {
      const ctx = setup();
      ctx.hit(2);
      ctx.clock.advanceMs(MINUTE);
      await ctx.service.collect();
      ctx.clock.set(T0 + MINUTE + GRACE + SETTLE);
      await ctx.service.rollup();
      return ctx;
    }

    it("groups points by label set", async () => {
      const { service } = await populated();
      const result = await service.query({
        tier: "MINUTE",
        metric: METRIC_NAMES.httpRequestsTotal,
        fromMs: T0,
        toMs: T0 + HOUR,
      });
      expect(result.series).toEqual([
        {
          labels: LABELS,
          points: [
            { bucketStart: "2030-01-01T00:00:00.000Z", sum: 2, count: null, bucketCounts: null, sampleCount: 1 },
          ],
        },
      ]);
    });

    it("treats from as inclusive and to as exclusive", async () => {
      const { service } = await populated();
      const excluded = await service.query({
        tier: "MINUTE",
        metric: METRIC_NAMES.httpRequestsTotal,
        fromMs: T0 - HOUR,
        toMs: T0,
      });
      expect(excluded.series).toEqual([]);
    });

    it.each([
      ["an unknown metric", { metric: "wallet_balances" }],
      ["an inverted range", { fromMs: T0, toMs: T0 }],
      ["a span too large for the tier", { fromMs: T0, toMs: T0 + DAY + 1 }],
    ])("rejects %s", async (_label, overrides) => {
      const { service } = setup();
      await expect(
        service.query({
          tier: "MINUTE",
          metric: METRIC_NAMES.httpRequestsTotal,
          fromMs: T0,
          toMs: T0 + HOUR,
          ...overrides,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("accepts a span exactly at the tier limit", async () => {
      const { service } = setup();
      await expect(
        service.query({ tier: "MINUTE", metric: METRIC_NAMES.httpRequestsTotal, fromMs: T0, toMs: T0 + DAY }),
      ).resolves.toMatchObject({ series: [] });
    });
  });

  it("does nothing when disabled", async () => {
    const { clock, store, service, hit } = setup({ "metricsRollup.enabled": false });
    hit();
    clock.advanceMs(MINUTE);
    await service.collect();
    clock.set(T0 + DAY);
    await service.rollup();
    await service.cleanup();
    expect(store.contributions.size + store.rollups.size).toBe(0);
  });

  it("refuses an unsafe retention configuration at construction", () => {
    expect(() =>
      new MetricRollupService(
        new InMemoryMetricRollupStore(),
        new MetricsRegistry(),
        config({ "metricsRollup.minuteRetentionDays": 1, "metricsRollup.hourRetentionDays": 1 }),
      ),
    ).toThrow(/retention/);
  });
});
