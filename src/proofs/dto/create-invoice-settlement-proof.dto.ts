import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class CreateInvoiceSettlementProofDto {
  @ApiProperty({
    description:
      "Raw external invoice reference (e.g. an accounting-system invoice number). " +
      "Never persisted, logged, or included in the public claim — only a " +
      "normalized SHA-256 commitment of this value is stored.",
    example: "INV-2026-000123",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  invoiceReference!: string;

  @ApiProperty({
    description:
      "ID of the Issuer the invoice is owed to. The settling payment's " +
      "sourceAddress must match an ACTIVE TrustedSource owned by the caller " +
      "that points at this issuer.",
  })
  @IsString()
  @IsNotEmpty()
  issuerId!: string;

  @ApiProperty({
    description: "Stellar asset code the settling payment must use.",
    example: "USDC",
  })
  @IsString()
  @IsNotEmpty()
  assetCode!: string;

  @ApiPropertyOptional({
    description:
      "Stellar issuer address for the asset. Omit for native XLM.",
    example: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGLA1PIC4CEXLRTKHB0EGB",
  })
  @IsOptional()
  @IsString()
  assetIssuer?: string;

  @ApiProperty({
    description:
      "Expected invoice amount as a decimal string with up to 7 decimal places. " +
      "The settling payment's decrypted amount must equal this value exactly — " +
      "partial payments and overpayments are both rejected as mismatches.",
    pattern: "^\\d+(\\.\\d{1,7})?$",
    example: "1250.0000000",
  })
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/)
  expectedAmount!: string;

  @ApiPropertyOptional({
    description:
      "ISO-8601 date string. Only payments with occurredAt >= this value are considered.",
    example: "2026-01-01T00:00:00.000Z",
  })
  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @ApiPropertyOptional({
    description:
      "ISO-8601 date string. Only payments with occurredAt <= this value are considered.",
    example: "2026-01-31T23:59:59.000Z",
  })
  @IsOptional()
  @IsDateString()
  periodEnd?: string;

  @ApiPropertyOptional({
    default: false,
    description: "Include the exact settlement amount in the public credential.",
  })
  @IsOptional()
  @IsBoolean()
  discloseAmount?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 365, default: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
