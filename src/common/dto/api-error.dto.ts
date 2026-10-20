/**
 * Versioned error contract for all EarnProof API error responses.
 *
 * Compatibility note (v1):
 *   - `code` is stable across minor versions. New codes may be added; existing codes
 *     will not be renamed or removed without a major-version bump.
 *   - `message` is human-readable and may change without notice. Clients must not
 *     branch on the message text.
 *   - `violations` is present only on 422 validation errors.
 *   - `requestId` is always present.
 */

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Machine-readable error codes.
 * These are stable identifiers that clients can rely on for programmatic
 * handling. New values may be added; existing values will not change.
 */
export enum ApiErrorCode {
  // 400 – bad input from the client
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INVALID_INPUT = "INVALID_INPUT",

  // 401 – authentication required or failed
  MISSING_TOKEN = "MISSING_TOKEN",
  INVALID_TOKEN = "INVALID_TOKEN",
  EXPIRED_TOKEN = "EXPIRED_TOKEN",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  SESSION_EXPIRED = "SESSION_EXPIRED",

  // 403 – authenticated but not allowed
  FORBIDDEN = "FORBIDDEN",

  // 404 – resource does not exist (or is hidden for security)
  NOT_FOUND = "NOT_FOUND",
  PAYMENT_NOT_FOUND = "PAYMENT_NOT_FOUND",

  // 422 - payment cannot be used for the requested proof
  PAYMENT_NOT_ELIGIBLE = "PAYMENT_NOT_ELIGIBLE",
  PAYMENT_EXCLUDED = "PAYMENT_EXCLUDED",
  PAYMENT_AMBIGUOUS_MATCH = "PAYMENT_AMBIGUOUS_MATCH",
  ASSET_NOT_SUPPORTED = "ASSET_NOT_SUPPORTED",

  // 422 - proof cannot be shared in its current state
  PROOF_NOT_SHAREABLE = "PROOF_NOT_SHAREABLE",

  // 422 - an aggregate-earnings proof cannot be issued under its policy
  AGGREGATION_CROSS_ASSET_UNSUPPORTED = "AGGREGATION_CROSS_ASSET_UNSUPPORTED",
  AGGREGATION_INSUFFICIENT_PAYMENTS = "AGGREGATION_INSUFFICIENT_PAYMENTS",
  AGGREGATION_LIMIT_EXCEEDED = "AGGREGATION_LIMIT_EXCEEDED",

  // 422 - employer-payment proof cannot be issued from the selected source
  EMPLOYER_SOURCE_UNTRUSTED = "EMPLOYER_SOURCE_UNTRUSTED",
  EMPLOYER_SOURCE_AMBIGUOUS = "EMPLOYER_SOURCE_AMBIGUOUS",
  EMPLOYER_PAYMENT_NOT_FOUND = "EMPLOYER_PAYMENT_NOT_FOUND",

  // 422 - employment-continuity rule is not met or cannot be evaluated
  CONTINUITY_NOT_SATISFIED = "CONTINUITY_NOT_SATISFIED",
  CONTINUITY_LIMIT_EXCEEDED = "CONTINUITY_LIMIT_EXCEEDED",

  // 409 – request conflicts with current state
  CONFLICT = "CONFLICT",
  PAYMENT_ALREADY_SETTLED = "PAYMENT_ALREADY_SETTLED",
  INVOICE_REFERENCE_CONFLICT = "INVOICE_REFERENCE_CONFLICT",

  // 429 – rate limiting (short-window request throttling)
  // 413 – the request exceeded a transport or structural limit
  PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE",

  // 429 – rate limiting
  TOO_MANY_REQUESTS = "TOO_MANY_REQUESTS",

  // 429 – an organization operational quota is exhausted. Distinct from
  // TOO_MANY_REQUESTS: retrying immediately will not succeed; the quota
  // resets at the window boundary or when usage is reduced.
  QUOTA_EXCEEDED = "QUOTA_EXCEEDED",

  // 503 – a required dependency is unavailable
  DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE",

  // 500 – unexpected server-side failures
  INTERNAL_ERROR = "INTERNAL_ERROR",

