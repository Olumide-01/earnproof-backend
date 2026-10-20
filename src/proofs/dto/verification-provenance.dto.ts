/**
 * Verification provenance DTOs.
 *
 * Public-facing request/response DTOs for provenance query and disclosure endpoints.
 * Never expose internal hashes; only auditable lineage metadata.
 */

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { VerificationProvenanceSourceType } from "@prisma/client";

/**
 * Source observation in a provenance record.
 */
export class VerificationProvenanceSourceDto {
  @ApiProperty({
    description: "Type of source (CREDENTIAL_SOURCE, BACKEND_OBSERVATION, CONTRACT_OBSERVATION, STELLAR_OBSERVATION)",
    enum: ["CREDENTIAL_SOURCE", "BACKEND_OBSERVATION", "CONTRACT_OBSERVATION", "STELLAR_OBSERVATION"],
    example: "CREDENTIAL_SOURCE",
  })
  sourceType!: string;

  @ApiProperty({
    description: "Specific source identity (e.g., paymentId, attestationId, operationId)",
    example: "payment-abc123",
  })
  sourceId!: string;

  @ApiPropertyOptional({
    description: "Human-readable source label",
    example: "PAYMENT_RECEIVED",
  })
  sourceLabel?: string;

  @ApiProperty({
    description: "ISO-8601 timestamp when source was observed",
    example: "2026-01-15T10:00:00.000Z",
  })
  observedAt!: string;

  @ApiProperty({
    description: "Sequential position in decision lineage",
    example: 0,
  })
  observationOrder!: number;

  @ApiPropertyOptional({
    description: "Reason if source was unavailable or excluded",
    example: "STALE_CHECKPOINT",
  })
  missingLinkReason?: string;
}

/**
 * Complete verification provenance record.
 */
export class VerificationProvenanceDto {
  @ApiProperty({
    description: "ISO-8601 timestamp when decision was made",
    example: "2026-01-15T10:00:00.000Z",
  })
  decidedAt!: string;

  @ApiProperty({
    description: "Versioned schema (e.g., earnproof.verification.provenance.v1)",
    example: "earnproof.verification.provenance.v1",
  })
  schemaVersion!: string;

  @ApiProperty({
    description: "Policy version applied to this decision",
    example: "earnproof.minimum-income.policy.v1",
  })
  policyVersion!: string;

  @ApiProperty({
    description: "Proof status at verification time",
    example: "ACTIVE",
    enum: ["ACTIVE", "EXPIRED", "REVOKED", "INVALID"],
  })
  proofStatus!: string;

  @ApiProperty({
    description: "Final verification result",
    example: "VALID",
    enum: [
      "VALID",
      "EXPIRED",
      "REVOKED",
      "INVALID_SIGNATURE",
      "UNKNOWN_PROOF",
      "UNVERIFIED_ISSUER",
    ],
  })
  verificationResult!: string;

  @ApiPropertyOptional({
    description: "High-level failure reason if verification failed",
    example: "CREDENTIAL_MISMATCH",
  })
  failureReason?: string;

  @ApiPropertyOptional({
    description: "Optional context about boundary conditions",
    example: "Stellar Horizon unavailable; stale checkpoint acceptable per policy",
  })
  boundaryContext?: string;

  @ApiProperty({
    description: "All sources that contributed to this decision, in observation order",
    type: () => [VerificationProvenanceSourceDto],
  })
  sources!: VerificationProvenanceSourceDto[];

  @ApiProperty({
    description: "Total number of sources",
    example: 3,
  })
  sourceCount!: number;
}

/**
 * List of provenance records for a proof.
 */
export class ListVerificationProvenanceResponseDto {
  @ApiProperty({
    description: "Proof ID",
    example: "proof-xyz789",
  })
  proofId!: string;

  @ApiProperty({
    description: "Chronological list of provenance records",
    type: () => [VerificationProvenanceDto],
  })
  provenances!: VerificationProvenanceDto[];

  @ApiProperty({
    description: "Total count of provenance records for this proof",
    example: 5,
  })
  total!: number;
}

/**
 * Filtered sources by type.
 */
export class VerificationProvenanceSourcesByTypeDto {
  @ApiProperty({
    description: "Source type filter applied",
    enum: ["CREDENTIAL_SOURCE", "BACKEND_OBSERVATION", "CONTRACT_OBSERVATION", "STELLAR_OBSERVATION"],
    example: "CREDENTIAL_SOURCE",
  })
  sourceType!: string;

  @ApiProperty({
    description: "Filtered sources",
    type: () => [VerificationProvenanceSourceDto],
  })
  sources!: VerificationProvenanceSourceDto[];

  @ApiProperty({
    description: "Total count of sources matching filter",
    example: 2,
  })
  total!: number;
}

/**
 * Provenance availability summary for a proof.
 */
export class VerificationProvenanceSummaryDto {
  @ApiProperty({
    description: "Proof ID",
    example: "proof-xyz789",
  })
  proofId!: string;

  @ApiProperty({
    description: "Whether provenance data exists for this proof",
    example: true,
  })
  hasProvenance!: boolean;

  @ApiPropertyOptional({
    description: "Latest decision timestamp if provenance exists",
    example: "2026-01-15T10:00:00.000Z",
  })
  latestDecidedAt?: string;

  @ApiPropertyOptional({
    description: "Count of provenance records if exists",
    example: 3,
  })
  provenanceCount?: number;

  @ApiPropertyOptional({
    description: "Latest verification result if provenance exists",
    example: "VALID",
  })
  latestVerificationResult?: string;

  @ApiPropertyOptional({
    description: "Total sources in latest provenance if exists",
    example: 4,
  })
  latestSourceCount?: number;
}
