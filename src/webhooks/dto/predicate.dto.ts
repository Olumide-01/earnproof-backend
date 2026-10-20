import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNull,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import { PREDICATE_FIELDS, PREDICATE_VERSIONS, PredicateField, PredicateVersion } from "../predicate.types";
import {
  ValidatePredicateExpression,
  ValidatePredicateValueLength,
} from "../validation/predicate.validators";

/**
 * Predicate field comparison: field equals a single value.
 *
 * Example: { op: "eq", field: "resource", value: "proof" }
 */
export class FieldComparisonDto {
  @ApiProperty({
    description: "Operator: exact match",
    enum: ["eq"],
  })
  @IsIn(["eq"])
  op!: "eq";

  @ApiProperty({
    description: "Field to compare",
    enum: PREDICATE_FIELDS,
  })
  @IsIn(PREDICATE_FIELDS)
  field!: PredicateField;

  @ApiProperty({
    description: "Value to match. Must be string, number, boolean, or null.",
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "null" },
    ],
  })
  @ValidatePredicateValueLength()
  value!: string | number | boolean | null;
}

/**
 * Predicate field in-list: field is one of the given values.
 *
 * Example: { op: "in", field: "resource", values: ["proof", "attestation"] }
 */
export class FieldInListDto {
  @ApiProperty({
    description: "Operator: one-of match",
    enum: ["in"],
  })
  @IsIn(["in"])
  op!: "in";

  @ApiProperty({
    description: "Field to check",
    enum: PREDICATE_FIELDS,
  })
  @IsIn(PREDICATE_FIELDS)
  field!: PredicateField;

  @ApiProperty({
    description: "Values list. If field matches any value, predicate matches.",
    type: [["string", "number", "boolean", "null"]],
    example: ["proof", "attestation"],
  })
  @IsArray()
  @IsNotEmpty({ message: "values array must not be empty" })
  @ValidatePredicateExpression("in")
  values!: (string | number | boolean | null)[];
}

/**
 * Logical AND: all sub-expressions must match. Short-circuits on first false.
 *
 * Example: { op: "and", expressions: [{ op: "eq", field: "resource", value: "proof" }, ...] }
 */
export class AndExpressionDto {
  @ApiProperty({
    description: "Operator: logical AND",
    enum: ["and"],
  })
  @IsIn(["and"])
  op!: "and";

  @ApiProperty({
    description: "Sub-expressions. All must match. Accepts 2 or more expressions.",
    type: [Object], // Recursive type, loosely typed in swagger
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Object) // Type inference for recursive types is complex; accept Object and validate at runtime
  @ValidatePredicateExpression("and")
  expressions!: object[];
}

/**
 * Logical OR: any sub-expression must match. Short-circuits on first true.
 *
 * Example: { op: "or", expressions: [{ op: "eq", field: "outcome", value: "created" }, ...] }
 */
export class OrExpressionDto {
  @ApiProperty({
    description: "Operator: logical OR",
    enum: ["or"],
  })
  @IsIn(["or"])
  op!: "or";

  @ApiProperty({
    description: "Sub-expressions. Any must match. Accepts 2 or more expressions.",
    type: [Object],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Object)
  @ValidatePredicateExpression("or")
  expressions!: object[];
}

/**
 * Logical NOT: negates a single sub-expression.
 *
 * Example: { op: "not", expressions: [{ op: "eq", field: "outcome", value: "failed" }] }
 */
export class NotExpressionDto {
  @ApiProperty({
    description: "Operator: logical NOT",
    enum: ["not"],
  })
  @IsIn(["not"])
  op!: "not";

