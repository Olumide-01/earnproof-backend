import { Injectable, Logger, Optional } from "@nestjs/common";
import {
  auditLogHoldExclusion,
  holdsInEffectWhere,
  MAX_HOLDS_IN_EFFECT,
  type HoldCoverage,
} from "../../audit/legal-holds/legal-hold-scope";
import { Clock, SystemClock } from "../../common/time/clock";
import { PrismaService } from "../../database/prisma.service";
import {
  cutoffFor,
  DisposalMethod,
  RetentionConfigError,
  retentionPolicyVersion,
  SWEEPABLE_CLASSES,
  SweepMode,
  type RetentionClass,
} from "./retention-policy";
import {
  boundOrganizationCounts,
  compareWithPlan,
  DEFAULT_MAX_PLAN_AGE_MS,
  type CategoryImpact,
  type PlanComparison,
  type RetentionImpactReport,
} from "./retention-report";

/**
 * Bounded, resumable cleanup of expired operational records.
 *
 * Three properties shape the implementation:
 *
 * **Bounded.** Every pass deletes at most {@link BATCH_SIZE} rows, selected by
 * an indexed cutoff column. An unbounded `deleteMany` on a large table takes
 * locks for as long as it runs, which turns a routine sweep into a database
 * incident — exactly the failure the anchoring worker's batching already avoids.
 *
 * **Resumable.** Progress is the deletion itself. There is no cursor to persist:
 * a run that dies halfway leaves fewer eligible rows, and the next run continues
 * from wherever it stopped. This is what makes a crash mid-sweep uninteresting.
 *
 * **Coordinated.** An in-process guard prevents a slow run from overlapping the
 * next scheduled tick. Multi-instance coordination requires a shared lock and is
 * called out in `docs/data-retention.md` as a deliberate limitation rather than
 * left as an assumption.
 *
 * **Previewable.** A dry run walks exactly the pages a real run would delete —
 * same filter, same order, same page size, same batch cap — and writes nothing.
 * Both modes go through `selectPage`, so under a fixed clock and unchanged data
 * they select the same rows by construction, not by two query builders
 * happening to agree.
 *
 * **Held.** Audit records covered by a legal hold in effect at the evaluation
 * instant are excluded from both the selection and the delete statement (#311).
 * Holds are re-read before every select and again before every delete, so a
 * hold committed mid-sweep protects the next statement. If the holds cannot be
 * read, or more than {@link MAX_HOLDS_IN_EFFECT} are in effect, audit cleanup
 * fails closed for that run instead of deleting with an incomplete hold list.
 */

/** Rows removed per statement. Small enough to keep lock duration short. */
const BATCH_SIZE = 500;

/**
 * Maximum batches per class per run.
 *
 * Caps the work one tick can do, so a large backlog drains over several runs
 * instead of monopolising the database in one. The remainder is reported rather
 * than silently dropped.
 */
const MAX_BATCHES_PER_RUN = 20;

/** Outcome of sweeping one retention class. */
export interface ClassSweepResult {
  /** Retention class key. */
  key: string;
  /** Rows removed or anonymised. A count only — never record content. */
  affected: number;
  /** Batches executed. */
  batches: number;
  /** True when the batch cap was hit and eligible rows remain. */
  truncated: boolean;
  /** True when nothing was written because this was a dry run. */
  dryRun: boolean;
}

/** Outcome of one complete run. */
export interface RetentionRunResult {
  results: ClassSweepResult[];
  /** Total rows affected across all classes. */
  totalAffected: number;
  /** True when another run was already in progress and this one yielded. */
  skipped: boolean;
  /**
   * Impact report: policy version, cutoffs, and bounded per-organization counts
   * by category. Absent only on a skipped run, which evaluated nothing.
   */
  report?: RetentionImpactReport;
  /** Present when the run executed against a dry-run plan. */
  planComparison?: PlanComparison;
}

