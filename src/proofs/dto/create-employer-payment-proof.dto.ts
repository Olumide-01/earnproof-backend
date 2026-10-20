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

export class CreateEmployerPaymentProofDto {
  @ApiProperty({
    description:
      "ID of one of the caller's trusted sources. It must be active and linked to an active issuer.",
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
    description: "Inclusive period start (ISO 8601).",
    example: "2026-07-01T00:00:00.000Z",
  })
  @IsDateString()
  periodStart!: string;

  @ApiProperty({
    description:
      "Exclusive period end (ISO 8601). At most 366 days after periodStart and not in the future.",
    example: "2026-08-01T00:00:00.000Z",
  })
  @IsDateString()
  periodEnd!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 365, default: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
