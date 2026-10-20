import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  AuditLegalHoldAuthority,
  AuditLegalHoldScope,
  AuditLegalHoldStatus,
} from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";

/**
 * Request body for a new legal hold.
 *
 * There is intentionally no free-text field. The reason is supplied only as a
 * SHA-256 commitment computed by the requester (for example over the matter
 * reference and instruction letter), so the hold proves which reason was cited
 * without the case narrative ever reaching this service.
 */
export class CreateAuditLegalHoldDto {
  @ApiProperty({ enum: AuditLegalHoldScope })
  @IsEnum(AuditLegalHoldScope)
  scope!: AuditLegalHoldScope;

  @ApiPropertyOptional({
    description: "Required for ORGANIZATION scope; must be omitted for PLATFORM scope.",
  })
  @ValidateIf((dto: CreateAuditLegalHoldDto) => dto.scope === "ORGANIZATION" || dto.organizationId !== undefined)
  @IsString()
  @MaxLength(64)
  organizationId?: string;

  @ApiProperty({ enum: AuditLegalHoldAuthority })
  @IsEnum(AuditLegalHoldAuthority)
  authority!: AuditLegalHoldAuthority;

  @ApiProperty({
    description: "Lowercase hex SHA-256 commitment to the hold reason. Never the reason itself.",
    example: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  })
  @Matches(/^[0-9a-f]{64}$/, {
    message: "reasonCommitment must be a lowercase hex SHA-256 digest",
  })
  reasonCommitment!: string;

  @ApiProperty({ format: "date-time", description: "Inclusive start of the held AuditLog.createdAt range." })
  @Type(() => Date)
  @IsDate()
  rangeStart!: Date;

  @ApiProperty({ format: "date-time", description: "Inclusive end of the held AuditLog.createdAt range." })
  @Type(() => Date)
  @IsDate()
  rangeEnd!: Date;

  @ApiProperty({
    format: "date-time",
    description: "When the hold stops protecting records (exclusive). At most 730 days ahead.",
  })
  @Type(() => Date)
  @IsDate()
  expiresAt!: Date;
}

export class AuditLegalHoldTransitionDto {
  @ApiProperty({
    minimum: 0,
    description: "Revision the decision was based on. A mismatch is rejected with 409.",
  })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class ListAuditLegalHoldsDto {
  @ApiPropertyOptional({ enum: AuditLegalHoldStatus })
  @IsOptional()
  @IsEnum(AuditLegalHoldStatus)
  status?: AuditLegalHoldStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: "Id of the last hold on the previous page." })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}
