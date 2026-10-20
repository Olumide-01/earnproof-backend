/**
 * CapacitySamplerJob — scheduled entry point for capacity sampling.
 *
 * Separation pattern mirrors retention.job.ts: the @Cron decorator lives here;
 * the actual work is delegated to CapacitySamplerService.
 *
 * Config-gated via CAPACITY_METRICS_ENABLED.  Default: every 5 minutes.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { CapacitySamplerService } from "../../metrics/capacity-sampler.service";

@Injectable()
export class CapacitySamplerJob {
  private readonly logger = new Logger(CapacitySamplerJob.name);

  constructor(private readonly sampler: CapacitySamplerService) {}

  @Cron(process.env["CAPACITY_SAMPLER_CRON"] ?? CronExpression.EVERY_5_MINUTES)
  async run(): Promise<void> {
    if (process.env["CAPACITY_METRICS_ENABLED"] !== "true") {
      return;
    }
    this.logger.debug("Capacity sampling tick");
    await this.sampler.sample();
  }
}