/** Options for a single run. */
export interface RetentionRunOptions {
  /**
   * Report what would be removed without writing.
   *
   * The mechanism an operator uses to check a retention change before it
   * destroys anything.
   */
  dryRun?: boolean;
  /** Restrict the run to specific class keys. Defaults to all sweepable classes. */
  only?: readonly string[];
  /** Injected clock, so cutoff boundaries can be pinned in tests. */
  now?: Date;
  /**
   * A recent dry-run report to execute against.
   *
   * The run reuses the plan's evaluation instant and categories, so it selects
   * the rows that were reviewed rather than whatever a later "now" makes
   * eligible, and the result carries a {@link PlanComparison}. A plan that is
   * not a dry run, was made under a different policy version, or is older than
   * {@link maxPlanAgeMs} is refused: executing it would delete on the strength
   * of a review that no longer describes the policy or the data.
   */
  plan?: RetentionImpactReport;
  /** Maximum plan age accepted with {@link plan}. */
  maxPlanAgeMs?: number;
}

/** Raised when a supplied dry-run plan cannot be executed. */
export class RetentionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionPlanError";
  }
}

/** One selected row: its id and, where the model is tenant-scoped, its org. */
interface SelectedRow {
  id: string;
  organizationId: string | null;
}

@Injectable()
export class RetentionCleanupService {
  private readonly logger = new Logger(RetentionCleanupService.name);

  /**
   * In-process single-run guard.
   *
   * A sweep that outlives its interval must not overlap the next tick: two
   * concurrent runs would contend for the same rows and double the lock
   * pressure the batching exists to avoid.
   */
  private running = false;

  /** The most recent dry-run report, kept so an execution can be compared to it. */
  private lastPlan: RetentionImpactReport | undefined;

  constructor(
    private readonly prisma: PrismaService,
    // Not provided by JobsModule; defaults to the system clock exactly as
    // SessionService does. Tests pass a FixedClock (test/time/fixed-clock.ts).
    @Optional() private readonly clock: Clock = new SystemClock(),
  ) {}

  /** The most recent dry-run report produced by this instance, if any. */
  get latestPlan(): RetentionImpactReport | undefined {
    return this.lastPlan;
  }

