import { Injectable, Logger } from "@nestjs/common";
import { JobExecutionOutcome, Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { categorizeJobError } from "./job-error-category";

/**
 * Durable execution history for background jobs.
 *
 * ## Why this exists
 *
 * Scheduled work — retention cleanup, anchoring, synchronization — runs
 * unattended. When a run is missed, overlaps another, or dies half way, the only
 * evidence is scattered log lines that have usually rotated away by the time
 * anyone looks. This service records one row per execution so those questions
 * have an answer: what ran, on which worker, when, and how it ended.
 *
 * ## The invariants it enforces
 *
 * - **One terminal outcome per execution.** A row starts with a null outcome
 *   (running) and is written exactly once to a terminal outcome. {@link finish}
 *   only transitions a still-running row, so a duplicate completion, or a
 *   completion racing crash-recovery, cannot overwrite a settled result.
 * - **Retries link to the original.** A retry is a *new* execution row that
 *   points at the first execution of the same logical run, so the whole chain
 *   is reconstructable from any link. `attempt` numbers the sequence.
 * - **No payloads, no secrets.** Only the job's identity, lease owner, timing,
 *   outcome, and a bounded {@link categorizeJobError} category are stored. The
 *   error *message* never is — a job error can carry a signing source, a
 *   connection string, or a subject address.
 *
 * Retention is applied separately from the business audit log: these rows are
 * operational telemetry, governed by the `job_executions` retention class, not
 * by audit-log retention.
 */
@Injectable()
export class JobExecutionService {
  private readonly logger = new Logger(JobExecutionService.name);

  /**
   * Longest a query may look back / widest a page may be. An operator endpoint
   * is not a bulk export; an unbounded query over an operational table is how a
   * diagnostics call becomes an incident of its own.
   */
  static readonly MAX_QUERY_LIMIT = 100;
  private static readonly DEFAULT_QUERY_LIMIT = 20;

  /** Default retention for execution rows, overridable by retention policy. */
  private static readonly DEFAULT_RETENTION_DAYS = 30;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` as a single tracked execution.
   *
   * This is the entry point almost every caller wants: it opens a running row,
   * runs the work, and closes the row with the right terminal outcome — success,
   * a cancellation the work signalled, or a failure whose category is derived
   * without storing the message. The original error is always re-thrown, so
   * tracking never changes what the caller sees.
   */
  async track<T>(
    descriptor: JobExecutionDescriptor,
    work: (context: JobExecutionContext) => Promise<T>,
  ): Promise<T> {
    const execution = await this.begin(descriptor);

    try {
      const result = await work({ executionId: execution.id });
      await this.finish(execution.id, JobExecutionOutcome.SUCCEEDED);
      return result;
    } catch (error) {
      const outcome =
        error instanceof JobCancelledError
          ? JobExecutionOutcome.CANCELLED
          : JobExecutionOutcome.FAILED;
      await this.finish(execution.id, outcome, categorizeJobError(error));
      throw error;
    }
  }

  /**
   * Opens a running execution row and returns it.
   *
   * Use directly only when the work cannot be expressed as a single `work`
   * callback (a long-lived worker that finishes asynchronously). Prefer
   * {@link track}, which cannot forget to call {@link finish}.
   *
   * `retentionDays` is clamped to at least one day: a zero would delete the row
   * the instant it was written, defeating the point of keeping history.
   */
  async begin(
    descriptor: JobExecutionDescriptor,
  ): Promise<{ id: string }> {
    const retentionDays = Math.max(
      1,
      descriptor.retentionDays ?? JobExecutionService.DEFAULT_RETENTION_DAYS,
    );
    const retainUntil = new Date(
      Date.now() + retentionDays * 24 * 60 * 60 * 1000,
    );

    const execution = await this.prisma.jobExecution.create({
      data: {
        jobName: descriptor.jobName,
        jobVersion: descriptor.jobVersion,
        leaseOwner: descriptor.leaseOwner,
        attempt: descriptor.attempt ?? 1,
        originalExecutionId: descriptor.originalExecutionId ?? null,
        retainUntil,
      },
      select: { id: true },
    });

    return execution;
  }

  /**
   * Records the terminal outcome of a running execution, exactly once.
   *
   * The update is guarded by `finishedAt: null`, so the *first* writer wins and
   * every later attempt is a no-op. That single guard is what upholds "one
   * logical execution has one terminal outcome" against duplicate completions
   * and against crash-recovery racing a slow-but-alive worker.
   *
   * @returns true when this call set the outcome, false when it was already
   *          terminal.
   */
  async finish(
    executionId: string,
    outcome: JobExecutionOutcome,
    errorCategory?: string,
  ): Promise<boolean> {
    const result = await this.prisma.jobExecution.updateMany({
      where: { id: executionId, finishedAt: null },
      data: {
        outcome,
        errorCategory: errorCategory ?? null,
        finishedAt: new Date(),
      },
    });

    return result.count === 1;
  }

  /**
   * Begins a retry of a finished execution, linked to the original.
   *
   * The new row's `originalExecutionId` is the *root* of the chain — the first
   * execution's own original if it had one, otherwise the first execution
   * itself — so a chain of retries stays flat and every link points at the same
   * origin rather than forming a linked list that must be walked.
   */
  async beginRetry(
    original: {
      id: string;
      originalExecutionId?: string | null;
      attempt?: number;
    },
    descriptor: Omit<
      JobExecutionDescriptor,
      "attempt" | "originalExecutionId"
    >,
  ): Promise<{ id: string }> {
    return this.begin({
      ...descriptor,
      attempt: (original.attempt ?? 1) + 1,
      originalExecutionId: original.originalExecutionId ?? original.id,
    });
  }

  /**
   * Marks executions abandoned by a dead worker as CRASHED.
   *
   * A worker that dies mid-run leaves its row running forever. Any row that has
   * been running longer than `staleAfterMs` is presumed orphaned and given a
   * terminal CRASHED outcome — bounded to `MAX_QUERY_LIMIT` per pass so recovery
   * itself stays a cheap, non-locking operation. The same `finishedAt: null`
   * guard used by {@link finish} means a worker that is merely slow, not dead,
   * still wins if it completes first.
   *
   * @returns the number of executions recovered.
   */
  async recoverCrashed(options: {
    staleAfterMs: number;
    now?: Date;
  }): Promise<number> {
    const now = options.now ?? new Date();
    const threshold = new Date(now.getTime() - options.staleAfterMs);

    const stale = await this.prisma.jobExecution.findMany({
      where: { finishedAt: null, startedAt: { lt: threshold } },
      select: { id: true },
      take: JobExecutionService.MAX_QUERY_LIMIT,
    });

    let recovered = 0;
    for (const { id } of stale) {
      if (await this.finish(id, JobExecutionOutcome.CRASHED, "crash_recovery")) {
        recovered += 1;
      }
    }

    if (recovered > 0) {
      this.logger.warn(`Recovered ${recovered} crashed job execution(s)`);
    }
    return recovered;
  }

  /**
   * Bounded operator query over recent executions.
   *
   * Every knob is capped: `limit` cannot exceed {@link MAX_QUERY_LIMIT}, and the
   * result is ordered newest-first on an indexed column. This is the read side
   * an operator uses to see "did the anchoring job run in the last hour, and how
   * did it end?" without a bulk export.
   */
  async listRecent(query: JobExecutionQuery = {}): Promise<RecentExecution[]> {
    const take = Math.min(
      Math.max(1, query.limit ?? JobExecutionService.DEFAULT_QUERY_LIMIT),
      JobExecutionService.MAX_QUERY_LIMIT,
    );

    const where: Prisma.JobExecutionWhereInput = {};
    if (query.jobName) where.jobName = query.jobName;
    if (query.outcome) where.outcome = query.outcome;
    if (query.onlyRunning) where.finishedAt = null;

    const rows = await this.prisma.jobExecution.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take,
      select: {
        id: true,
        jobName: true,
        jobVersion: true,
        leaseOwner: true,
        attempt: true,
        startedAt: true,
        finishedAt: true,
        outcome: true,
        errorCategory: true,
        originalExecutionId: true,
      },
    });

    return rows.map((row) => ({
      ...row,
      durationMs:
        row.finishedAt !== null
          ? row.finishedAt.getTime() - row.startedAt.getTime()
          : null,
    }));
  }

  /**
   * Removes executions whose retention window has closed.
   *
   * Retention is applied here, on this table alone, independent of the business
   * audit log: execution history is operational telemetry with its own, usually
   * shorter, lifetime, and coupling the two would force one to inherit the
   * other's duration. Each row already carries an absolute `retainUntil` set at
   * write time, so pruning is a single indexed range delete — no per-row
   * duration arithmetic, and safe to interrupt because the same rows stay
   * eligible next run.
   *
   * Deletes at most `maxRows` per call so a large backlog drains over several
   * runs instead of taking a long lock in one.
   *
   * @returns the number of rows removed.
   */
  async prune(options: { now?: Date; maxRows?: number } = {}): Promise<number> {
    const now = options.now ?? new Date();
    const take = Math.min(
      Math.max(1, options.maxRows ?? 1_000),
      10_000,
    );

    const expired = await this.prisma.jobExecution.findMany({
      where: { retainUntil: { lt: now } },
      select: { id: true },
      orderBy: { retainUntil: "asc" },
      take,
    });

    if (expired.length === 0) return 0;

    const result = await this.prisma.jobExecution.deleteMany({
      where: { id: { in: expired.map((row) => row.id) } },
    });

    this.logger.log(`Pruned ${result.count} expired job execution record(s)`);
    return result.count;
  }
}

/** Identity and lease of one execution. */
export interface JobExecutionDescriptor {
  jobName: string;
  jobVersion: string;
  leaseOwner: string;
  attempt?: number;
  originalExecutionId?: string | null;
  retentionDays?: number;
}

/** Handed to a tracked `work` callback so it can correlate its own logs. */
export interface JobExecutionContext {
  executionId: string;
}

export interface JobExecutionQuery {
  jobName?: string;
  outcome?: JobExecutionOutcome;
  onlyRunning?: boolean;
  limit?: number;
}

/** One row of the operator query, with a derived duration. */
export interface RecentExecution {
  id: string;
  jobName: string;
  jobVersion: string;
  leaseOwner: string;
  attempt: number;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: JobExecutionOutcome | null;
  errorCategory: string | null;
  originalExecutionId: string | null;
  durationMs: number | null;
}

/**
 * Thrown by tracked work to record a CANCELLED outcome rather than a FAILED one.
 *
 * A cancellation is a deliberate stop — a shutdown drain, an operator abort —
 * not a fault, and conflating the two would make a clean shutdown look like a
 * job failure on every dashboard.
 */
export class JobCancelledError extends Error {
  constructor(message = "Job execution was cancelled") {
    super(message);
    this.name = "JobCancelledError";
  }
}
