import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { VerifyCredentialResult } from "../credentials.service";
import { VERIFY_CREDENTIAL_RESULTS } from "./verify-credential-response.dto";

/**
 * The outcome of verifying one item in a batch.
 *
 * Exactly one of `result` or `error` is present. `result` carries the same
 * verdict the single-credential endpoint would return for that document;
 * `error` is set when the item itself was unusable (not an object, larger than
 * the per-item cap, or too deeply nested) — the batch equivalent of the 400 the
 * single route answers, isolated to the one item so the rest still report.
 */
export class BatchCredentialItemResultDto {
  @ApiProperty({
    description: "Zero-based position of this item in the submitted array.",
    example: 0,
  })
  index!: number;

  @ApiPropertyOptional({
    description:
      "Verification verdict, using the same values as the single-credential " +
      "endpoint. Absent when the item was rejected before verification could run.",
    enum: VERIFY_CREDENTIAL_RESULTS,
    example: "valid",
  })
  result?: VerifyCredentialResult;

  @ApiPropertyOptional({
    description:
      "Why this item could not be verified. Present only when `result` is absent.",
    example: "Credential payload must not exceed 32 KB",
  })
  error?: string;
}

export class VerifyCredentialsBatchResponseDto {
  @ApiProperty({
    type: [BatchCredentialItemResultDto],
    description:
      "One entry per submitted credential, in submission order. The response is " +
      "always 200 when the batch itself was accepted; read each item's `result` " +
      "or `error` for its individual outcome.",
  })
  results!: BatchCredentialItemResultDto[];
}
