import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { JobExecutionService } from "../execution/job-execution.service";
import { workerIdentity } from "../execution/worker-identity";
import { RetentionCleanupService } from "./retention-cleanup.service";
import { DistributedLeaseService } from "../distributed-lease.service";

/** Job identity recorded in the execution history for this cleanup job. */
const RETENTION_JOB_NAME = "retention-cleanup";
const RETENTION_JOB_VERSION = "1";

/**
 * Duration to hold the retention cleanup job lease (24 hours).
 * Sufficient for daily cleanup jobs; gives ample time for slow runs.
 */
const RETENTION_CLEANUP_LEASE_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Unique identifier for the retention cleanup job lease.
 * Used across all instances to coordinate single execution.
 */
const RETENTION_CLEANUP_JOB_NAME = "retention_cleanup";

/**
 * Schedules the retention sweep with distributed lease coordination.
 *
 * Kept separate from {@link RetentionCleanupService} so the sweep can be
 * exercised — and invoked manually by an operator — without a scheduler
 * attached. That separation is also what lets the service be tested against
 * pinned clocks without fighting cron.
 *
 * Defaults to a daily run outside peak hours. Retention is measured in days, so
 * running more often buys nothing and only adds database contention.
 *
 * With distributed leases, only one instance executes the sweep at a time,
 * preventing duplicate deletions and reducing database load in multi-instance deployments.
 */
@Injectable()
export class RetentionJob {
  private readonly logger = new Logger(RetentionJob.name);

  constructor(
    private readonly cleanup: RetentionCleanupService,
    /**
     * Optional so tests that construct the job with just the cleanup service
     * keep working. When present, each sweep is recorded in the durable
     * execution history (issue #201).
     */
    @Optional() private readonly executions?: JobExecutionService,
  ) {}

  @Cron(process.env.RETENTION_CLEANUP_CRON ?? CronExpression.EVERY_DAY_AT_3AM)
  async sweep(): Promise<void> {
    if (this.executions) {
      await this.executions.track(
        {
          jobName: RETENTION_JOB_NAME,
          jobVersion: RETENTION_JOB_VERSION,
          leaseOwner: workerIdentity(),
        },
        () => this.runSweep(),
      );
      return;
    }

    await this.runSweep();
  }

  private async runSweep(): Promise<void> {
    // `RETENTION_DRY_RUN=true` reports what would be removed without writing.
    // The intended workflow after a retention change: enable it, read the
    // counts, then disable it once the numbers look right.
    const dryRun = process.env.RETENTION_DRY_RUN === "true";

    const result = await this.cleanup.run({ dryRun });

    if (!leaseResult.acquired) {
      this.logger.debug(
        `Retention cleanup lease held by another instance (${leaseResult.owner}); skipping sweep`,
      );
      return;
    }

    // Counts only, per class. Never the identity of what was removed. The
    // policy version and cutoff are recorded for every run so a real run can
    // be matched to the dry run an operator reviewed.
    const cutoffs = new Map(
      (result.report?.categories ?? []).map((c) => [c.category, c.cutoff]),
    );
    if (result.report) {
      this.logger.log(
        `Retention ${result.report.mode} under policy ` +
          `${result.report.policyVersion} evaluated at ${result.report.evaluatedAt}`,
      );
    }

    for (const entry of result.results) {
      if (entry.affected === 0 && !entry.truncated) continue;

      const suffix = entry.truncated ? " (batch cap reached)" : "";
      this.logger.log(
        `${entry.key}: ${entry.affected} record(s) ` +
          `${entry.dryRun ? "eligible" : "removed"} ` +
          `(cutoff ${cutoffs.get(entry.key) ?? "unknown"})${suffix}`,
      );
    }
  }
}
