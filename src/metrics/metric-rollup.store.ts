import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import type {
  MetricContribution,
  MetricKind,
  MetricRollup,
  MetricTierValue,
} from "./metric-rollup";

/**
 * Persistence port for metric rollups.
 *
 * Every write is idempotent by key, which is what makes replays and retries
 * safe: contributions are insert-if-absent on their capture identity, rollups
 * are set (never incremented) on their bucket identity, and watermarks only
 * move forward.
 */
export abstract class MetricRollupStore {
  /** Inserts contributions, skipping any whose idempotency key already exists. */
  abstract insertContributions(rows: readonly MetricContribution[]): Promise<number>;
  /** Contributions with `fromMs <= bucketStart < toMs`. */
  abstract listContributions(fromMs: number, toMs: number): Promise<MetricContribution[]>;
  /** Rollups of one tier with `fromMs <= bucketStart < toMs`, optionally one metric. */
  abstract listRollups(
    tier: MetricTierValue,
    fromMs: number,
    toMs: number,
    metric?: string,
  ): Promise<MetricRollup[]>;
  /** Sets each rollup to exactly the given values. */
  abstract upsertRollups(rows: readonly MetricRollup[]): Promise<void>;
  abstract getWatermark(tier: MetricTierValue): Promise<number | null>;
  /** Moves the tier's watermark to `toMs` only if that is later than the current one. */
  abstract advanceWatermark(tier: MetricTierValue, toMs: number): Promise<void>;
  abstract earliestContributionBucket(): Promise<number | null>;
  abstract earliestRollupBucket(tier: MetricTierValue): Promise<number | null>;
  abstract deleteContributionsBefore(bucketStartMs: number): Promise<number>;
  abstract deleteRollupsBefore(tier: MetricTierValue, bucketStartMs: number): Promise<number>;
}

@Injectable()
export class PrismaMetricRollupStore extends MetricRollupStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async insertContributions(rows: readonly MetricContribution[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await this.prisma.operationalMetricContribution.createMany({
      data: rows.map((row) => ({
        sourceId: row.sourceId,
        captureSeq: row.captureSeq,
        metric: row.metric,
        kind: row.kind,
        seriesKey: row.seriesKey,
        bucketStart: new Date(row.bucketStartMs),
        sum: row.sum,
        count: row.count,
        bucketCounts: row.bucketCounts ?? Prisma.DbNull,
        capturedAt: new Date(row.capturedAtMs),
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  async listContributions(fromMs: number, toMs: number): Promise<MetricContribution[]> {
    const rows = await this.prisma.operationalMetricContribution.findMany({
      where: { bucketStart: { gte: new Date(fromMs), lt: new Date(toMs) } },
    });
    return rows.map((row) => ({
      sourceId: row.sourceId,
      captureSeq: row.captureSeq,
      metric: row.metric,
      kind: row.kind as MetricKind,
      seriesKey: row.seriesKey,
      bucketStartMs: row.bucketStart.getTime(),
      sum: row.sum,
      count: row.count,
      bucketCounts: toCounts(row.bucketCounts),
      capturedAtMs: row.capturedAt.getTime(),
    }));
  }

  async listRollups(
    tier: MetricTierValue,
    fromMs: number,
    toMs: number,
    metric?: string,
  ): Promise<MetricRollup[]> {
    const rows = await this.prisma.operationalMetricRollup.findMany({
      where: {
        tier,
        bucketStart: { gte: new Date(fromMs), lt: new Date(toMs) },
        ...(metric ? { metric } : {}),
      },
      orderBy: [{ bucketStart: "asc" }, { metric: "asc" }, { seriesKey: "asc" }],
    });
    return rows.map((row) => ({
      tier: row.tier as MetricTierValue,
      metric: row.metric,
      kind: row.kind as MetricKind,
      seriesKey: row.seriesKey,
      bucketStartMs: row.bucketStart.getTime(),
      sum: row.sum,
      count: row.count,
      bucketCounts: toCounts(row.bucketCounts),
      sampleCount: row.sampleCount,
    }));
  }

  async upsertRollups(rows: readonly MetricRollup[]): Promise<void> {
    if (rows.length === 0) return;
    const computedAt = new Date();
    await this.prisma.$transaction(
      rows.map((row) => {
        const values = {
          kind: row.kind,
          sum: row.sum,
          count: row.count,
          bucketCounts: row.bucketCounts ?? Prisma.DbNull,
          sampleCount: row.sampleCount,
          computedAt,
        };
        return this.prisma.operationalMetricRollup.upsert({
          where: {
            tier_metric_seriesKey_bucketStart: {
              tier: row.tier,
              metric: row.metric,
              seriesKey: row.seriesKey,
              bucketStart: new Date(row.bucketStartMs),
            },
          },
          create: {
            tier: row.tier,
            metric: row.metric,
            seriesKey: row.seriesKey,
            bucketStart: new Date(row.bucketStartMs),
            ...values,
          },
          update: values,
        });
      }),
    );
  }

  async getWatermark(tier: MetricTierValue): Promise<number | null> {
    const row = await this.prisma.operationalMetricWatermark.findUnique({ where: { tier } });
    return row ? row.rolledThrough.getTime() : null;
  }

  async advanceWatermark(tier: MetricTierValue, toMs: number): Promise<void> {
    const to = new Date(toMs);
    // Conditional update first, so two replicas racing can only move it forward.
    const moved = await this.prisma.operationalMetricWatermark.updateMany({
      where: { tier, rolledThrough: { lt: to } },
      data: { rolledThrough: to },
    });
    if (moved.count > 0) return;
    try {
      await this.prisma.operationalMetricWatermark.create({ data: { tier, rolledThrough: to } });
    } catch (error) {
      // A concurrent creator won; its value is at least as far along, or the
      // next run's conditional update will advance it.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        throw error;
      }
    }
  }

  async earliestContributionBucket(): Promise<number | null> {
    const row = await this.prisma.operationalMetricContribution.findFirst({
      orderBy: { bucketStart: "asc" },
      select: { bucketStart: true },
    });
    return row ? row.bucketStart.getTime() : null;
  }

  async earliestRollupBucket(tier: MetricTierValue): Promise<number | null> {
    const row = await this.prisma.operationalMetricRollup.findFirst({
      where: { tier },
      orderBy: { bucketStart: "asc" },
      select: { bucketStart: true },
    });
    return row ? row.bucketStart.getTime() : null;
  }

  async deleteContributionsBefore(bucketStartMs: number): Promise<number> {
    const result = await this.prisma.operationalMetricContribution.deleteMany({
      where: { bucketStart: { lt: new Date(bucketStartMs) } },
    });
    return result.count;
  }

  async deleteRollupsBefore(tier: MetricTierValue, bucketStartMs: number): Promise<number> {
    const result = await this.prisma.operationalMetricRollup.deleteMany({
      where: { tier, bucketStart: { lt: new Date(bucketStartMs) } },
    });
    return result.count;
  }
}

function toCounts(value: Prisma.JsonValue | null): number[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "number")
    ? (value as number[])
    : null;
}
