import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import {
  MAX_CONTINUITY_PERIODS,
  MIN_CONTINUITY_PERIODS,
} from "../employment-continuity.policy";

export class CreateEmploymentContinuityProofDto {
  @ApiProperty({
    description:
      "ID of one of the caller's trusted sources. It must be active and linked to an active issuer. All counted payments come from this one source.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(FIELD_LIMITS.id)
  trustedSourceId!: string;

  @ApiProperty({ example: "USDC" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(FIELD_LIMITS.assetCode)
  assetCode!: string;

  @ApiPropertyOptional({
    description: "Asset issuer address. Omit for native XLM.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(FIELD_LIMITS.stellarAddress)
  assetIssuer?: string;

  @ApiProperty({
    description:
      "Start of the first observed period. Must be exactly the first instant of a UTC calendar month.",
    example: "2026-01-01T00:00:00.000Z",
  })
  @IsDateString()
  periodStart!: string;

  @ApiProperty({
    description:
      "Number of consecutive UTC calendar months to observe. The whole window must already have ended.",
    minimum: MIN_CONTINUITY_PERIODS,
    maximum: MAX_CONTINUITY_PERIODS,
    example: 6,
  })
  @IsInt()
  @Min(MIN_CONTINUITY_PERIODS)
  @Max(MAX_CONTINUITY_PERIODS)
  observedPeriods!: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 365, default: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
