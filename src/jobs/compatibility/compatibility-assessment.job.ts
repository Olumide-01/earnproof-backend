/**
 * CompatibilityAssessmentJob — scheduled entry point.
 *
 * Separation pattern mirrors retention.job.ts + retention-cleanup.service.ts:
 * the @Cron decorator lives here; the actual work is delegated to
 * CompatibilityAssessmentWorkerService so the worker can be unit-tested without
 * a real scheduler.
 *
 * The job picks up PENDING assessments left behind by failed executions.
 * Normal synchronous assessments are processed inline by the service layer;
 * this job is the crash-recovery path.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { CompatibilityAssessmentWorkerService } from "./compatibility-assessment-worker.service";

@Injectable()
export class CompatibilityAssessmentJob {
  private readonly logger = new Logger(CompatibilityAssessmentJob.name);

  constructor(
    private readonly worker: CompatibilityAssessmentWorkerService,
  ) {}

  /**
   * Sweep for PENDING assessments that were not executed inline (e.g. the
   * process crashed after creating the row but before executing checks).
   *
   * Default: every 5 minutes. Override via COMPAT_ASSESSMENT_CRON.
   */
  @Cron(process.env["COMPAT_ASSESSMENT_CRON"] ?? CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    this.logger.debug("Compatibility assessment sweep tick");
    await this.worker.recoverPendingAssessments();
  }
}
