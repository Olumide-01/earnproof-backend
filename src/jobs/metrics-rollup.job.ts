import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { MetricRollupService } from "../metrics/metric-rollup.service";

/**
 * Schedules operational metric downsampling (#330).
 *
 * - Capture at second 0 of every minute, so each captured interval lies inside
 *   one minute bucket.
 * - Roll up at second 30, after the capture has had time to persist.
 * - Apply retention hourly; it only ever deletes already-absorbed buckets.
 *
 * Failures are logged and never thrown: a background job must not crash the
 * service, and every step is safe to simply run again.
 */
@Injectable()
export class MetricsRollupJob {
  private readonly logger = new Logger(MetricsRollupJob.name);

  constructor(private readonly rollups: MetricRollupService) {}

  @Cron("0 * * * * *", { name: "metrics-rollup-collect", timeZone: "UTC" })
  async collect(): Promise<void> {
    await this.run("collect", () => this.rollups.collect());
  }

  @Cron("30 * * * * *", { name: "metrics-rollup-aggregate", timeZone: "UTC" })
  async aggregate(): Promise<void> {
    await this.run("aggregate", () => this.rollups.rollup());
  }

  @Cron("0 15 * * * *", { name: "metrics-rollup-retention", timeZone: "UTC" })
  async retention(): Promise<void> {
    await this.run("retention", () => this.rollups.cleanup());
  }

  private async run(step: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.error(
        `Metrics rollup ${step} failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
    }
  }
}
