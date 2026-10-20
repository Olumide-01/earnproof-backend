/**
 * Limits for bounded webhook predicates, in one place.
 *
 * These limits prevent unbounded evaluation, ensure deterministic behavior, and are
 * enforced during both validation (DTO layer) and evaluation (runtime layer).
 * All limits are inclusive: accepted at the limit, rejected one over.
 *
 * Design:
 * - predicateVersion: string length 1–16 (e.g., "1", "1-alpha", "2")
 * - Tree depth: max 4 (prevents runaway nesting)
 * - Tree nodes: max 32 (total count of operators + fields + values)
 * - Field value length: max 256 bytes UTF-8 (comparable to DNS label + namespace)
 * - In-list size: max 16 items (prevents large disjunctions)
 * - Evaluation budget: max 256 node visits per event (short-circuit when exceeded)
 */

/**
 * Structural limits for the predicate tree itself.
 */
export const PREDICATE_STRUCTURE_LIMITS = {
  /**
   * Maximum nesting depth of the predicate expression tree.
   *
   * Depth 4 prevents runaway nesting (e.g., deeply nested and/or/not),
   * and translates to ~16 leaf nodes max in a reasonable tree.
   * Boundary: depth 4 accepted, depth 5 rejected.
   */
  maxDepth: 4,

  /**
   * Maximum total nodes in the predicate expression tree.
   *
   * Each operator (and, or, not, eq, in), field reference, and value
   * counts as one node. Prevents a large, bushy tree from consuming
   * excessive memory or validation time.
   * Boundary: 32 nodes accepted, 33 rejected.
   */
  maxNodes: 32,

  /**
   * Maximum length of predicateVersion string.
   *
   * Semantic versioning: "1", "2-alpha", etc. 16 characters is generous.
   * Boundary: 16 chars accepted, 17 rejected.
   */
  maxPredicateVersionLength: 16,
} as const;

/**
 * Limits for field values and lists within predicates.
 */
export const PREDICATE_VALUE_LIMITS = {
  /**
   * Maximum byte length (UTF-8) of any single field value.
   *
   * Comparable to DNS labels and event type components. 256 bytes is
   * reasonable for identifiers, status codes, and schema versions.
   * Boundary: 256 bytes accepted, 257 rejected.
   */
  maxFieldValueLength: 256,

  /**
   * Maximum number of items in an "in" operator's values list.
   *
   * Prevents large disjunctions like { op: "in", field: "outcome", values: [...1000 items...] }
   * Boundary: 16 items accepted, 17 rejected.
   */
  maxInListSize: 16,
} as const;

/**
 * Runtime evaluation limits, preventing unbounded work per event.
 */
export const PREDICATE_EVALUATION_LIMITS = {
  /**
   * Maximum nodes visited during evaluation of one predicate against one event.
   *
   * Each comparison, logical operation, or short-circuit counts as a visit.
   * 256 visits is ~256 atomic comparisons or a reasonable logical tree evaluation.
   * When exceeded, evaluation stops and delivery fails closed.
   * Boundary: 256 visits accepted, 257 causes EVALUATION_BUDGET_EXCEEDED.
   */
  maxEvaluationBudget: 256,
} as const;

/**
 * Combined limits for easy reference.
 */
export const ALL_PREDICATE_LIMITS = {
  ...PREDICATE_STRUCTURE_LIMITS,
  ...PREDICATE_VALUE_LIMITS,
  ...PREDICATE_EVALUATION_LIMITS,
} as const;
