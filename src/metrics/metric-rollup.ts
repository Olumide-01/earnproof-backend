import {
  assertValidLabels,
  type MetricLabels,
} from "../common/observability/metric-labels";
import { METRIC_NAMES } from "../common/observability/metrics.catalog";
import type { MetricSnapshot } from "../common/observability/metrics.registry";

/**
 * Downsampled operational metrics with retention tiers (earnproof-backend#330).
 *
 * Long-term charts need minute, hour and day aggregates without keeping raw
 * events. The pipeline is:
 *
 *   MetricsRegistry (cumulative, in memory)
 *     → capture: per-series delta since the previous capture  ("contribution")
 *     → minute rollup: sum of contributions in a sealed minute
 *     → hour rollup:   sum of sealed minute rollups
 *     → day rollup:    sum of sealed hour rollups
 *
 * Everything in this file is pure and deterministic. Persistence, scheduling
 * and the clock live in the service.
 *
 * Privacy: inputs are registry series, whose label names *and* values are
 * already restricted to the closed vocabulary in `metric-labels.ts`. Nothing
 * here accepts a request payload, an identifier, or free text — labels are
 * re-validated on the way in as defence in depth.
 */

export const MetricTier = {
  MINUTE: "MINUTE",
  HOUR: "HOUR",
  DAY: "DAY",
} as const;
export type MetricTierValue = (typeof MetricTier)[keyof typeof MetricTier];

export const TIER_SIZE_MS: Record<MetricTierValue, number> = {
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
};

/** The tier each tier is rolled up from. Minutes come from contributions. */
export const SOURCE_TIER: Record<MetricTierValue, MetricTierValue | "CONTRIBUTION"> = {
  MINUTE: "CONTRIBUTION",
  HOUR: "MINUTE",
  DAY: "HOUR",
};

export type MetricKind = "COUNTER" | "HISTOGRAM";

/** Metric names that may be downsampled: exactly the SLI catalog. */
export const ROLLUP_METRIC_NAMES: ReadonlySet<string> = new Set(Object.values(METRIC_NAMES));

/** One per-series delta captured from the registry. */
export interface MetricContribution {
  /** Random per-process identity. Never a hostname, user or tenant. */
  sourceId: string;
  /** Monotonic capture number within the source; with sourceId, the idempotency key. */
  captureSeq: number;
  metric: string;
  kind: MetricKind;
  seriesKey: string;
  /** Start of the minute bucket the delta is attributed to (epoch ms). */
  bucketStartMs: number;
  /** Counter increments, or histogram observation sum. */
  sum: number;
  /** Histogram observation count; null for counters. */
  count: number | null;
  /** Histogram cumulative bucket count deltas (+Inf last); null for counters. */
  bucketCounts: number[] | null;
  capturedAtMs: number;
}

/** One aggregate in a tier. */
export interface MetricRollup {
  tier: MetricTierValue;
  metric: string;
  kind: MetricKind;
  seriesKey: string;
  bucketStartMs: number;
  sum: number;
  count: number | null;
  bucketCounts: number[] | null;
  /** Inputs folded into this aggregate (contributions or lower-tier buckets). */
  sampleCount: number;
}

/** Timing and retention policy. All durations in milliseconds. */
export interface RollupPolicy {
  /** How long after a minute ends a contribution for it is still accepted. */
  latenessGraceMs: number;
  /**
   * Extra wait after the lateness grace before a bucket is rolled up. Absorbs
   * in-flight writes and bounded clock skew between replicas.
   */
  settleDelayMs: number;
  retentionMs: {
    contribution: number;
    MINUTE: number;
    HOUR: number;
    DAY: number;
  };
}

export class RollupPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RollupPolicyError";
  }
}

