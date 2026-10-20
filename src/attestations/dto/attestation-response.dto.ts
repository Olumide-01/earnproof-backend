import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ResourceStatus, AttestationType } from "@prisma/client";

export class AttestationResponseDto {
  @ApiProperty({
    description: "Attestation unique ID",
    example: "cuid123",
  })
  id: string;

  @ApiProperty({
    description: "Issuer ID that created this attestation",
    example: "cuid456",
  })
  issuerId: string;

  @ApiProperty({
    description: "Subject wallet hash (privacy-preserving)",
    example: "sha256:abcd1234...",
  })
  subjectWalletHash: string;

  @ApiPropertyOptional({
    description: "Optional payment reference hash",
    nullable: true,
  })
  paymentReferenceHash: string | null;

  @ApiProperty({
    description: "Attestation type",
    enum: ["PAYMENT", "EMPLOYMENT", "INVOICE"],
  })
  type: AttestationType;

  @ApiProperty({
    description: "Schema version used",
    example: "1.0",
  })
  schemaVersion: string;

  @ApiProperty({
    description: "Signing key version used",
    example: "1",
  })
  signingKeyVersionId: string;

  @ApiProperty({
    description: "Attestation lifecycle status",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  status: ResourceStatus;

  @ApiProperty({
    description: "ISO 8601 timestamp when attestation was created",
    example: "2025-01-15T10:30:00Z",
  })
  createdAt: Date;

  @ApiPropertyOptional({
    description: "ISO 8601 timestamp when attestation expires (if applicable)",
    nullable: true,
    example: "2025-12-31T23:59:59Z",
  })
  expiresAt: Date | null;

  @ApiPropertyOptional({
    description: "ISO 8601 timestamp when attestation was revoked",
    nullable: true,
  })
  revokedAt: Date | null;

  @ApiPropertyOptional({
    description: "User ID that revoked this attestation (audit trail)",
    nullable: true,
  })
  revokedBy: string | null;

  @ApiPropertyOptional({
    description: "Reason for revocation (audit trail)",
    nullable: true,
  })
  revocationReason: string | null;

  @ApiProperty({
    description: "ISO 8601 timestamp when attestation was last updated",
    example: "2025-01-15T10:30:00Z",
  })
  updatedAt: Date;

  @ApiProperty({
    description:
      "Whether the attestation is currently valid (active, not expired, not revoked)",
    example: true,
  })
  isValid: boolean;

  @ApiProperty({
    description: "Current lifecycle state (active, expired, or revoked)",
    example: "active",
  })
  lifecycleState: "active" | "expired" | "revoked";
}

export class ListAttestationsResponseDto {
  @ApiProperty({
    description: "Array of attestation summaries",
    type: [AttestationResponseDto],
  })
  items: AttestationResponseDto[];

  @ApiProperty({
    description: "Total number of attestations matching the filter",
    example: 50,
  })
  total: number;

  @ApiProperty({
    description: "Current page number (1-indexed)",
    example: 1,
  })
  page: number;

  @ApiProperty({
    description: "Items per page",
    example: 20,
  })
  limit: number;
}
