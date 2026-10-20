/**
 * Custom validators for bounded webhook predicates.
 *
 * These decorators enforce:
 * - Predicate grammar version is known
 * - Operators are from the allowed set
 * - Fields are from the allowed set
 * - Values are properly typed and within length limits
 * - Tree depth does not exceed 4
 * - Total nodes do not exceed 32
 * - In-lists do not exceed 16 items
 * - Unknown fields are rejected (strict validation)
 *
 * Design: validators fail fast with deterministic, documented error codes.
 */

import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from "class-validator";
import {
  ALL_OPERATORS,
  ATOMIC_OPERATORS,
  LOGICAL_OPERATORS,
  PREDICATE_FIELDS,
  PREDICATE_VERSIONS,
  PredicateField,
  PredicateVersion,
} from "../predicate.types";
import {
  PREDICATE_EVALUATION_LIMITS,
  PREDICATE_STRUCTURE_LIMITS,
  PREDICATE_VALUE_LIMITS,
} from "../../common/limits/predicate-limits";

/**
 * Validates that a single predicate field value is within length limits.
 *
 * Field values must be strings, numbers, booleans, or null. Strings are
 * bounded to 256 bytes (UTF-8). Numbers and booleans are unrestricted (they
 * serialize to small strings). Null is always valid.
 *
 * Usage: @ValidatePredicateValueLength()
 */
export function ValidatePredicateValueLength(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "validatePredicateValueLength",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          // Null is always valid
          if (value === null || value === undefined) {
            return true;
          }

          // Numbers and booleans are always valid (serialize to small strings)
          if (typeof value === "number" || typeof value === "boolean") {
            return true;
          }

          // Strings must be within byte limit
          if (typeof value === "string") {
            const byteLength = Buffer.byteLength(value, "utf8");
            return byteLength <= PREDICATE_VALUE_LIMITS.maxFieldValueLength;
          }

          // Anything else is invalid
          return false;
        },
        defaultMessage(args: ValidationArguments) {
          const value = args.value as unknown;
          if (typeof value === "string") {
            const byteLength = Buffer.byteLength(value, "utf8");
            return (
              `${args.property} must not exceed ${PREDICATE_VALUE_LIMITS.maxFieldValueLength} bytes (UTF-8). ` +
              `Provided: ${byteLength} bytes.`
            );
          }
          return (
            `${args.property} must be a string, number, boolean, or null. ` +
            `Provided type: ${typeof value}.`
          );
        },
      },
    });
  };
}

/**
 * Validates the shape of a predicate expression tree.
 *
 * Checks:
 * - Expression is an object with an `op` field
 * - `op` is a known operator
 * - Fields exist for the operator type (e.g., "field" and "value" for "eq")
 * - No unknown fields (strict validation)
 * - Field values are valid for the operator
 * - In-lists do not exceed 16 items
 * - Tree depth does not exceed 4
 * - Total nodes do not exceed 32
 *
 * This is called recursively on the entire predicate tree.
 *
 * Usage: @ValidatePredicateExpression("root") on the root logic field
 */
