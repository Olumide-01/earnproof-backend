import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { CheckpointHealthClassification } from "@prisma/client";

export class CheckpointHealthSnapshotDto {
  @ApiProperty({ description: "Snapshot ID" })
  id!: string;

  @ApiProperty({ description: "User ID" })
  userId!: string;

  @ApiPropertyOptional({ description: "Organization ID (if tenant-scoped)" })
  organizationId?: string | null;

  @ApiProperty({ description: "Stellar network (e.g., testnet, public)" })
  network!: string;

  @ApiProperty({ description: "Hashed wallet address" })
  walletAddressHash!: string;

  @ApiProperty({ description: "Current checkpoint ledger sequence" })
  ledgerSequence!: number;

  @ApiProperty({ description: "Latest known ledger sequence on network" })
  latestKnownLedger!: number;

  @ApiProperty({ description: "Ledger lag (latestKnownLedger - ledgerSequence)" })
  ledgerLag!: number;

  @ApiProperty({
    enum: CheckpointHealthClassification,
    description: "Operational classification of sync health",
  })
  classification!: CheckpointHealthClassification;

  @ApiProperty({ description: "Current Horizon paging token cursor" })
  pagingToken!: string;

  @ApiProperty({ description: "Whether sync ingestion is stalled" })
  isStalled!: boolean;

  @ApiProperty({ description: "Whether the sync is currently in reorg recovery" })
  isReorganizing!: boolean;

  @ApiProperty({ description: "Number of recovery attempts" })
  recoveryAttempts!: number;

  @ApiPropertyOptional({ description: "Timestamp of last successful recovery" })
  lastRecoveredAt?: Date | null;

  @ApiPropertyOptional({ description: "Sanitized operational metadata (no sensitive data)" })
  metadata?: Record<string, unknown> | null;

  @ApiProperty({ description: "Timestamp when snapshot was recorded" })
  recordedAt!: Date;
}

export class CheckpointHealthSummaryDto {
  @ApiPropertyOptional({ description: "Tenant organization ID" })
  organizationId?: string | null;

  @ApiProperty({ description: "Total accounts monitored" })
  totalAccounts!: number;

  @ApiProperty({ description: "Accounts categorized by health classification" })
  countsByClassification!: Record<CheckpointHealthClassification, number>;

  @ApiProperty({ description: "Maximum ledger lag observed across accounts" })
  maxLag!: number;

  @ApiProperty({ description: "Average ledger lag observed" })
  avgLag!: number;

  @ApiProperty({ description: "Count of currently stalled accounts" })
  stalledAccountsCount!: number;

  @ApiProperty({ description: "Count of accounts undergoing reorganization recovery" })
  reorganizingAccountsCount!: number;

  @ApiProperty({ description: "Timestamp of summary generation" })
  generatedAt!: Date;
}

export class RetryCheckpointSyncDto {
  @ApiPropertyOptional({ description: "Target user ID for retry (if tenant admin)" })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: "Maximum recovery pages to attempt", default: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxPages?: number;

  @ApiPropertyOptional({ description: "Reason for manual retry trigger" })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class QueryCheckpointHealthDto {
  @ApiPropertyOptional({ description: "Filter by tenant organization ID" })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiPropertyOptional({
    enum: CheckpointHealthClassification,
    description: "Filter by classification",
  })
  @IsOptional()
  @IsEnum(CheckpointHealthClassification)
  classification?: CheckpointHealthClassification;

  @ApiPropertyOptional({ description: "Maximum records to return", default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
