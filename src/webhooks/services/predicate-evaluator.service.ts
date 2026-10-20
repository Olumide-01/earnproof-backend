import { Injectable, Logger } from "@nestjs/common";
import {
  AndExpression,
  EvaluationBudget,
  EvaluationResult,
  FieldComparison,
  FieldInList,
  LogicalOperator,
  NotExpression,
  OrExpression,
  Predicate,
  PredicateExpression,
  WebhookEventContext,
} from "../predicate.types";
import { PREDICATE_EVALUATION_LIMITS } from "../../common/limits/predicate-limits";

/**
 * Bounded predicate evaluator with budget tracking and short-circuit.
 *
 * Evaluates a predicate (versioned JSON structure) against an event context
 * (resource, outcome, schemaVersion). Evaluation is:
 *
 * - Deterministic: same predicate + context always produces the same result
 * - Pure: no side effects, no external state
 * - Budgeted: evaluation stops if budget is exceeded (fail closed)
 * - Short-circuiting: and/or expressions stop early on match/no-match
 *
 * Privacy guarantee: only resource, outcome, and schemaVersion are accessible;
 * payload is never passed to the evaluator.
 *
 * Design rationale:
 * - Each node visit (operator, comparison, value check) increments the budget.
 * - Budget is local to one event evaluation; it resets per event.
 * - Budget exhaustion returns match=false (fail closed, no delivery).
 * - Evaluation failure is logged but does not throw (resilience).
 */
@Injectable()
export class PredicateEvaluatorService {
  private readonly logger = new Logger(PredicateEvaluatorService.name);

