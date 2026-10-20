import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsOptional,
  IsEnum,
  IsNumber,
  Min,
  Max,
  IsString,
  IsISO8601,
} from "class-validator";
import { ResourceStatus, AttestationType } from "@prisma/client";
import { Type } from "class-transformer";

export class ListAttestationsDto {
  @ApiPropertyOptional({
    description: "Filter by attestation status",
    enum: ["ACTIVE", "PENDING", "SUSPENDED", "REVOKED", "DELETED"],
  })
  @IsOptional()
  @IsEnum(ResourceStatus)
  status?: ResourceStatus;

  @ApiPropertyOptional({
    description: "Filter by attestation type",
    enum: ["PAYMENT", "EMPLOYMENT", "INVOICE"],
  })
  @IsOptional()
  @IsEnum(AttestationType)
  type?: AttestationType;

  @ApiPropertyOptional({
    description: "Filter by subject wallet hash",
    example: "sha256:abcd1234...",
  })
  @IsOptional()
  @IsString()
  subjectWalletHash?: string;

  @ApiPropertyOptional({
    description: "Include only attestations that expire after this date",
    example: "2025-01-15T10:30:00Z",
  })
  @IsOptional()
  @IsISO8601()
  expiresAfter?: string;

  @ApiPropertyOptional({
    description: "Include only attestations that expire before this date",
    example: "2025-12-31T23:59:59Z",
  })
  @IsOptional()
  @IsISO8601()
  expiresBefore?: string;

  @ApiPropertyOptional({
    description: "Page number (1-indexed)",
    example: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: "Items per page (max 100)",
    example: 20,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;
}
