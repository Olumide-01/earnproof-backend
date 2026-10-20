import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { MetricsRegistry } from "../common/observability/metrics.registry";
import { Clock, SystemClock } from "../common/time/clock";
import {
  aggregate,
  assertValidRollupPolicy,
  bucketStart,
  CaptureBaseline,
  contributionOrderKey,
  deltasFromSnapshot,
  emptyBaseline,
  isLate,
  labelsOf,
  MAX_QUERY_SPAN_MS,
  MetricContribution,
  MetricRollup,
  MetricTier,
  MetricTierValue,
  ROLLUP_METRIC_NAMES,
  RollupPolicy,
  rollupOrderKey,
  sealedThrough,
  SOURCE_TIER,
  TIER_SIZE_MS,
} from "./metric-rollup";
import { MetricRollupStore } from "./metric-rollup.store";

/** Captures kept for retry while the store is unavailable. */
export const MAX_PENDING_CAPTURES = 10;

/**
 * Buckets one rollup run may process per tier. Bounds the work of catching up
 * after an outage; the remainder is picked up by the next run.
 */
export const MAX_BUCKETS_PER_RUN: Record<MetricTierValue, number> = {
  MINUTE: 180,
  HOUR: 48,
  DAY: 31,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface PendingCapture {
  captureSeq: number;
  bucketStartMs: number;
  contributions: MetricContribution[];
}

export interface CollectorStatus {
  enabled: boolean;
  sourceId: string;
  captureSeq: number;
  pendingCaptures: number;
  lateContributionsDropped: number;
  overflowCapturesDropped: number;
  rejectedRollupInputs: number;
  watermarks: Record<MetricTierValue, string | null>;
}

export interface RollupQuery {
  tier: MetricTierValue;
  metric: string;
  fromMs: number;
  toMs: number;
}

export interface RollupSeries {
  labels: Record<string, string>;
  points: Array<{
    bucketStart: string;
    sum: number;
    count: number | null;
    bucketCounts: number[] | null;
    sampleCount: number;
  }>;
}

/**
 * Downsamples the in-process SLI registry into minute, hour and day tiers
 * with bounded retention (earnproof-backend#330).
 *
 * Retry safety: a capture's contributions are keyed by (sourceId, captureSeq,
 * metric, series). A capture that fails to persist is retried with the *same*
 * keys — the baseline has already moved past it, so it is never recomputed —
 * and a write that landed but whose acknowledgement was lost is skipped as a
 * duplicate. Neither path can count a delta twice.
 */
@Injectable()
export class MetricRollupService implements OnModuleInit {
  private readonly logger = new Logger(MetricRollupService.name);
  private readonly policy: RollupPolicy;
  private readonly enabled: boolean;
  private readonly sourceId = randomUUID();

  private baseline: CaptureBaseline = emptyBaseline();
  private lastCaptureMs: number | null = null;
  private captureSeq = 0;
  private pending: PendingCapture[] = [];
  private lateDropped = 0;
  private overflowDropped = 0;
  private rejectedInputs = 0;

  /** Serialises collect/flush within this process. */
  private collecting: Promise<unknown> = Promise.resolve();
  private rolling: Promise<unknown> | null = null;

  constructor(
    private readonly store: MetricRollupStore,
    private readonly registry: MetricsRegistry,
    config: ConfigService,
    @Optional() private readonly clock: Clock = new SystemClock(),
  ) {
    this.enabled = config.get<boolean>("metricsRollup.enabled") ?? true;
    this.policy = resolveRollupPolicy(config);
  }

  /** Establishes the baseline, so activity before boot is never attributed to a minute. */
  onModuleInit(): void {
    this.resetBaseline();
  }

  resetBaseline(): void {
    this.baseline = deltasFromSnapshot(this.registry.snapshot(), emptyBaseline(), {
      sourceId: this.sourceId,
      captureSeq: 0,
      bucketStartMs: 0,
      capturedAtMs: 0,
    }).next;
    this.lastCaptureMs = this.clock.nowMs();
  }

  /**
   * Captures deltas since the previous capture and persists every pending
   * capture that is still on time. Runs once a minute, aligned to the minute.
   *
   * Deltas are attributed to the minute in which the captured interval
   * *began*; with minute-aligned captures the interval lies inside it.
   */
  collect(): Promise<{ captured: number; persisted: number; dropped: number }> {
    const run = this.collecting.then(() => this.collectOnce());
    this.collecting = run.catch(() => undefined);
    return run;
  }

  /**
   * Rolls up every sealed bucket, tier by tier. Single-flight in-process;
   * across replicas it is safe to run concurrently because every write is a
   * deterministic set from sealed inputs and watermarks only move forward.
   */
  rollup(): Promise<Record<MetricTierValue, number>> {
    if (this.rolling) return this.rolling as Promise<Record<MetricTierValue, number>>;
    const run = this.rollupOnce().finally(() => {
      this.rolling = null;
    });
    this.rolling = run;
    return run;
  }

  /**
   * Deletes data past its retention — but never a bucket that the tier above
   * has not yet absorbed. A stalled rollup therefore pauses cleanup instead
   * of losing data.
   */
  async cleanup(): Promise<Record<"contribution" | MetricTierValue, number>> {
    if (!this.enabled) return { contribution: 0, MINUTE: 0, HOUR: 0, DAY: 0 };
    const now = this.clock.nowMs();
    const { retentionMs } = this.policy;
    const [minuteMark, hourMark, dayMark] = await Promise.all([
      this.store.getWatermark(MetricTier.MINUTE),
      this.store.getWatermark(MetricTier.HOUR),
      this.store.getWatermark(MetricTier.DAY),
    ]);
    const guarded = (cutoff: number, absorbedThrough: number | null) =>
      absorbedThrough === null ? null : Math.min(cutoff, absorbedThrough);

    const contributionCutoff = guarded(now - retentionMs.contribution, minuteMark);
    const minuteCutoff = guarded(now - retentionMs.MINUTE, hourMark);
    const hourCutoff = guarded(now - retentionMs.HOUR, dayMark);
    const dayCutoff = now - retentionMs.DAY;

    return {
      contribution:
        contributionCutoff === null ? 0 : await this.store.deleteContributionsBefore(contributionCutoff),
      MINUTE: minuteCutoff === null ? 0 : await this.store.deleteRollupsBefore("MINUTE", minuteCutoff),
      HOUR: hourCutoff === null ? 0 : await this.store.deleteRollupsBefore("HOUR", hourCutoff),
      DAY: await this.store.deleteRollupsBefore("DAY", dayCutoff),
    };
  }

  /** Reads one metric's aggregates in a tier, grouped by label set. */
  async query(input: RollupQuery): Promise<{ tier: MetricTierValue; metric: string; series: RollupSeries[] }> {
    if (!ROLLUP_METRIC_NAMES.has(input.metric)) {
      throw new BadRequestException("Unknown metric");
    }
    if (!(input.fromMs < input.toMs)) {
      throw new BadRequestException("from must be earlier than to");
    }
    if (input.toMs - input.fromMs > MAX_QUERY_SPAN_MS[input.tier]) {
      throw new BadRequestException("Requested range is too large for this tier");
    }
    const rows = await this.store.listRollups(input.tier, input.fromMs, input.toMs, input.metric);
    const series = new Map<string, RollupSeries>();
    for (const row of rows) {
      let entry = series.get(row.seriesKey);
      if (!entry) {
        entry = { labels: labelsOf(row.seriesKey), points: [] };
        series.set(row.seriesKey, entry);
      }
      entry.points.push({
        bucketStart: new Date(row.bucketStartMs).toISOString(),
        sum: row.sum,
        count: row.count,
        bucketCounts: row.bucketCounts,
        sampleCount: row.sampleCount,
      });
    }
    return { tier: input.tier, metric: input.metric, series: [...series.values()] };
  }

  async status(): Promise<CollectorStatus> {
    const marks = await Promise.all(
      (["MINUTE", "HOUR", "DAY"] as const).map(async (tier) => {
        const value = await this.store.getWatermark(tier);
        return [tier, value === null ? null : new Date(value).toISOString()] as const;
      }),
    );
    return {
      enabled: this.enabled,
      sourceId: this.sourceId,
      captureSeq: this.captureSeq,
      pendingCaptures: this.pending.length,
      lateContributionsDropped: this.lateDropped,
      overflowCapturesDropped: this.overflowDropped,
      rejectedRollupInputs: this.rejectedInputs,
      watermarks: Object.fromEntries(marks) as Record<MetricTierValue, string | null>,
    };
  }

  private async collectOnce(): Promise<{ captured: number; persisted: number; dropped: number }> {
    if (!this.enabled) return { captured: 0, persisted: 0, dropped: 0 };
    const now = this.clock.nowMs();
    if (this.lastCaptureMs === null || now < this.lastCaptureMs) {
      // First capture, or the local clock stepped backwards: re-baseline
      // rather than attribute a delta to a minute it may not belong to.
      this.resetBaseline();
      return { captured: 0, persisted: 0, dropped: 0 };
    }

    this.captureSeq += 1;
    const bucketStartMs = bucketStart(this.lastCaptureMs, MetricTier.MINUTE);
    const { contributions, next } = deltasFromSnapshot(this.registry.snapshot(), this.baseline, {
      sourceId: this.sourceId,
      captureSeq: this.captureSeq,
      bucketStartMs,
      capturedAtMs: now,
    });
    this.baseline = next;
    this.lastCaptureMs = now;

    if (contributions.length > 0) {
      this.pending.push({ captureSeq: this.captureSeq, bucketStartMs, contributions });
    }
    while (this.pending.length > MAX_PENDING_CAPTURES) {
      this.pending.shift();
      this.overflowDropped += 1;
    }

    return { captured: contributions.length, ...(await this.flush(now)) };
  }

  private async flush(now: number): Promise<{ persisted: number; dropped: number }> {
    let persisted = 0;
    let dropped = 0;
    while (this.pending.length > 0) {
      const capture = this.pending[0];
      if (isLate(capture.bucketStartMs, now, this.policy)) {
        // Its minute may already be sealed; accepting it now would change an
        // aggregate after the fact. Dropped and counted, never merged.
        this.pending.shift();
        this.lateDropped += capture.contributions.length;
        dropped += capture.contributions.length;
        this.logger.warn(
          JSON.stringify({ event: "metrics_rollup.late_capture_dropped", contributions: capture.contributions.length }),
        );
        continue;
      }
      try {
        persisted += await this.store.insertContributions(capture.contributions);
        this.pending.shift();
      } catch (error) {
        this.logger.warn(
          `Metric contribution write failed; will retry: ${error instanceof Error ? error.name : "unknown"}`,
        );
        break;
      }
    }
    return { persisted, dropped };
  }

  private async rollupOnce(): Promise<Record<MetricTierValue, number>> {
    const result: Record<MetricTierValue, number> = { MINUTE: 0, HOUR: 0, DAY: 0 };
    if (!this.enabled) return result;
    for (const tier of ["MINUTE", "HOUR", "DAY"] as const) {
      result[tier] = await this.rollupTier(tier, this.clock.nowMs());
    }
    return result;
  }

  /** Processes sealed buckets of one tier, from its watermark forward. */
  private async rollupTier(tier: MetricTierValue, now: number): Promise<number> {
    const size = TIER_SIZE_MS[tier];
    const sourceTier = SOURCE_TIER[tier];

    // The newest bucket whose inputs are complete: sealed by time, and (for
    // hour and day) fully absorbed by the tier below.
    let limit = sealedThrough(tier, now, this.policy);
    if (sourceTier !== "CONTRIBUTION") {
      const below = await this.store.getWatermark(sourceTier);
      if (below === null) return 0;
      limit = Math.min(limit, bucketStart(below, tier));
    }

    let from = await this.store.getWatermark(tier);
    if (from === null) {
      const earliest =
        sourceTier === "CONTRIBUTION"
          ? await this.store.earliestContributionBucket()
          : await this.store.earliestRollupBucket(sourceTier);
      if (earliest === null) return 0;
      from = bucketStart(earliest, tier);
    }
    if (from >= limit) return 0;

    const to = Math.min(limit, from + MAX_BUCKETS_PER_RUN[tier] * size);
    const { rollups, rejected } =
      sourceTier === "CONTRIBUTION"
        ? aggregate(
            await this.store.listContributions(from, to),
            tier,
            (row) => row.bucketStartMs,
            contributionOrderKey,
          )
        : aggregate(
            await this.store.listRollups(sourceTier, from, to),
            tier,
            (row: MetricRollup) => row.bucketStartMs,
            rollupOrderKey,
            (row: MetricRollup) => row.sampleCount,
          );

    if (rejected > 0) {
      this.rejectedInputs += rejected;
      this.logger.warn(JSON.stringify({ event: "metrics_rollup.inputs_rejected", tier, rejected }));
    }
    await this.store.upsertRollups(rollups);
    await this.store.advanceWatermark(tier, to);
    return rollups.length;
  }
}

/** Builds the rollup policy from configuration and validates it. */
export function resolveRollupPolicy(config: ConfigService): RollupPolicy {
  const policy: RollupPolicy = {
    latenessGraceMs: config.get<number>("metricsRollup.latenessGraceMs") ?? 120_000,
    settleDelayMs: config.get<number>("metricsRollup.settleDelayMs") ?? 30_000,
    retentionMs: {
      contribution: (config.get<number>("metricsRollup.rawRetentionHours") ?? 6) * HOUR_MS,
      MINUTE: (config.get<number>("metricsRollup.minuteRetentionDays") ?? 3) * DAY_MS,
      HOUR: (config.get<number>("metricsRollup.hourRetentionDays") ?? 90) * DAY_MS,
      DAY: (config.get<number>("metricsRollup.dayRetentionDays") ?? 730) * DAY_MS,
    },
  };
  assertValidRollupPolicy(policy);
  return policy;
}