  /**
   * Evaluates a predicate against an event context.
   *
   * Returns:
   * - match: whether the predicate matched
   * - reason: why evaluation stopped (if not matched)
   * - visited: number of nodes visited
   *
   * If evaluation fails or budget is exceeded, returns match=false.
   *
   * @param predicate The PredicateV1 to evaluate
   * @param context The WebhookEventContext (resource, outcome, schemaVersion)
   * @returns EvaluationResult with match status and budget usage
   */
  evaluate(predicate: Predicate, context: WebhookEventContext): EvaluationResult {
    const budget: EvaluationBudget = {
      limit: PREDICATE_EVALUATION_LIMITS.maxEvaluationBudget,
      visited: 0,
    };

    try {
      const result = this.evaluateExpression(predicate.logic, context, budget);
      return result;
    } catch (error) {
      // Catch evaluation errors (malformed predicate, unexpected structure)
      // and fail closed (no delivery).
      this.logger.error(
        `Predicate evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        { error, context },
      );
      return {
        match: false,
        reason: "EVALUATION_FAILED",
        visited: budget.visited,
      };
    }
  }

  /**
   * Recursively evaluates a predicate expression.
   *
   * Dispatches to the appropriate handler based on operator type.
   * Updates budget.visited and checks budget limits before each operation.
   */
  private evaluateExpression(
    expr: PredicateExpression,
    context: WebhookEventContext,
    budget: EvaluationBudget,
  ): EvaluationResult {
    // Check budget before processing
    if (budget.visited >= budget.limit) {
      return {
        match: false,
        reason: "EVALUATION_BUDGET_EXCEEDED",
        visited: budget.visited,
      };
    }

    // Increment for this node
    budget.visited++;

    // Check budget again (some operations may be expensive)
    if (budget.visited >= budget.limit) {
      return {
        match: false,
        reason: "EVALUATION_BUDGET_EXCEEDED",
        visited: budget.visited,
      };
    }

    // Dispatch based on operator
    const expr_ = expr as any;
    const op = expr_?.op;

    switch (op) {
      case "eq":
        return this.evaluateComparison(expr as FieldComparison, context);

      case "in":
        return this.evaluateInList(expr as FieldInList, context);

      case "and":
        return this.evaluateAnd(expr as AndExpression, context, budget);

      case "or":
        return this.evaluateOr(expr as OrExpression, context, budget);

      case "not":
        return this.evaluateNot(expr as NotExpression, context, budget);

      default:
        return {
          match: false,
          reason: "UNKNOWN_OPERATOR",
          visited: budget.visited,
        };
    }
  }

  /**
   * Evaluates a field comparison: field === value
   */
  private evaluateComparison(
    expr: FieldComparison,
    context: WebhookEventContext,
  ): EvaluationResult {
    const contextValue = context[expr.field];
    const matched = contextValue === expr.value;

    return {
      match: matched,
      reason: matched ? undefined : "NO_MATCH",
      visited: 1,
    };
  }

  /**
   * Evaluates a field in-list: field in values
   */
  private evaluateInList(
    expr: FieldInList,
    context: WebhookEventContext,
  ): EvaluationResult {
    const contextValue = context[expr.field];
    const matched = expr.values.includes(contextValue);

    return {
      match: matched,
      reason: matched ? undefined : "NO_MATCH",
      visited: 1,
    };
  }

  /**
   * Evaluates logical AND: all sub-expressions must match.
   *
   * Short-circuits: stops at first false sub-expression.
   * Fail closed on budget exhaustion: returns match=false.
   */
  private evaluateAnd(
    expr: AndExpression,
    context: WebhookEventContext,
    budget: EvaluationBudget,
  ): EvaluationResult {
    for (const subExpr of expr.expressions) {
      // Check budget before each sub-expression
      if (budget.visited >= budget.limit) {
        return {
          match: false,
          reason: "EVALUATION_BUDGET_EXCEEDED",
          visited: budget.visited,
        };
      }

      const result = this.evaluateExpression(subExpr, context, budget);

      // Fail closed on budget exhaustion
      if (result.reason === "EVALUATION_BUDGET_EXCEEDED") {
        return result;
      }

      // Short-circuit on first false
      if (!result.match) {
        return result;
      }
    }

    // All sub-expressions matched
    return {
      match: true,
      visited: budget.visited,
    };
  }

  /**
   * Evaluates logical OR: any sub-expression must match.
   *
   * Short-circuits: stops at first true sub-expression.
   * Fail closed on budget exhaustion: returns match=false.
   */
  private evaluateOr(
    expr: OrExpression,
    context: WebhookEventContext,
    budget: EvaluationBudget,
  ): EvaluationResult {
    for (const subExpr of expr.expressions) {
      // Check budget before each sub-expression
      if (budget.visited >= budget.limit) {
        return {
          match: false,
          reason: "EVALUATION_BUDGET_EXCEEDED",
          visited: budget.visited,
        };
      }

      const result = this.evaluateExpression(subExpr, context, budget);

      // Fail closed on budget exhaustion
      if (result.reason === "EVALUATION_BUDGET_EXCEEDED") {
        return result;
      }

      // Short-circuit on first true
      if (result.match) {
        return result;
      }
    }

    // No sub-expressions matched
    return {
      match: false,
      reason: "NO_MATCH",
      visited: budget.visited,
    };
  }

  /**
   * Evaluates logical NOT: negates a single sub-expression.
   *
   * Fail closed on budget exhaustion: returns match=false.
   */
  private evaluateNot(
    expr: NotExpression,
    context: WebhookEventContext,
    budget: EvaluationBudget,
  ): EvaluationResult {
    // NOT has exactly one sub-expression (enforced by validation)
    const subExpr = expr.expressions[0];

    // Check budget before sub-expression
    if (budget.visited >= budget.limit) {
      return {
        match: false,
        reason: "EVALUATION_BUDGET_EXCEEDED",
        visited: budget.visited,
      };
    }

    const result = this.evaluateExpression(subExpr, context, budget);

    // Fail closed on budget exhaustion
    if (result.reason === "EVALUATION_BUDGET_EXCEEDED") {
      return result;
    }

    // Negate the result
    return {
      match: !result.match,
      reason: !result.match ? undefined : "NO_MATCH",
      visited: budget.visited,
    };
  }

  /**
   * Derives event context from a webhook event.
   *
   * Parses the event type (e.g., "proof.created" → resource="proof", outcome="created")
   * and extracts the schema version.
   *
   * @param eventType The event type string (e.g., "proof.created")
   * @param schemaVersion The payload schema version (e.g., "1")
   * @returns WebhookEventContext for predicate evaluation
   */
  deriveContext(eventType: string, schemaVersion: string): WebhookEventContext {
    const parts = eventType.split(".");
    if (parts.length !== 2) {
      // Malformed event type; return a context that will not match most predicates
      return {
        resource: "",
        outcome: "",
        schemaVersion,
      };
    }

    return {
      resource: parts[0],
      outcome: parts[1],
      schemaVersion,
    };
  }
}
