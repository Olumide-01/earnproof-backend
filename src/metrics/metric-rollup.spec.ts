import { InvalidMetricLabelError } from "../common/observability/metric-labels";
import type { MetricSnapshot } from "../common/observability/metrics.registry";
import {
  aggregate,
  assertValidRollupPolicy,
  bucketStart,
  contributionOrderKey,
  deltasFromSnapshot,
  emptyBaseline,
  isLate,
  labelsOf,
  MetricContribution,
  RollupPolicy,
  RollupPolicyError,
  sealedThrough,
  seriesKeyOf,
} from "./metric-rollup";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.parse("2030-01-01T00:00:00.000Z");

const policy: RollupPolicy = {
  latenessGraceMs: 120_000,
  settleDelayMs: 30_000,
  retentionMs: { contribution: 6 * HOUR, MINUTE: 3 * DAY, HOUR: 90 * DAY, DAY: 730 * DAY },
};

const identity = { sourceId: "src-a", captureSeq: 1, bucketStartMs: T0, capturedAtMs: T0 + MINUTE };

function counterSnapshot(value: number, labels = { route: "/proofs", method: "GET", status_class: "2xx" }): MetricSnapshot[] {
  return [
    {
      name: "http_requests_total",
      help: "x",
      type: "counter",
      series: [{ labels, value }],
    },
  ];
}

function histogramSnapshot(sum: number, count: number, bucketCounts: number[]): MetricSnapshot[] {
  return [
    {
      name: "http_request_duration_ms",
      help: "x",
      type: "histogram",
      buckets: [10, 100],
      series: [{ labels: { route: "/proofs", method: "GET" }, sum, count, bucketCounts }],
    },
  ];
}

function contribution(overrides: Partial<MetricContribution> = {}): MetricContribution {
  return {
    sourceId: "src-a",
    captureSeq: 1,
    metric: "http_requests_total",
    kind: "COUNTER",
    seriesKey: "method=GET,route=/proofs,status_class=2xx",
    bucketStartMs: T0,
    sum: 1,
    count: null,
    bucketCounts: null,
    capturedAtMs: T0 + MINUTE,
    ...overrides,
  };
}

describe("bucket arithmetic", () => {
  it("aligns to UTC minute, hour and day starts", () => {
    const instant = Date.parse("2030-01-02T13:45:30.500Z");
    expect(new Date(bucketStart(instant, "MINUTE")).toISOString()).toBe("2030-01-02T13:45:00.000Z");
    expect(new Date(bucketStart(instant, "HOUR")).toISOString()).toBe("2030-01-02T13:00:00.000Z");
    expect(new Date(bucketStart(instant, "DAY")).toISOString()).toBe("2030-01-02T00:00:00.000Z");
  });

  it("treats a bucket's first millisecond as inside it and its end as outside", () => {
    expect(bucketStart(T0, "MINUTE")).toBe(T0);
    expect(bucketStart(T0 + MINUTE - 1, "MINUTE")).toBe(T0);
    expect(bucketStart(T0 + MINUTE, "MINUTE")).toBe(T0 + MINUTE);
  });
});

describe("isLate", () => {
  it("accepts a contribution until exactly bucketEnd + grace, then rejects it", () => {
    const deadline = T0 + MINUTE + policy.latenessGraceMs;
    expect(isLate(T0, deadline - 1, policy)).toBe(false);
    expect(isLate(T0, deadline, policy)).toBe(true);
  });
});

describe("sealedThrough", () => {
  it("seals a minute exactly when grace and settle delay have elapsed after it", () => {
    const sealAt = T0 + MINUTE + policy.latenessGraceMs + policy.settleDelayMs;
    expect(sealedThrough("MINUTE", sealAt - 1, policy)).toBe(T0);
    expect(sealedThrough("MINUTE", sealAt, policy)).toBe(T0 + MINUTE);
  });

  it("seals an hour only once its last minute is sealed", () => {
    const sealAt = T0 + HOUR + policy.latenessGraceMs + policy.settleDelayMs;
    expect(sealedThrough("HOUR", sealAt - 1, policy)).toBe(T0);
    expect(sealedThrough("HOUR", sealAt, policy)).toBe(T0 + HOUR);
  });
});

describe("series keys", () => {
  it("is independent of label order", () => {
    expect(seriesKeyOf({ status_class: "2xx", route: "/proofs", method: "GET" })).toBe(
      seriesKeyOf({ method: "GET", route: "/proofs", status_class: "2xx" }),
    );
  });

  it("round-trips through labelsOf", () => {
    const labels = { method: "GET", route: "/proofs", status_class: "2xx" };
    expect(labelsOf(seriesKeyOf(labels))).toEqual(labels);
    expect(labelsOf("")).toEqual({});
  });

  it.each([
    ["an identifying label name", { wallet_address: "GABC" }],
    ["an unbounded label value", { route: "/proofs/abc123" }],
    ["a label outside the vocabulary", { tenant: "acme" }],
  ])("refuses %s", (_label, labels) => {
    expect(() => seriesKeyOf(labels)).toThrow(InvalidMetricLabelError);
  });

  it("re-validates stored keys on the way out", () => {
    expect(() => labelsOf("user_id=u_123")).toThrow(InvalidMetricLabelError);
  });
});

