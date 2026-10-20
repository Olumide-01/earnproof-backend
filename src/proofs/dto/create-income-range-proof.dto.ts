import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from "class-validator";

export class CreateIncomeRangeProofDto {
  @ApiProperty({
    description:
      "IDs of the payments to include in the proof. All must be classified as INCOME, " +
      "eligible (asset is on the supported-asset list), belong to the authenticated user, " +
      "use the requested asset, and fall within the requested period.",
    type: [String],
    example: ["clx1abc2def3ghi4", "clx1xyz5uvw6rst7"],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  selectedPaymentIds!: string[];

  @ApiProperty({
    description:
      "Inclusive lower bound of the income range, expressed as a decimal string with up to " +
      "7 decimal places. The sum of selected payment amounts must be greater than or equal to " +
      "this value.",
    pattern: "^\\d+(\\.\\d{1,7})?$",
    example: "500.0000000",
  })
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/)
  lowerBound!: string;

  @ApiProperty({
    description:
      "Inclusive upper bound of the income range, expressed as a decimal string with up to " +
      "7 decimal places. The sum of selected payment amounts must be less than or equal to " +
      "this value. Must be strictly greater than `lowerBound`.",
    pattern: "^\\d+(\\.\\d{1,7})?$",
    example: "1500.0000000",
  })
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/)
  upperBound!: string;

  @ApiProperty({
    description: "Stellar asset code that all selected payments must share.",
    example: "USDC",
  })
  @IsString()
  assetCode!: string;

  @ApiPropertyOptional({
    description:
      "Stellar issuer address for the asset. Omit for native XLM. " +
      "All selected payments must share this issuer.",
    example: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGLA1PIC4CEXLRTKHB0EGB",
  })
  @IsOptional()
  @IsString()
  assetIssuer?: string;

  @ApiProperty({
    description:
      "ISO-8601 date string for the start of the income period (inclusive). " +
      "All selected payments must have `occurredAt` >= this value.",
    example: "2025-01-01T00:00:00.000Z",
  })
  @IsDateString()
  periodStart!: string;

  @ApiProperty({
    description:
      "ISO-8601 date string for the end of the income period (inclusive). " +
      "Must be after `periodStart`. All selected payments must have `occurredAt` <= this value.",
    example: "2025-01-31T23:59:59.000Z",
  })
  @IsDateString()
  periodEnd!: string;

  @ApiPropertyOptional({
    description:
      "Number of days until the proof expires. Defaults to 30. " +
      "Must be between 1 and 365.",
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
