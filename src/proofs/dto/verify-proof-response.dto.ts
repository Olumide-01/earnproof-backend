import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ProofType, RevocationReasonCode, VerificationResult } from "@prisma/client";
import { SignedCredentialDto } from "./proof-created.dto";

export class ContractStatusDto {
  @ApiProperty({
    description: "Whether an on-chain status check was performed.",
    example: false,
  })
  checked!: boolean;

  @ApiPropertyOptional({
    description: "Whether the proof is revoked on-chain. Present only when `checked` is true.",
    example: false,
  })
  revoked?: boolean;

  @ApiPropertyOptional({
    description: "Whether the on-chain state is consistent with the off-chain state.",
    example: true,
  })
  valid?: boolean;

  @ApiPropertyOptional({
    description: "Human-readable reason when the check was skipped.",
    example: "disabled",
  })
  reason?: string;
}

export class ProofSummaryDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  id!: string;

  @ApiProperty({ enum: ProofType, example: ProofType.MINIMUM_INCOME })
  type!: ProofType;

  @ApiProperty({ example: "earnproof.minimum-income.v1" })
  schemaVersion!: string;

  @ApiProperty({ example: "testnet" })
  network!: string;

  @ApiProperty({ example: "2025-01-15T12:00:00.000Z" })
  issuedAt!: string;

  @ApiProperty({ example: "2025-02-14T12:00:00.000Z" })
  expiresAt!: string;

  @ApiPropertyOptional({
    description: "ISO-8601 UTC timestamp when the proof was revoked, or null.",
    nullable: true,
    example: null,
  })
  revokedAt!: string | null;

  @ApiPropertyOptional({
    description:
      "Closed, public-safe reason the proof was revoked, or null. Never the private operator note.",
    enum: RevocationReasonCode,
    nullable: true,
    example: null,
  })
  revocationReasonCode!: RevocationReasonCode | null;

  @ApiProperty({ type: () => ContractStatusDto })
  contractStatus!: ContractStatusDto;
}

export class VerifyProofResponseDto {
  @ApiProperty({
    description: "Machine-readable verification outcome.",
    enum: VerificationResult,
    example: VerificationResult.VALID,
  })
  result!: VerificationResult;

  @ApiProperty({
    description: "Human-readable status string derived from `result`.",
    example: "valid",
    enum: ["valid", "expired", "revoked", "invalid", "unknown"],
  })
  status!: string;

  @ApiPropertyOptional({
    type: () => SignedCredentialDto,
    description: "Absent when the proof ID is unknown.",
  })
  credential?: SignedCredentialDto;

  @ApiPropertyOptional({
    type: () => ProofSummaryDto,
    description: "Absent when the proof ID is unknown.",
  })
  proof?: ProofSummaryDto;
}
