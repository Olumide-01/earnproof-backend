import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression, Interval } from "@nestjs/schedule";
import { JobExecutionService } from "./job-execution.service";
import { workerIdentity } from "./worker-identity";

/**
 * Keeps the execution history healthy: recovers crashed executions and prunes
 * expired ones.
 *
 * Split from {@link JobExecutionService} for the same reason the retention job
 * is split from its service — the recovery and pruning *logic* must be testable
 * against pinned clocks without a scheduler attached, and the scheduler here
 * carries no logic of its own beyond choosing when to call.
 */
@Injectable()
export class JobExecutionMaintenanceJob {
  private readonly logger = new Logger(JobExecutionMaintenanceJob.name);

  /**
   * How long an execution may run before recovery presumes its worker crashed.
   * Generous: a legitimately long job must never be declared crashed out from
   * under itself, and a truly dead worker's row can wait a few extra minutes.
   */
  private static readonly STALE_AFTER_MS = 15 * 60 * 1000;

  constructor(private readonly executions: JobExecutionService) {}

  /**
   * Recovers executions orphaned by a crashed worker.
   *
   * Runs on an interval rather than a cron because crash recovery is time-
   * sensitive: a stuck-running row is invisible to overlap detection until it is
   * given a terminal outcome.
   */
  @Interval(5 * 60 * 1000)
  async recoverCrashed(): Promise<void> {
    try {
      await this.executions.recoverCrashed({
        staleAfterMs: JobExecutionMaintenanceJob.STALE_AFTER_MS,
      });
    } catch (error) {
      // Maintenance must never crash the process it maintains.
      this.logger.warn(
        `Crash recovery pass failed on ${workerIdentity()}: ${describe(error)}`,
      );
    }
  }

  /** Prunes expired execution history once a day, off-peak. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async prune(): Promise<void> {
    try {
      await this.executions.prune();
    } catch (error) {
      this.logger.warn(`Execution history prune failed: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return "UnknownError";
}
