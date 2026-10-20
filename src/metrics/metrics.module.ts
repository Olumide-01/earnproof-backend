import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { Clock, SystemClock } from "../common/time/clock";
import { MetricRollupService } from "./metric-rollup.service";
import { MetricRollupStore, PrismaMetricRollupStore } from "./metric-rollup.store";
import { MetricsRollupController } from "./metrics-rollup.controller";

/**
 * Downsampled operational metrics (#330). `MetricsRegistry` comes from the
 * global ObservabilityModule and `PrismaService` from the global
 * DatabaseModule; scheduling lives in `jobs/metrics-rollup.job.ts`.
 */
@Module({
  imports: [AuthModule],
  controllers: [MetricsRollupController],
  providers: [
    MetricRollupService,
    { provide: MetricRollupStore, useClass: PrismaMetricRollupStore },
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [MetricRollupService],
})
export class MetricsModule {}