/** Rejects a policy under which a tier could be deleted before it is rolled up. */
export function assertValidRollupPolicy(policy: RollupPolicy): void {
  const { latenessGraceMs, settleDelayMs, retentionMs } = policy;
  for (const [name, value] of Object.entries({ latenessGraceMs, settleDelayMs, ...retentionMs })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RollupPolicyError(`${name} must be a non-negative finite number`);
    }
  }
  const horizon = latenessGraceMs + settleDelayMs;
  // Each tier must outlive the time it takes for the tier above to seal.
  const mustExceed: Array<[string, number, number]> = [
    ["contribution", retentionMs.contribution, TIER_SIZE_MS.MINUTE + horizon],
    ["MINUTE", retentionMs.MINUTE, TIER_SIZE_MS.HOUR + horizon],
    ["HOUR", retentionMs.HOUR, TIER_SIZE_MS.DAY + horizon],
  ];
  for (const [name, retention, minimum] of mustExceed) {
    if (retention <= minimum) {
      throw new RollupPolicyError(`${name} retention must exceed the next tier's sealing horizon`);
    }
  }
  if (
    !(
      retentionMs.contribution < retentionMs.MINUTE &&
      retentionMs.MINUTE < retentionMs.HOUR &&
      retentionMs.HOUR < retentionMs.DAY
    )
  ) {
    throw new RollupPolicyError("retention must increase strictly from contribution to day");
  }
}

/** Start of the UTC bucket containing `ms`. */
export function bucketStart(ms: number, tier: MetricTierValue): number {
  const size = TIER_SIZE_MS[tier];
  return Math.floor(ms / size) * size;
}

/**
 * Late-sample policy for one contribution.
 *
 * Exact boundary: a contribution is accepted while `now < bucketEnd + grace`
 * and rejected from `now == bucketEnd + grace` onwards. Because rejection
 * starts strictly before rollup (which also waits `settleDelayMs`), a sealed
 * minute's inputs can never change after it is aggregated.
 */
export function isLate(bucketStartMs: number, nowMs: number, policy: Pick<RollupPolicy, "latenessGraceMs">): boolean {
  return nowMs >= bucketStartMs + TIER_SIZE_MS.MINUTE + policy.latenessGraceMs;
}

/**
 * The exclusive end of the newest bucket in `tier` that is sealed at `nowMs`.
 *
 * A bucket is sealed once every minute inside it is past the lateness grace
 * plus the settle delay.
 */
export function sealedThrough(
  tier: MetricTierValue,
  nowMs: number,
  policy: Pick<RollupPolicy, "latenessGraceMs" | "settleDelayMs">,
): number {
  const horizon = nowMs - policy.latenessGraceMs - policy.settleDelayMs;
  return bucketStart(horizon, tier);
}

/** Canonical, order-independent key for a validated label set. */
export function seriesKeyOf(labels: MetricLabels | Record<string, string> | undefined): string {
  const entries = Object.entries(labels ?? {});
  // Throws InvalidMetricLabelError for anything outside the vocabulary.
  assertValidLabels(Object.fromEntries(entries) as Record<string, string>);
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join(",");
}

/** Parses a series key back into labels, re-validating every pair. */
export function labelsOf(seriesKey: string): Record<string, string> {
  if (seriesKey === "") return {};
  const labels = Object.fromEntries(
    seriesKey.split(",").map((pair) => {
      const index = pair.indexOf("=");
      return [pair.slice(0, index), pair.slice(index + 1)];
    }),
  );
  assertValidLabels(labels);
  return labels;
}

/** Cumulative series state carried between captures. */
export interface CaptureBaseline {
  counters: Map<string, number>;
  histograms: Map<string, { sum: number; count: number; bucketCounts: number[] }>;
}

export function emptyBaseline(): CaptureBaseline {
  return { counters: new Map(), histograms: new Map() };
}

/**
 * Turns a registry snapshot into per-series deltas against `baseline`.
 *
 * A series whose cumulative value went *down* was reset (process restart,
 * registry reset); its delta is its current value, never a negative number.
 * Series with no change produce nothing, so idle series cost no storage.
 */