  /** True while a run is in progress. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Sweeps every eligible retention class.
   *
   * Returns `skipped: true` rather than queueing or throwing when a run is
   * already in progress. Cleanup is idempotent and scheduled; a skipped tick
   * costs nothing, whereas a queued one would compound the overload that made
   * the first run slow.
   */
  async run(options: RetentionRunOptions = {}): Promise<RetentionRunResult> {
    if (this.running) {
      this.logger.warn(
        "Retention cleanup already in progress; skipping this run",
      );
      return { results: [], totalAffected: 0, skipped: true };
    }

    this.running = true;

    try {
      const dryRun = options.dryRun ?? false;
      const policyVersion = retentionPolicyVersion();

      if (options.plan) {
        this.assertExecutablePlan(options, policyVersion);
      }

      const now =
        options.now ??
        (options.plan ? new Date(options.plan.evaluatedAt) : this.clock.now());
      const selected = this.selectClasses(
        options.only ?? options.plan?.categories.map((c) => c.category),
      );
      const results: ClassSweepResult[] = [];
      const categories: CategoryImpact[] = [];

      for (const entry of selected) {
        // One class failing must not abandon the rest. A misconfigured
        // duration on webhook deliveries should not stop challenges from
        // being swept.
        try {
          const outcome = await this.sweepClass(entry, now, dryRun);
          results.push(outcome.result);
          categories.push(outcome.impact);
        } catch (error) {
          this.logger.error(
            `Retention sweep failed for ${entry.key}: ${describe(error)}`,
          );
          results.push({
            key: entry.key,
            affected: 0,
            batches: 0,
            truncated: false,
            dryRun,
          });
          categories.push(failedImpact(entry, now));
        }
      }

      const totalAffected = results.reduce(
        (sum, result) => sum + result.affected,
        0,
      );

      const report: RetentionImpactReport = {
        mode: dryRun ? "dry_run" : "execute",
        policyVersion,
        evaluatedAt: now.toISOString(),
        categories,
        totals: {
          selected: categories.reduce((sum, c) => sum + c.selected, 0),
          affected: categories.reduce((sum, c) => sum + c.affected, 0),
        },
      };

      if (dryRun) this.lastPlan = report;

      // Counts only. What was deleted is never logged.
      this.logger.log(
        `Retention cleanup ${dryRun ? "(dry run) " : ""}` +
          `affected ${totalAffected} record(s) across ${results.length} class(es) ` +
          `[policy ${policyVersion}, evaluated at ${report.evaluatedAt}]`,
      );

      const planComparison = options.plan
        ? compareWithPlan(options.plan, report, {
            maxPlanAgeMs: options.maxPlanAgeMs,
          })
        : undefined;

      return {
        results,
        totalAffected,
        skipped: false,
        report,
        ...(planComparison ? { planComparison } : {}),
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Refuses a plan that would make an execution delete on the strength of a
   * review that no longer applies. Checked before anything is selected.
   */
  private assertExecutablePlan(
    options: RetentionRunOptions,
    policyVersion: string,
  ): void {
    const plan = options.plan as RetentionImpactReport;

    if (options.dryRun) {
      throw new RetentionPlanError("A plan can only be supplied to an execution.");
    }
    if (plan.mode !== "dry_run") {
      throw new RetentionPlanError("The supplied plan is not a dry-run report.");
    }
    if (plan.policyVersion !== policyVersion) {
      throw new RetentionPlanError(
        `The plan was made under policy ${plan.policyVersion}, but ` +
          `${policyVersion} is in force. Run a new dry run.`,
      );
    }

    const planTime = Date.parse(plan.evaluatedAt);
    const age = this.clock.nowMs() - planTime;
    const maxAge = options.maxPlanAgeMs ?? DEFAULT_MAX_PLAN_AGE_MS;

    if (!Number.isFinite(planTime) || age < 0 || age > maxAge) {
      throw new RetentionPlanError(
        "The plan is stale or from the future. Run a new dry run.",
      );
    }
  }

  /**
   * Sweeps one class in bounded batches until it is drained or capped.
   *
   * A dry run pages through the same selection a real run would delete, using
   * `skip` where the real run relies on the previous page having been removed.
   * It never calls a write method.
   */
  private async sweepClass(
    entry: RetentionClass,
    now: Date,
    dryRun: boolean,
  ): Promise<{ result: ClassSweepResult; impact: CategoryImpact }> {
    this.assertSweepable(entry);

    const cutoff = cutoffFor(entry, now);
    const delegate = this.delegateFor(entry);
    const tally = new Map<string | null, number>();

    let selected = 0;
    let affected = 0;
    let batches = 0;
    let drained = false;

    while (batches < MAX_BATCHES_PER_RUN) {
      // Select ids first, then act on exactly those. Selecting by id keeps each
      // write statement small and makes the operation safe to interrupt: a
      // crash between selection and deletion loses nothing, because the same
      // rows remain eligible next run.
      const page = await this.selectPage(
        entry,
        delegate,
        cutoff,
        dryRun ? selected : 0,
        await this.holdExclusion(entry, now),
      );

      if (page.length === 0) {
        drained = true;
        break;
      }

      if (!dryRun) {
        const ids = page.map((row) => row.id);
        // The exclusion is applied again so a hold that committed after the
        // select still protects its records from this statement.
        const result = await delegate.deleteMany({
          where: { id: { in: ids }, ...(await this.holdExclusion(entry, now)) },
        });
        affected += result.count;
      }

      // Tallied after a successful delete, so a failed batch is not reported
      // as selected work that happened.
      for (const row of page) {
        tally.set(row.organizationId, (tally.get(row.organizationId) ?? 0) + 1);
      }
      selected += page.length;
      // In a dry run, the batch the real run would have executed.
      batches += 1;

      // A short batch means the eligible set is drained.
      if (page.length < BATCH_SIZE) {
        drained = true;
        break;
      }
    }

    // When the cap is reached exactly on a full page, a real run cannot know
    // whether rows remain without another query; neither can the preview, so
    // both report truncation identically.
    const truncated = !drained;

    if (truncated && !dryRun) {
      // The cap was reached with rows still eligible. Reported, never silent:
      // a truncated sweep that looked complete would let a backlog grow unseen.
      this.logger.warn(
        `Retention sweep for ${entry.key} hit the ${MAX_BATCHES_PER_RUN}-batch cap ` +
          `after ${affected} record(s); remaining rows will be swept next run`,
      );
    }

    return {
      result: {
        key: entry.key,
        // In a dry run, "affected" has always meant "would be affected".
        affected: dryRun ? selected : affected,
        batches: dryRun ? 0 : batches,
        truncated,
        dryRun,
      },
      impact: {
        category: entry.key,
        cutoff: cutoff.toISOString(),
        cutoffColumn: entry.cutoffColumn,
        selected,
        affected: dryRun ? 0 : affected,
        truncated,
        failed: false,
        ...boundOrganizationCounts(tally),
      },
    };
  }

  /**
   * The single selection query shared by dry runs and executions.
   *
   * Ordered by the cutoff column with `id` as a tiebreaker, so the order is
   * total: without it, rows sharing a timestamp could be paged differently by a
   * dry run (which skips) and an execution (which deletes), and the two would
   * no longer be guaranteed to select the same rows.
   */
  private async selectPage(
    entry: RetentionClass,
    delegate: PrismaDelegate,
    cutoff: Date,
    skip: number,
    exclusion: Record<string, unknown> = {},
  ): Promise<SelectedRow[]> {
    const rows = await delegate.findMany({
      where: { ...this.eligibilityFilter(entry, cutoff), ...exclusion },
      select: selectionFor(entry),
      orderBy: [{ [entry.cutoffColumn]: "asc" }, { id: "asc" }],
      take: BATCH_SIZE,
      ...(skip > 0 ? { skip } : {}),
    });

    return rows.map((row) => ({
      id: row.id,
      organizationId: organizationOf(entry, row),
    }));
  }

  /**
   * Eligibility filter for a class.
   *
   * Every filter is anchored on an indexed cutoff column, so the scan stays
   * bounded. Classes with additional conditions declare them here rather than
   * relying on the caller to remember — the failed-anchoring class in
   * particular must never match a pending or confirmed intent.
   */
  private eligibilityFilter(
    entry: RetentionClass,
    cutoff: Date,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      [entry.cutoffColumn]: { lt: cutoff },
    };

    if (entry.key === "failed_anchoring_intents") {
      // Only permanently-failed intents. Anchoring state for pending and
      // confirmed work is preserved; sweeping a confirmed intent would discard
      // the transaction hash linking a proof to the ledger.
      base.status = "FAILED";
      base.permanentError = true;
    }

    if (entry.key === "auth_sessions") {
      // A session that has been rotated is still referenced by its successor.
      // Deleting it would break the rotation chain, so only unreferenced
      // sessions are eligible.
      base.rotatedToId = null;
    }

    return base;
  }

  /**
   * Where-clause fragment excluding legally held records. Only audit logs can
   * be held; every other class gets an empty fragment and an unchanged query.
   */
  private async holdExclusion(
    entry: RetentionClass,
    now: Date,
  ): Promise<Record<string, unknown>> {
    if (entry.key !== "audit_logs") return {};

    const holds: HoldCoverage[] = await this.prisma.auditLegalHold.findMany({
      where: holdsInEffectWhere(now),
      select: { scope: true, organizationId: true, rangeStart: true, rangeEnd: true },
      take: MAX_HOLDS_IN_EFFECT + 1,
    });

    if (holds.length > MAX_HOLDS_IN_EFFECT) {
      throw new RetentionConfigError(
        `More than ${MAX_HOLDS_IN_EFFECT} legal holds are in effect; audit cleanup ` +
          "is skipped rather than run with a truncated hold list.",
      );
    }

    return auditLogHoldExclusion(holds);
  }

  /**
   * Guards against a preserved class reaching the sweep.
   *
   * `SWEEPABLE_CLASSES` already excludes them, so this is defence in depth: the
   * cost of the check is negligible next to the cost of deleting proof evidence.
   *
   * The disposal check is part of the same guard. Every sweepable class deletes;
   * the classes marked for anonymisation are all preserved, and the sweep has no
   * anonymisation path. If a future class pairs `AUTOMATED` with `ANONYMISE`, it
   * must fail loudly here rather than be silently deleted instead.
   */
  private assertSweepable(entry: RetentionClass): void {
    if (entry.sweep !== SweepMode.AUTOMATED) {
      throw new RetentionConfigError(
        `Retention class ${entry.key} is preserved and must never be swept ` +
          `automatically. ${entry.preservationReason ?? ""}`.trim(),
      );
    }

    if (entry.disposal !== DisposalMethod.DELETE) {
      throw new RetentionConfigError(
        `Retention class ${entry.key} is marked for ${entry.disposal} but the ` +
          `cleanup job only implements deletion. Implement anonymisation ` +
          `explicitly before marking this class sweepable.`,
      );
    }
  }

  /** Resolves the class keys to sweep for this run. */
  private selectClasses(only?: readonly string[]): readonly RetentionClass[] {
    if (!only || only.length === 0) return SWEEPABLE_CLASSES;

    const selected = SWEEPABLE_CLASSES.filter((entry) =>
      only.includes(entry.key),
    );

    const unknown = only.filter(
      (key) => !SWEEPABLE_CLASSES.some((entry) => entry.key === key),
    );

    if (unknown.length > 0) {
      // Includes the case where a caller names a preserved class. Failing is
      // the point: silently sweeping nothing would look like success.
      throw new RetentionConfigError(
        `Unknown or non-sweepable retention class(es): ${unknown.join(", ")}.`,
      );
    }

    return selected;
  }

  /** Prisma delegate for a class's model. */
  private delegateFor(entry: RetentionClass): PrismaDelegate {
    const delegates: Record<string, PrismaDelegate | undefined> = {
      wallet_challenges: this.prisma.walletChallenge as unknown as PrismaDelegate,
      auth_sessions: this.prisma.authSession as unknown as PrismaDelegate,
      webhook_deliveries: this.prisma
        .webhookDelivery as unknown as PrismaDelegate,
      verification_events: this.prisma
        .verificationEventLog as unknown as PrismaDelegate,
      audit_logs: this.prisma.auditLog as unknown as PrismaDelegate,
      failed_anchoring_intents: this.prisma
        .anchoringIntent as unknown as PrismaDelegate,
      idempotency_records: this.prisma
        .idempotencyRecord as unknown as PrismaDelegate,
    };

    const delegate = delegates[entry.key];
    if (!delegate) {
      throw new RetentionConfigError(
        `No Prisma delegate is mapped for retention class ${entry.key}.`,
      );
    }
    return delegate;
  }
}

/** Row shape returned by a selection: id plus any tenant attribution. */
interface SelectedRecord {
  id: string;
  webhook?: { organizationId?: string | null } | null;
}

/** The subset of a Prisma model delegate the sweep uses. */
interface PrismaDelegate {
  findMany(args: {
    where: Record<string, unknown>;
    select: Record<string, unknown>;
    orderBy: Array<Record<string, "asc" | "desc">>;
    take: number;
    skip?: number;
  }): Promise<SelectedRecord[]>;
  deleteMany(args: {
    where: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

/**
 * Columns a selection reads: the id and, for tenant-scoped models, the owning
 * organization. Nothing else — record content never leaves the database.
 *
 * Webhook deliveries are the only swept model with an organization; the others
 * (challenges, sessions, verification events, audit logs, anchoring intents)
 * carry no tenant column and are reported under a `null` organization.
 */
function selectionFor(entry: RetentionClass): Record<string, unknown> {
  if (entry.key === "webhook_deliveries") {
    return { id: true, webhook: { select: { organizationId: true } } };
  }
  return { id: true };
}

function organizationOf(
  entry: RetentionClass,
  row: SelectedRecord,
): string | null {
  if (entry.key === "webhook_deliveries") {
    return row.webhook?.organizationId ?? null;
  }
  return null;
}

/** Impact entry for a class that could not be evaluated. */
function failedImpact(entry: RetentionClass, now: Date): CategoryImpact {
  let cutoff = "";
  try {
    cutoff = cutoffFor(entry, now).toISOString();
  } catch {
    // The cutoff itself is what failed (an unusable override); left empty.
  }

  return {
    category: entry.key,
    cutoff,
    cutoffColumn: entry.cutoffColumn,
    selected: 0,
    affected: 0,
    truncated: false,
    failed: true,
    organizations: [],
    otherOrganizations: { buckets: 0, count: 0 },
  };
}

/** Error description safe for an operational log. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return "UnknownError";
}