export function ValidatePredicateExpression(
  context: "root" | "and" | "or" | "not" | "in" = "root",
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: `validatePredicateExpression_${context}`,
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          // For "in" context, we're validating a values array
          if (context === "in") {
            if (!Array.isArray(value)) {
              return false;
            }

            // Must not be empty
            if (value.length === 0) {
              return false;
            }

            // Must not exceed max size
            if (value.length > PREDICATE_VALUE_LIMITS.maxInListSize) {
              return false;
            }

            // Each item must be a valid value type
            for (const item of value) {
              if (
                item !== null &&
                typeof item !== "string" &&
                typeof item !== "number" &&
                typeof item !== "boolean"
              ) {
                return false;
              }
              // Check string length if applicable
              if (typeof item === "string") {
                const byteLength = Buffer.byteLength(item, "utf8");
                if (byteLength > PREDICATE_VALUE_LIMITS.maxFieldValueLength) {
                  return false;
                }
              }
            }

            return true;
          }

          // For "and", "or", "not" contexts, we're validating expressions arrays
          if (context === "and" || context === "or" || context === "not") {
            if (!Array.isArray(value)) {
              return false;
            }

            const minSize = context === "not" ? 1 : 2;
            const maxSize = context === "not" ? 1 : Infinity;

            if (value.length < minSize || value.length > maxSize) {
              return false;
            }

            // Each item must be a valid expression
            for (const expr of value) {
              if (!isValidExpression(expr)) {
                return false;
              }
            }

            return true;
          }

          // For "root", validate the entire tree
          if (context === "root") {
            // Must be an object
            if (value === null || typeof value !== "object") {
              return false;
            }

            const expr = value as Record<string, unknown>;

            // Calculate tree metrics
            const metrics = calculateTreeMetrics(expr);

            // Check depth limit
            if (metrics.depth > PREDICATE_STRUCTURE_LIMITS.maxDepth) {
              return false;
            }

            // Check node count limit
            if (metrics.nodeCount > PREDICATE_STRUCTURE_LIMITS.maxNodes) {
              return false;
            }

            // Validate the entire tree for correctness
            return isValidExpression(expr);
          }

          return false;
        },
        defaultMessage(args: ValidationArguments) {
          const value = args.value as unknown;

          if (context === "in") {
            if (!Array.isArray(value)) {
              return `values must be an array`;
            }
            if (value.length === 0) {
              return `values array must not be empty`;
            }
            if (value.length > PREDICATE_VALUE_LIMITS.maxInListSize) {
              return `values array must not exceed ${PREDICATE_VALUE_LIMITS.maxInListSize} items`;
            }
            return `values array contains invalid items`;
          }

          if (context === "and") {
            if (!Array.isArray(value)) {
              return `expressions must be an array`;
            }
            if (value.length < 2) {
              return `and expressions must have at least 2 sub-expressions`;
            }
            return `and expressions contain invalid expressions`;
          }

          if (context === "or") {
            if (!Array.isArray(value)) {
              return `expressions must be an array`;
            }
            if (value.length < 2) {
              return `or expressions must have at least 2 sub-expressions`;
            }
            return `or expressions contain invalid expressions`;
          }

          if (context === "not") {
            if (!Array.isArray(value)) {
              return `expressions must be an array`;
            }
            if (value.length !== 1) {
              return `not expression must have exactly 1 sub-expression`;
            }
            return `not expression contains an invalid sub-expression`;
          }

          if (context === "root") {
            if (value === null || typeof value !== "object") {
              return `logic must be a predicate expression object`;
            }

            const expr = value as Record<string, unknown>;
            const metrics = calculateTreeMetrics(expr);

            if (metrics.depth > PREDICATE_STRUCTURE_LIMITS.maxDepth) {
              return (
                `predicate is nested too deep (depth: ${metrics.depth}, max: ${PREDICATE_STRUCTURE_LIMITS.maxDepth})`
              );
            }

            if (metrics.nodeCount > PREDICATE_STRUCTURE_LIMITS.maxNodes) {
              return (
                `predicate has too many nodes (count: ${metrics.nodeCount}, max: ${PREDICATE_STRUCTURE_LIMITS.maxNodes})`
              );
            }

            return `logic must be a valid predicate expression`;
          }

          return `invalid predicate expression`;
        },
      },
    });
  };
}

/**
 * Checks if an object is a valid predicate expression.
 *
 * Does not check depth or node count (done separately).
 */
function isValidExpression(expr: unknown): boolean {
  if (expr === null || typeof expr !== "object") {
    return false;
  }

  const obj = expr as Record<string, unknown>;

  // Must have an "op" field
  if (typeof obj.op !== "string") {
    return false;
  }

  // Op must be known
  if (!ALL_OPERATORS.includes(obj.op as any)) {
    return false;
  }

  // Validate based on operator type
  if (ATOMIC_OPERATORS.includes(obj.op as any)) {
    return isValidAtomicExpression(obj);
  }

  if (LOGICAL_OPERATORS.includes(obj.op as any)) {
    return isValidLogicalExpression(obj);
  }

  return false;
}

/**
 * Validates atomic expressions (eq, in).
 */
