import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, Matches } from "class-validator";
import { TransactionConfirmationStatus } from "@prisma/client";

export class SubmitTransactionConfirmationDto {
  @ApiProperty({ description: "Stellar network identifier (e.g. testnet, mainnet, futurenet)" })
  @IsString()
  @IsNotEmpty()
  network!: string;

  @ApiProperty({ description: "Transaction hash (64 hex characters)" })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, {
    message: "transactionHash must be a 64-character hex string",
  })
  transactionHash!: string;

  @ApiProperty({ description: "Domain operation type being tracked" })
  @IsString()
  @IsNotEmpty()
  operationType!: string;

  @ApiPropertyOptional({ description: "Domain entity reference" })
  @IsOptional()
  @IsString()
  operationRef?: string;

  @ApiPropertyOptional({ description: "Metadata associated with operation" })
  @IsOptional()
  metadata?: Record<string, unknown>;
}

export class TransactionConfirmationResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  network!: string;

  @ApiProperty()
  transactionHash!: string;

  @ApiProperty()
  operationType!: string;

  @ApiPropertyOptional()
  operationRef?: string | null;

  @ApiProperty({ enum: TransactionConfirmationStatus })
  status!: TransactionConfirmationStatus;

  @ApiProperty()
  submittedAt!: Date;

  @ApiPropertyOptional()
  ledgerSequence?: number | null;

  @ApiPropertyOptional()
  ledgerHash?: string | null;

  @ApiPropertyOptional()
  confirmedAt?: Date | null;

  @ApiPropertyOptional()
  replacedByHash?: string | null;

  @ApiPropertyOptional()
  failureReason?: string | null;

  @ApiPropertyOptional()
  errorCode?: string | null;

  @ApiProperty()
  retryCount!: number;

  @ApiProperty({ description: "Privacy-safe block explorer reference" })
  explorerUrl!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
