import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Immutable issuer policy commitment snapshot.
 *
 * Represents a frozen version of issuer state (signing key, address, metadata)
 * at a point in time. Proofs reference commitments by ID to enable verification
 * even after issuer policies change (#307).
 */
export class IssuerPolicyCommitmentDto {
  @ApiProperty({
    description: "Commitment unique ID",
  })
  id: string;

  @ApiProperty({
    description: "Issuer ID this commitment belongs to",
  })
  issuerId: string;

  @ApiProperty({
    description:
      "Version number (monotonically increasing per issuer). Prevents regression attacks.",
  })
  version: number;

  @ApiProperty({
    description:
      'SHA-256 commitment hash of the policy snapshot: "sha256:<hex>". Deterministic and immutable.',
  })
  commitment: string;

  @ApiProperty({
    description:
      'SHA-256 hash of the canonical policy inputs: "sha256:<hex>". Used for deduplication.',
  })
  policyInputsHash: string;

  @ApiProperty({
    description:
      "Frozen copy of issuer policy at this version. Includes signingKeyVersionId, stellarAddress, publicMetadata, status.",
    type: "object",
  })
  policySnapshot: Record<string, unknown>;

  @ApiProperty({
    description:
      "ISO 8601 timestamp when this policy version became effective",
  })
  effectiveAt: Date;

  @ApiPropertyOptional({
    description:
      "ISO 8601 timestamp when this policy was superseded by the next version. Null = current active commitment.",
    nullable: true,
  })
  supersededAt: Date | null;

  @ApiPropertyOptional({
    description: "Optional audit trail linkage (domain event ID, audit log ID)",
    nullable: true,
  })
  correlationId: string | null;

  @ApiProperty({
    description: "ISO 8601 timestamp when commitment was created",
  })
  createdAt: Date;
}

/**
 * Paginated list of issuer policy commitments (version history).
 */
export class ListIssuerPolicyCommitmentsResponseDto {
  @ApiProperty({
    description: "Array of policy commitments, ordered newest first",
    type: [IssuerPolicyCommitmentDto],
  })
  items: IssuerPolicyCommitmentDto[];

  @ApiProperty({
    description: "Total number of commitments for this issuer",
  })
  total: number;

  @ApiProperty({
    description: "Whether there are more results beyond the current page",
  })
  hasMore: boolean;

  @ApiPropertyOptional({
    description:
      "Current active commitment (supersededAt is null). Included for convenience.",
  })
  currentCommitment?: IssuerPolicyCommitmentDto;
}

/**
 * Query parameters for listing issuer policy commitments.
 */
export class ListIssuerPolicyCommitmentsQueryDto {
  @ApiPropertyOptional({
    description: "Number of results to return (default: 50, max: 1000)",
    type: Number,
    example: 50,
  })
  limit?: number;

  @ApiPropertyOptional({
    description: "Offset for pagination (default: 0)",
    type: Number,
    example: 0,
  })
  offset?: number;
}

/**
 * Current active policy commitment (convenience endpoint).
 */
export class CurrentIssuerPolicyCommitmentResponseDto {
  @ApiProperty({
    description: "Active policy commitment for the issuer",
  })
  commitment: IssuerPolicyCommitmentDto;

  @ApiProperty({
    description:
      'Whether this is a new commitment (version 1) or an update (version > 1)',
  })
  isFirstVersion: boolean;
}

/**
 * Response when querying commitment at a specific point in time.
 */
export class IssuerPolicyCommitmentAtTimeResponseDto {
  @ApiProperty({
    description: "Policy commitment that was effective at the queried timestamp",
  })
  commitment: IssuerPolicyCommitmentDto;

  @ApiProperty({
    description:
      "Whether this commitment was active (not yet superseded) at the query time",
  })
  wasActive: boolean;
}
