/**
 * Bounded webhook predicate grammar and types.
 *
 * Predicates are versioned, typed, declarative JSON structures that select events
 * using bounded evaluation over three public fields: resource, outcome, and schemaVersion.
 * No arbitrary expressions, no private field access, no unbounded nesting.
 *
 * Design:
 * - predicateVersion: frozen version; unknown versions rejected
 * - Operators: eq, in, and, or, not (no eval, no regex, no property paths)
 * - Limits: depth ≤4, nodes ≤32, field values ≤256 bytes, in-lists ≤16, evaluation budget 256 nodes
 * - Evaluation: deterministic, pure function of (predicate, context, budget)
 * - Privacy: only resource, outcome, schemaVersion are accessible; payload is unreachable
 * - Authorization: predicate belongs to subscription's organization; no cross-tenant escape
 */

/**
 * Version of the predicate grammar. Only "1" is valid; unknown versions are rejected at
 * API time (400 PREDICATE_VERSION_UNKNOWN). Allows the grammar to evolve without breaking
 * old subscriptions.
 */
export type PredicateVersion = "1";

export const PREDICATE_VERSIONS: readonly PredicateVersion[] = ["1"];
export const CURRENT_PREDICATE_VERSION: PredicateVersion = "1";

/**
 * Fields that predicates can filter on.
 *
 * These are derived from the WebhookEnvelope and never expose private payload fields:
 * - resource: the first part of event type (e.g., "proof" from "proof.created")
 * - outcome: the second part of event type (e.g., "created" from "proof.created")
 * - schemaVersion: the payload schema version (e.g., "1")
 */
export type PredicateField = "resource" | "outcome" | "schemaVersion";

export const PREDICATE_FIELDS: readonly PredicateField[] = ["resource", "outcome", "schemaVersion"];

/**
 * Operators for atomic and logical predicates.
 */
export type AtomicOperator = "eq" | "in";
export type LogicalOperator = "and" | "or" | "not";
export type PredicateOperator = AtomicOperator | LogicalOperator;

export const ATOMIC_OPERATORS: readonly AtomicOperator[] = ["eq", "in"];
export const LOGICAL_OPERATORS: readonly LogicalOperator[] = ["and", "or", "not"];
export const ALL_OPERATORS: readonly PredicateOperator[] = [...ATOMIC_OPERATORS, ...LOGICAL_OPERATORS];

/**
 * The evaluation context — the public projection of an event that predicates can see.
 *
 * Never includes the full payload. Derived deterministically from the WebhookEnvelope:
 * - resource + outcome: parsed from envelope.event (e.g., "proof.created" → resource="proof", outcome="created")
 * - schemaVersion: from envelope.schemaVersion
 */
export interface WebhookEventContext {
  resource: string;
  outcome: string;
  schemaVersion: string;
}

/**
 * Atomic comparison: field equals a single value.
 *
 * Example: { op: "eq", field: "resource", value: "proof" }
 */
export interface FieldComparison {
  op: "eq";
  field: PredicateField;
  value: string | number | boolean | null;
}

/**
 * Atomic predicate: field is one of a list of values.
 *
 * Example: { op: "in", field: "resource", values: ["proof", "attestation"] }
 */
export interface FieldInList {
  op: "in";
  field: PredicateField;
  values: (string | number | boolean | null)[];
}

/**
 * Logical AND: all sub-expressions must match. Short-circuits on first false.
 *
 * Example: { op: "and", expressions: [{...}, {...}] }
 */
export interface AndExpression {
  op: "and";
  expressions: PredicateExpression[];
}

/**
 * Logical OR: any sub-expression must match. Short-circuits on first true.
 *
 * Example: { op: "or", expressions: [{...}, {...}] }
 */
export interface OrExpression {
  op: "or";
  expressions: PredicateExpression[];
}

/**
 * Logical NOT: negates a single sub-expression.
 *
 * Example: { op: "not", expressions: [{ op: "eq", field: "outcome", value: "failed" }] }
 */
export interface NotExpression {
  op: "not";
  expressions: [PredicateExpression];
}

/** Any predicate expression: atomic or logical. */
export type PredicateExpression = FieldComparison | FieldInList | AndExpression | OrExpression | NotExpression;

/**
 * Root predicate structure, versioned.
 *
 * Example:
 * {
 *   "predicateVersion": "1",
 *   "logic": { "op": "eq", "field": "resource", "value": "proof" }
 * }
 */
export interface PredicateV1 {
  predicateVersion: PredicateVersion;
  logic: PredicateExpression;
}

/** Union of all predicate versions. Currently just V1. */
export type Predicate = PredicateV1;

/**
 * Result of evaluating a predicate against an event context.
 *
 * `match`: whether the predicate matched the event
 * `reason`: why evaluation stopped (e.g., "NO_MATCH", "EVALUATION_BUDGET_EXCEEDED")
 * `visited`: number of nodes visited before evaluation completed
 */
export interface EvaluationResult {
  match: boolean;
  reason?: string;
  visited: number;
}

/**
 * Budget for predicate evaluation, preventing unbounded work per event.
 *
 * `limit`: maximum nodes that can be visited per event (256)
 * `visited`: running count of nodes visited so far
 */
export interface EvaluationBudget {
  limit: number;
  visited: number;
}
