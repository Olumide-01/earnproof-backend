import type { MetricContribution, MetricRollup, MetricTierValue } from "../metric-rollup";
import { MetricRollupStore } from "../metric-rollup.store";

/**
 * In-memory {@link MetricRollupStore} with the same idempotency semantics as
 * the Prisma store. Used by the unit suite to exercise replay, retry and
 * concurrent-rollup behaviour deterministically, without a database.
 */
export class InMemoryMetricRollupStore extends MetricRollupStore {
  readonly contributions = new Map<string, MetricContribution>();
  readonly rollups = new Map<string, MetricRollup>();
  readonly watermarks = new Map<MetricTierValue, number>();
  /** When set, the next insert throws after (optionally) committing. */
  failNextInsert: { afterCommit: boolean } | null = null;

  async insertContributions(rows: readonly MetricContribution[]): Promise<number> {
    const failure = this.failNextInsert;
    this.failNextInsert = null;
    if (failure && !failure.afterCommit) throw new Error("connection reset");

    let inserted = 0;
    for (const row of rows) {
      const key = `${row.sourceId}|${row.captureSeq}|${row.metric}|${row.seriesKey}`;
      if (this.contributions.has(key)) continue;
      this.contributions.set(key, structuredClone(row));
      inserted += 1;
    }
    // The write landed but the acknowledgement was lost.
    if (failure?.afterCommit) throw new Error("connection reset after commit");
    return inserted;
  }

  async listContributions(fromMs: number, toMs: number): Promise<MetricContribution[]> {
    return [...this.contributions.values()]
      .filter((row) => row.bucketStartMs >= fromMs && row.bucketStartMs < toMs)
      .map((row) => structuredClone(row));
  }

  async listRollups(
    tier: MetricTierValue,
    fromMs: number,
    toMs: number,
    metric?: string,
  ): Promise<MetricRollup[]> {
    return [...this.rollups.values()]
      .filter(
        (row) =>
          row.tier === tier &&
          row.bucketStartMs >= fromMs &&
          row.bucketStartMs < toMs &&
          (metric === undefined || row.metric === metric),
      )
      .sort(
        (a, b) =>
          a.bucketStartMs - b.bucketStartMs ||
          a.metric.localeCompare(b.metric) ||
          a.seriesKey.localeCompare(b.seriesKey),
      )
      .map((row) => structuredClone(row));
  }

  async upsertRollups(rows: readonly MetricRollup[]): Promise<void> {
    for (const row of rows) {
      this.rollups.set(
        `${row.tier}|${row.metric}|${row.seriesKey}|${row.bucketStartMs}`,
        structuredClone(row),
      );
    }
  }

  async getWatermark(tier: MetricTierValue): Promise<number | null> {
    return this.watermarks.get(tier) ?? null;
  }

  async advanceWatermark(tier: MetricTierValue, toMs: number): Promise<void> {
    const current = this.watermarks.get(tier);
    if (current === undefined || current < toMs) this.watermarks.set(tier, toMs);
  }

  async earliestContributionBucket(): Promise<number | null> {
    const starts = [...this.contributions.values()].map((row) => row.bucketStartMs);
    return starts.length ? Math.min(...starts) : null;
  }

  async earliestRollupBucket(tier: MetricTierValue): Promise<number | null> {
    const starts = [...this.rollups.values()]
      .filter((row) => row.tier === tier)
      .map((row) => row.bucketStartMs);
    return starts.length ? Math.min(...starts) : null;
  }

  async deleteContributionsBefore(bucketStartMs: number): Promise<number> {
    let deleted = 0;
    for (const [key, row] of this.contributions) {
      if (row.bucketStartMs < bucketStartMs) {
        this.contributions.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async deleteRollupsBefore(tier: MetricTierValue, bucketStartMs: number): Promise<number> {
    let deleted = 0;
    for (const [key, row] of this.rollups) {
      if (row.tier === tier && row.bucketStartMs < bucketStartMs) {
        this.rollups.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}
