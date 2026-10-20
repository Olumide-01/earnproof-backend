import { Test } from "@nestjs/testing";
import { PredicateEvaluatorService } from "./predicate-evaluator.service";
import {
  Predicate,
  WebhookEventContext,
  PredicateV1,
  FieldComparison,
  FieldInList,
  AndExpression,
  OrExpression,
  NotExpression,
} from "../predicate.types";
import { PREDICATE_EVALUATION_LIMITS } from "../../common/limits/predicate-limits";

describe("PredicateEvaluatorService", () => {
  let service: PredicateEvaluatorService;

  const proofCreatedContext: WebhookEventContext = {
    resource: "proof",
    outcome: "created",
    schemaVersion: "1",
  };

  const proofVerifiedContext: WebhookEventContext = {
    resource: "proof",
    outcome: "verified",
    schemaVersion: "1",
  };

  const attestationExpiredContext: WebhookEventContext = {
    resource: "attestation",
    outcome: "expired",
    schemaVersion: "1",
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [PredicateEvaluatorService],
    }).compile();

    service = module.get(PredicateEvaluatorService);
  });

  describe("Atomic operators", () => {
    describe("eq operator", () => {
      it("should match equal values", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "eq",
            field: "resource",
            value: "proof",
          } as FieldComparison,
        };

        const result = service.evaluate(predicate, proofCreatedContext);

        expect(result.match).toBe(true);
        expect(result.reason).toBeUndefined();
        expect(result.visited).toBeGreaterThan(0);
      });

      it("should not match unequal values", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "eq",
            field: "resource",
            value: "attestation",
          } as FieldComparison,
        };

        const result = service.evaluate(predicate, proofCreatedContext);

        expect(result.match).toBe(false);
        expect(result.reason).toBe("NO_MATCH");
      });

      it("should match on outcome field", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "eq",
            field: "outcome",
            value: "created",
          } as FieldComparison,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(true);

        const result2 = service.evaluate(predicate, proofVerifiedContext);
        expect(result2.match).toBe(false);
      });

      it("should match on schemaVersion field", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "eq",
            field: "schemaVersion",
            value: "1",
          } as FieldComparison,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(true);
      });

      it("should match null values", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "eq",
            field: "resource",
            value: null,
          } as FieldComparison,
        };

        const contextWithNull: WebhookEventContext = {
          resource: null as any,
          outcome: "created",
          schemaVersion: "1",
        };

        const result = service.evaluate(predicate, contextWithNull);
        expect(result.match).toBe(true);
      });

      it("should match numeric values", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "eq",
            field: "schemaVersion",
            value: 1,
          } as FieldComparison,
        };

        // Context is string "1", value is number 1 — should not match (strict ===)
        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(false);
      });
    });

    describe("in operator", () => {
      it("should match if field is in values list", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "in",
            field: "resource",
            values: ["proof", "attestation"],
          } as FieldInList,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(true);

        const result2 = service.evaluate(predicate, attestationExpiredContext);
        expect(result2.match).toBe(true);
      });

      it("should not match if field is not in values list", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "in",
            field: "resource",
            values: ["contract", "claim"],
          } as FieldInList,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(false);
      });

      it("should match on outcome field", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "in",
            field: "outcome",
            values: ["created", "verified", "revoked"],
          } as FieldInList,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(true);

        const result2 = service.evaluate(predicate, attestationExpiredContext);
        expect(result2.match).toBe(false);
      });
    });
  });

  describe("Logical operators", () => {
    describe("and operator", () => {
      it("should match if all sub-expressions match", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "and",
            expressions: [
              {
                op: "eq",
                field: "resource",
                value: "proof",
              } as FieldComparison,
              {
                op: "eq",
                field: "outcome",
                value: "created",
              } as FieldComparison,
            ],
          } as AndExpression,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(true);
      });

      it("should not match if any sub-expression does not match", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "and",
            expressions: [
              {
                op: "eq",
                field: "resource",
                value: "proof",
              } as FieldComparison,
              {
                op: "eq",
                field: "outcome",
                value: "verified",
              } as FieldComparison,
            ],
          } as AndExpression,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(false);
      });

      it("should short-circuit on first false", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "and",
            expressions: [
              {
                op: "eq",
                field: "resource",
                value: "attestation",
              } as FieldComparison,
              {
                op: "eq",
                field: "outcome",
                value: "created",
              } as FieldComparison,
            ],
          } as AndExpression,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(false);
        // Short-circuit should result in fewer visits than evaluating both
        expect(result.visited).toBeLessThan(10);
      });
    });

    describe("or operator", () => {
      it("should match if any sub-expression matches", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "or",
            expressions: [
              {
                op: "eq",
                field: "resource",
                value: "attestation",
              } as FieldComparison,
              {
                op: "eq",
                field: "resource",
                value: "proof",
              } as FieldComparison,
            ],
          } as OrExpression,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(true);
      });

      it("should not match if no sub-expressions match", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "or",
            expressions: [
              {
                op: "eq",
                field: "resource",
                value: "attestation",
              } as FieldComparison,
              {
                op: "eq",
                field: "resource",
                value: "contract",
              } as FieldComparison,
            ],
          } as OrExpression,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(false);
      });

      it("should short-circuit on first true", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "or",
            expressions: [
              {
                op: "eq",
                field: "resource",
                value: "proof",
              } as FieldComparison,
              {
                op: "eq",
                field: "outcome",
                value: "verified",
              } as FieldComparison,
            ],
          } as OrExpression,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(true);
        expect(result.visited).toBeLessThan(10);
      });
    });

    describe("not operator", () => {
      it("should negate a true expression", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "not",
            expressions: [
              {
                op: "eq",
                field: "resource",
                value: "attestation",
              } as FieldComparison,
            ],
          } as NotExpression,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(true);
      });

      it("should negate a false expression", () => {
        const predicate: Predicate = {
          predicateVersion: "1",
          logic: {
            op: "not",
            expressions: [
              {
                op: "eq",
                field: "resource",
                value: "proof",
              } as FieldComparison,
            ],
          } as NotExpression,
        };

        const result = service.evaluate(predicate, proofCreatedContext);
        expect(result.match).toBe(false);
      });
    });
  });

  describe("Complex nested predicates", () => {
    it("should evaluate deeply nested AND/OR combinations", () => {
      const predicate: Predicate = {
        predicateVersion: "1",
        logic: {
          op: "and",
          expressions: [
            {
              op: "or",
              expressions: [
                {
                  op: "eq",
                  field: "resource",
                  value: "proof",
                } as FieldComparison,
                {
                  op: "eq",
                  field: "resource",
                  value: "attestation",
                } as FieldComparison,
              ],
            } as OrExpression,
            {
              op: "or",
              expressions: [
                {
                  op: "eq",
                  field: "outcome",
                  value: "created",
                } as FieldComparison,
                {
                  op: "eq",
                  field: "outcome",
                  value: "verified",
                } as FieldComparison,
              ],
            } as OrExpression,
          ],
        } as AndExpression,
      };

      const result = service.evaluate(predicate, proofCreatedContext);
      expect(result.match).toBe(true);
    });
  });

  describe("Budget limits", () => {
    it("should respect evaluation budget and fail closed", () => {
      // Create an extremely complex predicate that will exceed the budget
      const deepPredicate = createDeeplyNestedPredicate(10);

      const result = service.evaluate(deepPredicate, proofCreatedContext);

      // Should fail closed (no delivery) when budget is exceeded
      expect(result.match).toBe(false);
      expect(result.reason).toBe("EVALUATION_BUDGET_EXCEEDED");
    });

    it("should track visited nodes correctly", () => {
      const predicate: Predicate = {
        predicateVersion: "1",
        logic: {
          op: "and",
          expressions: [
            {
              op: "eq",
              field: "resource",
              value: "proof",
            } as FieldComparison,
            {
              op: "eq",
              field: "outcome",
              value: "created",
            } as FieldComparison,
          ],
        } as AndExpression,
      };

      const result = service.evaluate(predicate, proofCreatedContext);
      expect(result.visited).toBeGreaterThan(0);
      expect(result.visited).toBeLessThanOrEqual(PREDICATE_EVALUATION_LIMITS.maxEvaluationBudget);
    });
  });

  describe("Context derivation", () => {
    it("should derive context from event type", () => {
      const context = service.deriveContext("proof.created", "1");

      expect(context.resource).toBe("proof");
      expect(context.outcome).toBe("created");
      expect(context.schemaVersion).toBe("1");
    });

    it("should handle complex event types", () => {
      const context = service.deriveContext("proof.verified", "2");

      expect(context.resource).toBe("proof");
      expect(context.outcome).toBe("verified");
      expect(context.schemaVersion).toBe("2");
    });

    it("should return empty context on malformed event type", () => {
      const context = service.deriveContext("invalid", "1");

      expect(context.resource).toBe("");
      expect(context.outcome).toBe("");
      expect(context.schemaVersion).toBe("1");
    });

    it("should handle event types with multiple dots gracefully", () => {
      const context = service.deriveContext("proof.created.nested", "1");

      // Only splits on the first dot
      expect(context.resource).toBe("proof");
      expect(context.outcome).toBe("created.nested");
      expect(context.schemaVersion).toBe("1");
    });
  });

  describe("Deterministic behavior", () => {
    it("should produce identical results on identical inputs", () => {
      const predicate: Predicate = {
        predicateVersion: "1",
        logic: {
          op: "and",
          expressions: [
            {
              op: "eq",
              field: "resource",
              value: "proof",
            } as FieldComparison,
            {
              op: "in",
              field: "outcome",
              values: ["created", "verified"],
            } as FieldInList,
          ],
        } as AndExpression,
      };

      const result1 = service.evaluate(predicate, proofCreatedContext);
      const result2 = service.evaluate(predicate, proofCreatedContext);

      expect(result1.match).toBe(result2.match);
      expect(result1.reason).toBe(result2.reason);
      expect(result1.visited).toBe(result2.visited);
    });
  });

  describe("Error handling", () => {
    it("should fail closed on unknown operators", () => {
      const malformedPredicate = {
        predicateVersion: "1",
        logic: {
          op: "unknown_operator",
          field: "resource",
          value: "proof",
        },
      } as any;

      const result = service.evaluate(malformedPredicate, proofCreatedContext);

      expect(result.match).toBe(false);
      expect(result.reason).toBe("UNKNOWN_OPERATOR");
    });

    it("should fail closed on malformed expression", () => {
      const malformedPredicate = {
        predicateVersion: "1",
        logic: null,
      } as any;

      const result = service.evaluate(malformedPredicate, proofCreatedContext);

      expect(result.match).toBe(false);
      expect(result.reason).toBe("EVALUATION_FAILED");
    });
  });
});

/**
 * Helper function to create a deeply nested predicate for budget testing.
 *
 * Creates an AND chain n levels deep, forcing evaluation of many nodes.
 */
function createDeeplyNestedPredicate(depth: number): Predicate {
  let expr: any = {
    op: "eq",
    field: "resource",
    value: "proof",
  } as FieldComparison;

  for (let i = 0; i < depth; i++) {
    expr = {
      op: "and",
      expressions: [
        expr,
        {
          op: "eq",
          field: "outcome",
          value: "created",
        } as FieldComparison,
      ],
    } as AndExpression;
  }

  return {
    predicateVersion: "1",
    logic: expr,
  };
}