function isValidAtomicExpression(expr: Record<string, unknown>): boolean {
  const op = expr.op as string;

  if (op === "eq") {
    // Must have "field" and "value"
    if (!("field" in expr) || !("value" in expr)) {
      return false;
    }

    // "field" must be a known field
    if (!PREDICATE_FIELDS.includes(expr.field as any)) {
      return false;
    }

    // "value" must be valid type
    const value = expr.value as unknown;
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return false;
    }

    // String values must be within length limit
    if (typeof value === "string") {
      const byteLength = Buffer.byteLength(value, "utf8");
      if (byteLength > PREDICATE_VALUE_LIMITS.maxFieldValueLength) {
        return false;
      }
    }

    // Must not have unknown fields
    const allowedKeys = new Set(["op", "field", "value"]);
    for (const key in expr) {
      if (!allowedKeys.has(key)) {
        return false;
      }
    }

    return true;
  }

  if (op === "in") {
    // Must have "field" and "values"
    if (!("field" in expr) || !("values" in expr)) {
      return false;
    }

    // "field" must be a known field
    if (!PREDICATE_FIELDS.includes(expr.field as any)) {
      return false;
    }

    // "values" must be an array
    if (!Array.isArray(expr.values)) {
      return false;
    }

    // Array must not be empty
    if (expr.values.length === 0) {
      return false;
    }

    // Array must not exceed size limit
    if (expr.values.length > PREDICATE_VALUE_LIMITS.maxInListSize) {
      return false;
    }

    // Each item must be valid
    for (const item of expr.values) {
      if (
        item !== null &&
        typeof item !== "string" &&
        typeof item !== "number" &&
        typeof item !== "boolean"
      ) {
        return false;
      }

      if (typeof item === "string") {
        const byteLength = Buffer.byteLength(item, "utf8");
        if (byteLength > PREDICATE_VALUE_LIMITS.maxFieldValueLength) {
          return false;
        }
      }
    }

    // Must not have unknown fields
    const allowedKeys = new Set(["op", "field", "values"]);
    for (const key in expr) {
      if (!allowedKeys.has(key)) {
        return false;
      }
    }

    return true;
  }

  return false;
}

/**
 * Validates logical expressions (and, or, not).
 */
function isValidLogicalExpression(expr: Record<string, unknown>): boolean {
  const op = expr.op as string;

  // Must have "expressions"
  if (!("expressions" in expr)) {
    return false;
  }

  // "expressions" must be an array
  if (!Array.isArray(expr.expressions)) {
    return false;
  }

  if (op === "not") {
    // NOT must have exactly 1 expression
    if (expr.expressions.length !== 1) {
      return false;
    }
  } else if (op === "and" || op === "or") {
    // AND and OR must have at least 2 expressions
    if (expr.expressions.length < 2) {
      return false;
    }
  }

  // Each sub-expression must be valid
  for (const subExpr of expr.expressions) {
    if (!isValidExpression(subExpr)) {
      return false;
    }
  }

  // Must not have unknown fields
  const allowedKeys = new Set(["op", "expressions"]);
  for (const key in expr) {
    if (!allowedKeys.has(key)) {
      return false;
    }
  }

  return true;
}

/**
 * Calculates metrics for a predicate expression tree.
 *
 * Returns:
 * - depth: maximum nesting depth (root = 1)
 * - nodeCount: total count of nodes (operators + field refs + values)
 */
function calculateTreeMetrics(expr: unknown): { depth: number; nodeCount: number } {
  const state = { maxDepth: 0, totalNodes: 0 };
  walkExpression(expr, 1, state);
  return { depth: state.maxDepth, nodeCount: state.totalNodes };
}

/**
 * Recursively walks a predicate expression tree, tracking depth and node count.
 */
function walkExpression(
  expr: unknown,
  depth: number,
  state: { maxDepth: number; totalNodes: number },
): void {
  if (expr === null || typeof expr !== "object") {
    return;
  }

  const obj = expr as Record<string, unknown>;

  // Track depth
  state.maxDepth = Math.max(state.maxDepth, depth);

  // Count the operator node
  state.totalNodes++;

  // Handle field reference
  if ("field" in obj) {
    state.totalNodes++;
  }

  // Handle value(s)
  if ("value" in obj) {
    state.totalNodes++;
  }

  if ("values" in obj && Array.isArray(obj.values)) {
    state.totalNodes += obj.values.length;
  }

  // Recurse into sub-expressions
  if ("expressions" in obj && Array.isArray(obj.expressions)) {
    for (const subExpr of obj.expressions) {
      walkExpression(subExpr, depth + 1, state);
    }
  }
}