  @ApiProperty({
    description: "Sub-expression. Exactly one expression; its result is negated.",
    type: [Object],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => Object)
  @ValidatePredicateExpression("not")
  expressions!: object[];
}

/**
 * Predicate expression: any atomic or logical predicate.
 *
 * This is a union type; class-validator cannot directly validate unions,
 * so we use a custom validator that inspects the `op` field and applies
 * the appropriate schema.
 */
export type PredicateExpressionDto =
  | FieldComparisonDto
  | FieldInListDto
  | AndExpressionDto
  | OrExpressionDto
  | NotExpressionDto;

/**
 * Root predicate structure, versioned.
 *
 * Example:
 * ```json
 * {
 *   "predicateVersion": "1",
 *   "logic": { "op": "eq", "field": "resource", "value": "proof" }
 * }
 * ```
 */
export class PredicateDto {
  @ApiProperty({
    description: "Predicate grammar version. Only known versions are accepted.",
    enum: PREDICATE_VERSIONS,
    example: "1",
  })
  @IsString()
  @IsIn(PREDICATE_VERSIONS as unknown as string[])
  @IsNotEmpty()
  predicateVersion!: PredicateVersion;

  @ApiProperty({
    description: "The evaluation tree. Starts with an operator and recursively nests.",
    oneOf: [
      { $ref: "#/components/schemas/FieldComparisonDto" },
      { $ref: "#/components/schemas/FieldInListDto" },
      { $ref: "#/components/schemas/AndExpressionDto" },
      { $ref: "#/components/schemas/OrExpressionDto" },
      { $ref: "#/components/schemas/NotExpressionDto" },
    ],
  })
  @IsNotEmpty({ message: "logic field is required" })
  @Type(() => Object) // Runtime type is checked by validator
  @ValidatePredicateExpression("root")
  logic!: object; // Validated as PredicateExpression at runtime
}

/**
 * Optional predicate payload for creating or updating webhooks.
 *
 * If predicate is omitted or null, the subscription matches only on event type
 * (backward compatible with existing subscriptions).
 */
export class OptionalPredicateDto {
  @ApiPropertyOptional({
    description:
      "Optional predicate to narrow which events trigger this webhook. " +
      "If omitted or null, all subscribed event types match. " +
      "If provided, both event type AND predicate must match.",
    type: PredicateDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PredicateDto)
  predicate?: PredicateDto | null;
}

/**
 * Sample event for predicate preview: resource, outcome, and schema version.
 *
 * Used to test a predicate without actually delivering a webhook.
 */
export class PredicatePreviewEventDto {
  @ApiProperty({
    description: "Resource type (e.g., 'proof', 'attestation')",
    example: "proof",
  })
  @IsString()
  @IsNotEmpty()
  resource!: string;

  @ApiProperty({
    description: "Outcome code (e.g., 'created', 'verified', 'revoked')",
    example: "created",
  })
  @IsString()
  @IsNotEmpty()
  outcome!: string;

  @ApiProperty({
    description: "Payload schema version (e.g., '1')",
    example: "1",
  })
  @IsString()
  @IsNotEmpty()
  schemaVersion!: string;
}

/**
 * Request body for predicate preview endpoint.
 *
 * Takes a predicate and a sample event; returns whether the predicate matches
 * and how many nodes were visited during evaluation.
 */
export class PredicatePreviewRequestDto {
  @ApiProperty({
    description: "The predicate to test.",
    type: PredicateDto,
  })
  @ValidateNested()
  @Type(() => PredicateDto)
  predicate!: PredicateDto;

  @ApiProperty({
    description: "Sample event to test the predicate against.",
    type: PredicatePreviewEventDto,
  })
  @ValidateNested()
  @Type(() => PredicatePreviewEventDto)
  event!: PredicatePreviewEventDto;
}

/**
 * Response from predicate preview endpoint.
 *
 * Returns whether the predicate matched, the reason if it didn't, and the number
 * of nodes visited during evaluation (for debugging).
 */
export class PredicatePreviewResponseDto {
  @ApiProperty({
    description: "Whether the predicate matched the sample event.",
    example: true,
  })
  match!: boolean;

  @ApiPropertyOptional({
    description:
      "Reason why evaluation stopped (e.g., 'NO_MATCH' or 'EVALUATION_BUDGET_EXCEEDED'). " +
      "Absent if match is true.",
    example: "NO_MATCH",
  })
  reason?: string;

  @ApiProperty({
    description: "Number of predicate nodes visited during evaluation.",
    example: 5,
  })
  visitedNodes!: number;
}