describe("deltasFromSnapshot", () => {
  it("emits the increase since the baseline and advances the baseline", () => {
    const first = deltasFromSnapshot(counterSnapshot(5), emptyBaseline(), identity);
    expect(first.contributions).toEqual([
      expect.objectContaining({ kind: "COUNTER", sum: 5, count: null, captureSeq: 1 }),
    ]);

    const second = deltasFromSnapshot(counterSnapshot(8), first.next, { ...identity, captureSeq: 2 });
    expect(second.contributions.map((c) => c.sum)).toEqual([3]);
  });

  it("emits nothing for an idle series", () => {
    const first = deltasFromSnapshot(counterSnapshot(5), emptyBaseline(), identity);
    expect(deltasFromSnapshot(counterSnapshot(5), first.next, identity).contributions).toEqual([]);
  });

  it("treats a decrease as a reset rather than a negative delta", () => {
    const first = deltasFromSnapshot(counterSnapshot(50), emptyBaseline(), identity);
    expect(deltasFromSnapshot(counterSnapshot(4), first.next, identity).contributions[0].sum).toBe(4);
  });

  it("computes histogram deltas bucket by bucket", () => {
    const first = deltasFromSnapshot(histogramSnapshot(30, 3, [1, 3, 0]), emptyBaseline(), identity);
    const second = deltasFromSnapshot(histogramSnapshot(530, 5, [1, 4, 1]), first.next, identity);
    expect(second.contributions[0]).toMatchObject({
      kind: "HISTOGRAM",
      sum: 500,
      count: 2,
      bucketCounts: [0, 1, 1],
    });
  });

  it("ignores metrics outside the SLI catalog", () => {
    const snapshot: MetricSnapshot[] = [
      { name: "ad_hoc_debug_total", help: "x", type: "counter", series: [{ labels: {}, value: 9 }] },
    ];
    expect(deltasFromSnapshot(snapshot, emptyBaseline(), identity).contributions).toEqual([]);
  });

  it("carries only the metric, bounded labels and numbers", () => {
    const [row] = deltasFromSnapshot(counterSnapshot(1), emptyBaseline(), identity).contributions;
    expect(Object.keys(row).sort()).toEqual(
      [
        "bucketCounts",
        "bucketStartMs",
        "captureSeq",
        "capturedAtMs",
        "count",
        "kind",
        "metric",
        "seriesKey",
        "sourceId",
        "sum",
      ].sort(),
    );
  });
});

describe("aggregate", () => {
  it("is independent of input order, bit for bit", () => {
    // Floating-point addition is not associative; these values expose it.
    const inputs = [0.1, 0.2, 0.3, 1e16, -1e16, 0.7].map((sum, i) =>
      contribution({ sum, captureSeq: i + 1 }),
    );
    const forward = aggregate(inputs, "MINUTE", (c) => c.bucketStartMs, contributionOrderKey);
    const reversed = aggregate([...inputs].reverse(), "MINUTE", (c) => c.bucketStartMs, contributionOrderKey);
    expect(reversed.rollups).toEqual(forward.rollups);
  });

  it("groups by metric, series and bucket", () => {
    const { rollups } = aggregate(
      [
        contribution({ sum: 1 }),
        contribution({ sum: 2, captureSeq: 2 }),
        contribution({ sum: 4, bucketStartMs: T0 + MINUTE, captureSeq: 3 }),
        contribution({ sum: 8, seriesKey: "method=POST,route=/proofs,status_class=2xx", captureSeq: 4 }),
      ],
      "MINUTE",
      (c) => c.bucketStartMs,
      contributionOrderKey,
    );
    expect(rollups.map((r) => [r.bucketStartMs - T0, r.seriesKey.slice(0, 11), r.sum, r.sampleCount])).toEqual([
      [0, "method=GET,", 3, 2],
      [0, "method=POST", 8, 1],
      [MINUTE, "method=GET,", 4, 1],
    ]);
  });

  it("weights higher tiers by the samples they absorbed", () => {
    const minutes = [3, 5].map((sampleCount, i) => ({
      tier: "MINUTE" as const,
      metric: "http_requests_total",
      kind: "COUNTER" as const,
      seriesKey: "",
      bucketStartMs: T0 + i * MINUTE,
      sum: 1,
      count: null,
      bucketCounts: null,
      sampleCount,
    }));
    const { rollups } = aggregate(minutes, "HOUR", (r) => r.bucketStartMs, (r) => String(r.bucketStartMs), (r) => r.sampleCount);
    expect(rollups).toEqual([expect.objectContaining({ tier: "HOUR", sum: 2, sampleCount: 8 })]);
  });

  it("excludes and counts inputs whose histogram shape disagrees", () => {
    const { rollups, rejected } = aggregate(
      [
        contribution({ kind: "HISTOGRAM", metric: "http_request_duration_ms", count: 1, bucketCounts: [1, 1, 0] }),
        contribution({ kind: "HISTOGRAM", metric: "http_request_duration_ms", count: 1, bucketCounts: [1, 1], captureSeq: 2 }),
      ],
      "MINUTE",
      (c) => c.bucketStartMs,
      contributionOrderKey,
    );
    expect(rejected).toBe(1);
    expect(rollups[0]).toMatchObject({ count: 1, sampleCount: 1 });
  });
});

describe("assertValidRollupPolicy", () => {
  it("accepts the documented defaults", () => {
    expect(() => assertValidRollupPolicy(policy)).not.toThrow();
  });

  it.each([
    ["contributions deleted before minutes seal", { contribution: MINUTE }],
    ["minutes deleted before hours seal", { MINUTE: HOUR }],
    ["hours deleted before days seal", { HOUR: DAY }],
    ["non-increasing retention", { HOUR: 400 * DAY, DAY: 400 * DAY }],
  ])("rejects %s", (_label, retention) => {
    expect(() =>
      assertValidRollupPolicy({ ...policy, retentionMs: { ...policy.retentionMs, ...retention } }),
    ).toThrow(RollupPolicyError);
  });

  it("rejects a negative grace", () => {
    expect(() => assertValidRollupPolicy({ ...policy, latenessGraceMs: -1 })).toThrow(RollupPolicyError);
  });
});