  // Offline bundles (bounded offline verification)
  BUNDLE_GENERATION_FAILED = "BUNDLE_GENERATION_FAILED",
  BUNDLE_EXPIRED = "BUNDLE_EXPIRED",
  BUNDLE_TAMPERED = "BUNDLE_TAMPERED",
  BUNDLE_UNKNOWN_VERSION = "BUNDLE_UNKNOWN_VERSION",
  BUNDLE_UNKNOWN_SIGNATURE_VERSION = "BUNDLE_UNKNOWN_SIGNATURE_VERSION",
  BUNDLE_CHECKPOINT_STALE = "BUNDLE_CHECKPOINT_STALE",
  INVALID_BUNDLE_REQUEST = "INVALID_BUNDLE_REQUEST",
  BUNDLE_EXPIRY_IN_PAST = "BUNDLE_EXPIRY_IN_PAST",
  BUNDLE_EXPIRY_TOO_FAR = "BUNDLE_EXPIRY_TOO_FAR",
  BUNDLE_SCOPE_AUTHORIZATION_FAILED = "BUNDLE_SCOPE_AUTHORIZATION_FAILED",
  BUNDLE_PROOF_NOT_ACCESSIBLE = "BUNDLE_PROOF_NOT_ACCESSIBLE",
  BUNDLE_FRESHNESS_EXCEEDS_POLICY = "BUNDLE_FRESHNESS_EXCEEDS_POLICY",

  // 400 – webhook predicate validation errors
  PREDICATE_VERSION_UNKNOWN = "PREDICATE_VERSION_UNKNOWN",
  PREDICATE_MISSING_VERSION = "PREDICATE_MISSING_VERSION",
  PREDICATE_INVALID_OPERATOR = "PREDICATE_INVALID_OPERATOR",
  PREDICATE_INVALID_FIELD = "PREDICATE_INVALID_FIELD",
  PREDICATE_MISSING_FIELD = "PREDICATE_MISSING_FIELD",
  PREDICATE_MISSING_LOGIC = "PREDICATE_MISSING_LOGIC",
  PREDICATE_TOO_DEEP = "PREDICATE_TOO_DEEP",
  PREDICATE_TOO_MANY_NODES = "PREDICATE_TOO_MANY_NODES",
  PREDICATE_VALUE_TOO_LONG = "PREDICATE_VALUE_TOO_LONG",
  PREDICATE_IN_LIST_TOO_LARGE = "PREDICATE_IN_LIST_TOO_LARGE",
  PREDICATE_IN_LIST_EMPTY = "PREDICATE_IN_LIST_EMPTY",
  PREDICATE_INVALID_VALUE_TYPE = "PREDICATE_INVALID_VALUE_TYPE",
  PREDICATE_MALFORMED_JSON = "PREDICATE_MALFORMED_JSON",
  PREDICATE_UNKNOWN_FIELD = "PREDICATE_UNKNOWN_FIELD",
  PREDICATE_AND_EXPRESSIONS_TOO_FEW = "PREDICATE_AND_EXPRESSIONS_TOO_FEW",
  PREDICATE_OR_EXPRESSIONS_TOO_FEW = "PREDICATE_OR_EXPRESSIONS_TOO_FEW",
  PREDICATE_NOT_EXPRESSIONS_WRONG_COUNT = "PREDICATE_NOT_EXPRESSIONS_WRONG_COUNT",
}

/** A single field-level validation violation. */
export class FieldViolationDto {
  @ApiProperty({
    description: "The name of the field that failed validation.",
    example: "walletAddress",
  })
  field!: string;

  @ApiProperty({
    description:
      "Human-readable description of the constraint that was violated.",
    example: "walletAddress must be exactly 56 characters",
  })
  message!: string;
}

  /**
   * The standard error envelope returned for all non-2xx responses.
   *
   * @example
   * {
   *   "statusCode": 401,
   *   "code": "INVALID_TOKEN",
   *   "message": "Authentication token is invalid.",
   *   "requestId": "01hwzxyz..."
   * }
   */
  export class ApiErrorDto {
    @ApiProperty({
      description: "HTTP status code.",
      example: 401,
    })
    statusCode!: number;

    @ApiProperty({
      description:
        "Stable machine-readable error code. Clients should branch on this, not on `message`.",
      enum: ApiErrorCode,
      example: ApiErrorCode.INVALID_TOKEN,
    })
    code!: ApiErrorCode;

    @ApiProperty({
      description:
        "Human-readable error description. May change across releases; do not parse.",
      example: "Authentication token is invalid.",
    })
    message!: string;

    @ApiProperty({
      description:
        "Unique identifier for this request. Include this in bug reports and support tickets.",
      example: "01hwzxyz1234abcd",
    })
    requestId!: string;

    @ApiPropertyOptional({
      description:
        "Present only on 422 validation errors. Lists each field that failed.",
      type: [FieldViolationDto],
    })
    violations?: FieldViolationDto[];

    @ApiPropertyOptional({
      description:
        "Present only on 409 conflict errors. Current revision of the resource.",
      example: 5,
    })
    currentRevision?: number;
  }