export function deltasFromSnapshot(
  snapshot: readonly MetricSnapshot[],
  baseline: CaptureBaseline,
  identity: { sourceId: string; captureSeq: number; bucketStartMs: number; capturedAtMs: number },
): { contributions: MetricContribution[]; next: CaptureBaseline } {
  const next = emptyBaseline();
  const contributions: MetricContribution[] = [];

  for (const metric of snapshot) {
    if (!ROLLUP_METRIC_NAMES.has(metric.name)) continue;

    for (const series of metric.series) {
      const seriesKey = seriesKeyOf(series.labels);
      const id = `${metric.name}|${seriesKey}`;

      if (metric.type === "counter") {
        const value = (series as { value: number }).value;
        next.counters.set(id, value);
        const previous = baseline.counters.get(id) ?? 0;
        const delta = value >= previous ? value - previous : value;
        if (delta > 0) {
          contributions.push({
            ...identity,
            metric: metric.name,
            kind: "COUNTER",
            seriesKey,
            sum: delta,
            count: null,
            bucketCounts: null,
          });
        }
        continue;
      }

      const histogram = series as { sum: number; count: number; bucketCounts: readonly number[] };
      const current = {
        sum: histogram.sum,
        count: histogram.count,
        bucketCounts: [...histogram.bucketCounts],
      };
      next.histograms.set(id, current);
      const previous = baseline.histograms.get(id);
      const reset =
        !previous ||
        current.count < previous.count ||
        previous.bucketCounts.length !== current.bucketCounts.length;
      const delta = reset
        ? current
        : {
            sum: current.sum - previous.sum,
            count: current.count - previous.count,
            bucketCounts: current.bucketCounts.map((value, i) => value - previous.bucketCounts[i]),
          };
      if (delta.count > 0) {
        contributions.push({
          ...identity,
          metric: metric.name,
          kind: "HISTOGRAM",
          seriesKey,
          sum: delta.sum,
          count: delta.count,
          bucketCounts: delta.bucketCounts,
        });
      }
    }
  }

  return { contributions, next };
}

interface Aggregatable {
  metric: string;
  kind: MetricKind;
  seriesKey: string;
  sum: number;
  count: number | null;
  bucketCounts: number[] | null;
}

/**
 * Folds inputs into one aggregate per (metric, series, bucket) of `tier`.
 *
 * Deterministic regardless of input order: inputs are sorted by `orderKey`
 * before summing, because floating-point addition is not associative and two
 * replicas must compute bit-identical values for the same sealed bucket.
 * Inputs whose histogram shape disagrees with the first input of their group
 * are excluded and counted, never silently merged.
 */
export function aggregate<T extends Aggregatable>(
  inputs: readonly T[],
  tier: MetricTierValue,
  bucketOf: (input: T) => number,
  orderKey: (input: T) => string,
  weightOf: (input: T) => number = () => 1,
): { rollups: MetricRollup[]; rejected: number } {
  const sorted = [...inputs].sort((a, b) => {
    const ka = orderKey(a);
    const kb = orderKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const groups = new Map<string, MetricRollup>();
  let rejected = 0;

  for (const input of sorted) {
    const start = bucketStart(bucketOf(input), tier);
    const key = `${input.metric}|${input.seriesKey}|${start}`;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        tier,
        metric: input.metric,
        kind: input.kind,
        seriesKey: input.seriesKey,
        bucketStartMs: start,
        sum: input.sum,
        count: input.count,
        bucketCounts: input.bucketCounts ? [...input.bucketCounts] : null,
        sampleCount: weightOf(input),
      });
      continue;
    }

    if (
      existing.kind !== input.kind ||
      (existing.bucketCounts?.length ?? -1) !== (input.bucketCounts?.length ?? -1)
    ) {
      rejected += 1;
      continue;
    }

    existing.sum += input.sum;
    existing.sampleCount += weightOf(input);
    if (existing.count !== null && input.count !== null) existing.count += input.count;
    if (existing.bucketCounts && input.bucketCounts) {
      for (let i = 0; i < existing.bucketCounts.length; i += 1) {
        existing.bucketCounts[i] += input.bucketCounts[i];
      }
    }
  }

  const rollups = [...groups.values()].sort((a, b) =>
    a.bucketStartMs - b.bucketStartMs ||
    (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0) ||
    (a.seriesKey < b.seriesKey ? -1 : a.seriesKey > b.seriesKey ? 1 : 0),
  );
  return { rollups, rejected };
}

/** Stable ordering key for contributions: the idempotency key itself. */
export function contributionOrderKey(contribution: MetricContribution): string {
  return `${contribution.sourceId}|${String(contribution.captureSeq).padStart(12, "0")}|${contribution.metric}|${contribution.seriesKey}`;
}

/** Stable ordering key for lower-tier rollups. */
export function rollupOrderKey(rollup: MetricRollup): string {
  return `${String(rollup.bucketStartMs).padStart(16, "0")}|${rollup.metric}|${rollup.seriesKey}`;
}

/** Maximum query span per tier, bounding response size. */
export const MAX_QUERY_SPAN_MS: Record<MetricTierValue, number> = {
  MINUTE: 86_400_000,
  HOUR: 31 * 86_400_000,
  DAY: 731 * 86_400_000,
};
