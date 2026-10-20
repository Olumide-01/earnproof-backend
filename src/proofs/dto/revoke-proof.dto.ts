import { ApiPropertyOptional } from "@nestjs/swagger";
import { RevocationReasonCode } from "@prisma/client";
import { IsEnum, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";

/** A "sha256:<64 lowercase hex chars>" evidence commitment, matching `commitment`. */
const EVIDENCE_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class RevokeProofDto {
  @ApiPropertyOptional({
    enum: RevocationReasonCode,
    default: RevocationReasonCode.OWNER_REQUESTED,
    description:
      "Closed, public-safe reason taxonomy. Returned from both the authorized and public verification views.",
  })
  @IsOptional()
  @IsEnum(RevocationReasonCode)
  reasonCode?: RevocationReasonCode;

  @ApiPropertyOptional({
    maxLength: FIELD_LIMITS.revocationReason,
    description:
      "Free-form private note. Never returned from the public verification endpoint.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(FIELD_LIMITS.revocationReason)
  reasonPrivate?: string;

  @ApiPropertyOptional({
    example: "sha256:" + "a".repeat(64),
    description:
      "Optional fixed-size commitment (sha256, hex) to off-chain revocation evidence held by the caller.",
  })
  @IsOptional()
  @IsString()
  @Matches(EVIDENCE_HASH_PATTERN, {
    message: "evidenceHash must be a sha256 commitment in the form sha256:<64 hex chars>",
  })
  evidenceHash?: string;
}
