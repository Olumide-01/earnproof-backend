/**
 * Retention impact reports.
 *
 * Every retention run — dry or real — produces one of these, so an operator
 * can review exactly which categories and how many records a sweep would touch
 * before it touches anything, and then check that the real run did what the
 * preview said.
 *
 * What a report may contain is deliberately narrow: category keys, counts,
 * cutoff instants, the policy version, and organization identifiers. Never row
 * ids, wallet addresses, token hashes, payloads, or any other record content.
 * Organization ids are opaque tenant keys (cuids) that already appear in API
 * paths and are not on any redaction list (`FORBIDDEN_LOG_FIELDS`,
 * audit-redaction key patterns); they are what an operator needs to see which
 * tenant a sweep affects, and nothing about a record can be learned from them.
 */

/** Whether a run wrote anything. */
export type RetentionRunMode = "dry_run" | "execute";

/**
 * Maximum organization buckets reported per category.
 *
 * Bounds the report size regardless of tenant count. Buckets beyond the cap are
 * folded into {@link CategoryImpact.otherOrganizations} so totals still add up.
 */
export const MAX_ORGANIZATION_BUCKETS = 25;

/**
 * Default maximum age of a dry-run plan an execution may be compared against.
 *
 * A plan older than this describes a dataset that has had a day to change; the
 * comparison would report drift that means nothing.
 */
export const DEFAULT_MAX_PLAN_AGE_MS = 24 * 60 * 60 * 1_000;

/** Records attributed to one organization. `null` means not tenant-scoped. */
export interface OrganizationCount {
  organizationId: string | null;
  count: number;
}

/** Impact on one record category (retention class). */
export interface CategoryImpact {
  /** Retention class key, e.g. `webhook_deliveries`. */
  category: string;
  /** ISO-8601 cutoff: records whose cutoff column is strictly before it are selected. */
  cutoff: string;
  /** Column the cutoff was measured against. */
  cutoffColumn: string;
  /**
   * Records selected for disposal. In a dry run, the records a real run at the
   * same instant would select; in an execution, the records it selected.
   */
  selected: number;
  /** Records actually removed. Always 0 in a dry run. */
  affected: number;
  /** True when the per-run batch cap was reached and eligible rows remain. */
  truncated: boolean;
  /** True when the category could not be evaluated; counts are then 0. */
  failed: boolean;
  /** Largest organization buckets first, at most {@link MAX_ORGANIZATION_BUCKETS}. */
  organizations: OrganizationCount[];
  /** Records in organizations beyond the bucket cap. */
  otherOrganizations: { buckets: number; count: number };
}

/** One run's impact report. */
export interface RetentionImpactReport {
  mode: RetentionRunMode;
  /** Fingerprint of the class definitions and resolved durations used. */
  policyVersion: string;
  /** ISO-8601 instant every cutoff in this run was derived from. */
  evaluatedAt: string;
  categories: CategoryImpact[];
  totals: { selected: number; affected: number };
}

/** Folds per-organization tallies into bounded, deterministic buckets. */
export function boundOrganizationCounts(
  tally: ReadonlyMap<string | null, number>,
  maxBuckets: number = MAX_ORGANIZATION_BUCKETS,
): Pick<CategoryImpact, "organizations" | "otherOrganizations"> {
  const sorted = [...tally.entries()]
    .filter(([, count]) => count > 0)
    .map(([organizationId, count]) => ({ organizationId, count }))
    // Largest first; ties broken by id so the same data always yields the
    // same report, which is what makes plan/execution comparison meaningful.
    .sort(
      (left, right) =>
        right.count - left.count ||
        String(left.organizationId).localeCompare(String(right.organizationId)),
    );

  const kept = sorted.slice(0, maxBuckets);
  const rest = sorted.slice(maxBuckets);

  return {
    organizations: kept,
    otherOrganizations: {
      buckets: rest.length,
      count: rest.reduce((sum, entry) => sum + entry.count, 0),
    },
  };
}

/** Why an execution does not match its dry-run plan. */
export type PlanComparisonIssue =
  | { code: "plan_not_dry_run" }
  | { code: "execution_not_execute" }
  | { code: "policy_version_mismatch" }
  | { code: "plan_stale"; ageMs: number }
  | { code: "plan_after_execution" }
  | { code: "category_missing"; category: string }
  | { code: "category_unplanned"; category: string }
  | { code: "category_failed"; category: string }
  | { code: "cutoff_mismatch"; category: string }
  | {
      code: "count_drift";
      category: string;
      planned: number;
      actual: number;
    };

export interface PlanComparison {
  /** True when the execution did exactly what the plan described. */
  matches: boolean;
  issues: PlanComparisonIssue[];
}

/**
 * Compares an execution report against a recent dry-run plan.
 *
 * A mismatch is reported, never thrown: the execution has already happened,
 * and the operator needs to see every discrepancy rather than the first one.
 * Counts are compared on `selected` — what the run chose to remove — because
 * that is what a dry run predicts. `affected` can legitimately trail it when a
 * concurrent writer removed a row between selection and deletion.
 */
export function compareWithPlan(
  plan: RetentionImpactReport,
  execution: RetentionImpactReport,
  options: { maxPlanAgeMs?: number } = {},
): PlanComparison {
  const issues: PlanComparisonIssue[] = [];
  const maxPlanAgeMs = options.maxPlanAgeMs ?? DEFAULT_MAX_PLAN_AGE_MS;

  if (plan.mode !== "dry_run") issues.push({ code: "plan_not_dry_run" });
  if (execution.mode !== "execute") issues.push({ code: "execution_not_execute" });
  if (plan.policyVersion !== execution.policyVersion) {
    issues.push({ code: "policy_version_mismatch" });
  }

  const ageMs = Date.parse(execution.evaluatedAt) - Date.parse(plan.evaluatedAt);
  if (ageMs < 0) {
    issues.push({ code: "plan_after_execution" });
  } else if (ageMs > maxPlanAgeMs) {
    issues.push({ code: "plan_stale", ageMs });
  }

  const executed = new Map(execution.categories.map((c) => [c.category, c]));
  const planned = new Map(plan.categories.map((c) => [c.category, c]));

  for (const expected of plan.categories) {
    const actual = executed.get(expected.category);
    if (!actual) {
      issues.push({ code: "category_missing", category: expected.category });
      continue;
    }
    if (expected.failed || actual.failed) {
      issues.push({ code: "category_failed", category: expected.category });
      continue;
    }
    if (expected.cutoff !== actual.cutoff) {
      issues.push({ code: "cutoff_mismatch", category: expected.category });
    }
    if (expected.selected !== actual.selected) {
      issues.push({
        code: "count_drift",
        category: expected.category,
        planned: expected.selected,
        actual: actual.selected,
      });
    }
  }

  for (const actual of execution.categories) {
    if (!planned.has(actual.category)) {
      issues.push({ code: "category_unplanned", category: actual.category });
    }
  }

  return { matches: issues.length === 0, issues };
}
