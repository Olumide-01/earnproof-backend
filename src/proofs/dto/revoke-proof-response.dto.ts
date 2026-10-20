import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ProofStatus, RevocationActorType, RevocationReasonCode } from "@prisma/client";
import { AnchoringResultDto } from "./proof-created.dto";

export class RevokeProofResponseDto {
  @ApiProperty({ example: "clx1abc2def3ghi4" })
  id!: string;

  @ApiProperty({ enum: ProofStatus, example: ProofStatus.REVOKED })
  status!: ProofStatus;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp when the proof was revoked.",
    example: "2025-01-20T15:30:00.000Z",
  })
  revokedAt!: string;

  @ApiProperty({ enum: RevocationActorType, example: RevocationActorType.OWNER })
  revokedByType!: RevocationActorType;

  @ApiProperty({ enum: RevocationReasonCode, example: RevocationReasonCode.OWNER_REQUESTED })
  revocationReasonCode!: RevocationReasonCode;

  @ApiPropertyOptional({
    description: "Private operator note. Only present for the owner or an administrator.",
  })
  revocationReasonPrivate?: string | null;

  @ApiPropertyOptional({ example: "sha256:" + "a".repeat(64) })
  revocationEvidenceHash?: string | null;

  @ApiProperty({ type: () => AnchoringResultDto })
  anchoring!: AnchoringResultDto;
}
