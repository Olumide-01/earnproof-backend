import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ProofStatus,
  ProofType,
  RevocationActorType,
  RevocationReasonCode,
} from "@prisma/client";

export class ProofAssetDto {
  @ApiProperty({ example: "USDC" })
  code!: string;

  @ApiPropertyOptional({ nullable: true })
  issuer!: string | null;
}

export class ProofAnchoringSummaryDto {
  @ApiProperty({ example: true })
  anchored!: boolean;

  @ApiProperty({
    enum: [
      "not_anchored",
      "recorded",
      "valid",
      "revoked",
      "invalid",
      "unavailable",
    ],
    example: "recorded",
  })
  status!: string;

  @ApiPropertyOptional({ description: "Stellar anchoring transaction hash." })
  transactionHash?: string;

  @ApiPropertyOptional({
    description:
      "Whether the issuer-registry contract was checked for this response.",
  })
  checked?: boolean;
}

export class ProofHistoryItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ProofType })
  type!: ProofType;

  @ApiProperty()
  schemaVersion!: string;

  @ApiProperty({ enum: ProofStatus })
  localStatus!: ProofStatus;

  @ApiProperty({ enum: ["valid", "expired", "revoked", "invalid"] })
  credentialValidity!: string;

  @ApiProperty()
  expired!: boolean;

  @ApiProperty({ type: () => ProofAssetDto })
  asset!: ProofAssetDto;

  @ApiPropertyOptional({ nullable: true })
  periodStart!: string | null;

  @ApiPropertyOptional({ nullable: true })
  periodEnd!: string | null;

  @ApiProperty()
  issuedAt!: string;

  @ApiProperty()
  expiresAt!: string;

  @ApiPropertyOptional({ nullable: true })
  revokedAt!: string | null;

  @ApiPropertyOptional({ enum: RevocationActorType, nullable: true })
  revokedByType!: RevocationActorType | null;

  @ApiPropertyOptional({ enum: RevocationReasonCode, nullable: true })
  revocationReasonCode!: RevocationReasonCode | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "Private operator note. Only present in this authorized owner/admin view.",
  })
  revocationReasonPrivate!: string | null;

  @ApiPropertyOptional({ nullable: true, example: "sha256:" + "a".repeat(64) })
  revocationEvidenceHash!: string | null;

  @ApiProperty({ type: () => ProofAnchoringSummaryDto })
  anchoring!: ProofAnchoringSummaryDto;
}

export class ProofPageInfoDto {
  @ApiProperty()
  hasMore!: boolean;

  @ApiPropertyOptional({ nullable: true })
  nextCursor!: string | null;
}

export class ProofListResponseDto {
  @ApiProperty({ type: [ProofHistoryItemDto] })
  data!: ProofHistoryItemDto[];

  @ApiProperty({ type: () => ProofPageInfoDto })
  pageInfo!: ProofPageInfoDto;
}

export class ProofClaimSummaryDto {
  @ApiProperty()
  operator!: string;

  @ApiProperty()
  result!: boolean;

  @ApiPropertyOptional()
  qualifyingPaymentCount?: number;
}

export class ProofDetailResponseDto extends ProofHistoryItemDto {
  @ApiPropertyOptional({ type: () => ProofClaimSummaryDto })
  claim?: ProofClaimSummaryDto;
}
