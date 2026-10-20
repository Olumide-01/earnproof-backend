import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import {
  DEFAULT_ROUNDING_INCREMENT,
  MAX_PERIOD_DAYS,
  ROUNDING_INCREMENTS,
  RoundingIncrement,
  SOURCE_SCOPES,
  SourceScope,
} from "../aggregate-earnings.policy";

/** Issuers one request may name. */
export const MAX_AGGREGATE_ISSUER_IDS = 50;

/** Assets one request may name. More than one distinct asset is refused. */
export const MAX_AGGREGATE_ASSETS = 10;

export class AggregateAssetDto {
  @ApiProperty({ description: "Stellar asset code.", example: "USDC" })
  @IsString()
  @MaxLength(FIELD_LIMITS.assetCode)
  code!: string;

  @ApiPropertyOptional({
    description: "Stellar issuer address for the asset. Omit for native XLM.",
    example: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGLA1PIC4CEXLRTKHB0EGB",
  })
  @IsOptional()
  @IsString()
  @MaxLength(FIELD_LIMITS.stellarAddress)
  issuer?: string;
}

export class CreateAggregateEarningsProofDto {
  @ApiProperty({
    description:
      "Assets to aggregate. Exactly one distinct asset is supported: aggregating across " +
      "assets requires a conversion policy and is refused with AGGREGATION_CROSS_ASSET_UNSUPPORTED.",
    type: [AggregateAssetDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_AGGREGATE_ASSETS)
  @ValidateNested({ each: true })
  @Type(() => AggregateAssetDto)
  assets!: AggregateAssetDto[];

  @ApiProperty({
    description:
      "Start of the aggregation period (inclusive). The period is half-open, " +
      `[periodStart, periodEnd), and at most ${MAX_PERIOD_DAYS} days long.`,
    example: "2026-01-01T00:00:00.000Z",
  })
  @IsDateString()
  periodStart!: string;

  @ApiProperty({
    description:
      "End of the aggregation period (exclusive). Must be after periodStart and not in the future.",
    example: "2026-04-01T00:00:00.000Z",
  })
  @IsDateString()
  periodEnd!: string;

  @ApiPropertyOptional({
    description:
      "Which eligible income payments count. income: every eligible INCOME payment. " +
      "trusted_sources: only payments from the caller's active trusted sources. " +
      "verified_issuers: only payments from active registered issuers (optionally restricted by issuerIds).",
    enum: SOURCE_SCOPES,
    default: "income",
  })
  @IsOptional()
  @IsIn(SOURCE_SCOPES)
  sourceScope?: SourceScope;

  @ApiPropertyOptional({
    description: "Only with sourceScope=verified_issuers: restrict to these active issuers.",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_AGGREGATE_ISSUER_IDS)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(FIELD_LIMITS.id, { each: true })
  issuerIds?: string[];

  @ApiPropertyOptional({
    description:
      "Disclosure granularity. The exact total is floored to a multiple of this value, so the " +
      "disclosed aggregate never overstates earnings.",
    enum: ROUNDING_INCREMENTS,
    default: DEFAULT_ROUNDING_INCREMENT,
  })
  @IsOptional()
  @IsIn(ROUNDING_INCREMENTS)
  roundingIncrement?: RoundingIncrement;

  @ApiPropertyOptional({
    description: "Number of days until the proof expires. Defaults to 30.",
    minimum: 1,
    maximum: 365,
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
