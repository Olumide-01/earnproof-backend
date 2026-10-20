import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsEnum,
  IsOptional,
  IsISO8601,
  IsInt,
  Min,
  Max,
} from "class-validator";

/**
 * Query DTO for fetching contract reconciliation findings.
 */
export class ContractReconciliationFindingsQueryDto {
  @ApiProperty({ description: "Network identifier (e.g., testnet)" })
  @IsString()
  network: string;

  @ApiProperty({ description: "Contract ID" })
  @IsString()
  contractId: string;

  @ApiPropertyOptional({
    enum: ["mismatch", "verification_failure"],
    description: "Type of findings to return",
  })
  @IsEnum(["mismatch", "verification_failure"])
  @IsOptional()
  type?: "mismatch" | "verification_failure";

  @ApiPropertyOptional({ description: "Earliest detection time (ISO-8601)" })
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: "Latest detection time (ISO-8601)" })
  @IsISO8601()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({ description: "Page number (1-based)", default: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ description: "Page size (1-100)", default: 50 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  pageSize?: number = 50;

  @ApiPropertyOptional({
    enum: ["detection_time", "component_name"],
    description: "Sort by field",
  })
  @IsEnum(["detection_time", "component_name"])
  @IsOptional()
  sortBy?: "detection_time" | "component_name" = "detection_time";

  @ApiPropertyOptional({ enum: ["asc", "desc"], description: "Sort order" })
  @IsEnum(["asc", "desc"])
  @IsOptional()
  sortOrder?: "asc" | "desc" = "desc";
}

/**
 * Response DTO for a single mismatch finding.
 */
export class ContractReconciliationMismatchDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  network: string;

  @ApiProperty()
  contractId: string;

  @ApiProperty({ description: "Checkpoint number as string (BigInt)" })
  checkpointNumber: string;

  @ApiProperty()
  digestVersion: string;

  @ApiProperty()
  componentName: string;

  @ApiProperty({ description: "Backend projection value" })
  expectedValue: string;

  @ApiProperty({ description: "Live contract value" })
  observedValue: string;

  @ApiProperty({ description: "Detection time (ISO-8601)" })
  detectionTime: string;

  @ApiProperty()
  runId: string;
}

/**
 * Response DTO for a single verification failure finding.
 */
export class ContractReconciliationVerificationFailureDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  network: string;

  @ApiProperty()
  contractId: string;

  @ApiPropertyOptional()
  digestVersion?: string;

  @ApiProperty({
    description:
      "Failure code: UNKNOWN_VERSION, NETWORK_MISMATCH, CONTRACT_MISMATCH, FETCH_TIMEOUT, RPC_TRANSIENT_ERROR, RPC_PERMANENT_ERROR, PARSE_ERROR, STALE_CONTRACT_STATE",
  })
  failureCode: string;

  @ApiProperty({ description: "Redacted failure message (no sensitive data)" })
  failureMessage: string;

  @ApiProperty({ description: "Detection time (ISO-8601)" })
  detectionTime: string;

  @ApiProperty()
  runId: string;
}

/**
 * Pagination metadata DTO.
 */
export class PaginationMetadataDto {
  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;

  @ApiProperty()
  totalCount: number;

  @ApiProperty()
  totalPages: number;

  @ApiProperty()
  hasNextPage: boolean;
}

/**
 * Response DTO for findings query.
 */
export class ContractReconciliationFindingsResponseDto {
  @ApiProperty({
    type: [Object],
    description:
      "Array of mismatches and verification failures (mixed types)",
  })
  data: (
    | ContractReconciliationMismatchDto
    | ContractReconciliationVerificationFailureDto
  )[];

  @ApiProperty()
  pagination: PaginationMetadataDto;

  @ApiProperty()
  summary: {
    mismatchCount: number;
    verificationFailureCount: number;
    totalComponentsAffected: number;
  };

  @ApiProperty()
  limits: {
    maxComponentsPerPage: number;
    maxComponentsTotal: number;
  };
}

/**
 * Request DTO for on-demand comparison.
 */
export class TriggerContractReconciliationDto {
  @ApiProperty()
  @IsString()
  network: string;

  @ApiProperty()
  @IsString()
  contractId: string;

  @ApiPropertyOptional({
    description: "Checkpoint number (if omitted, use latest from contract)",
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  checkpointNumber?: number;

  @ApiPropertyOptional({
    description: "If true, allow comparison even if contract state is stale",
    default: false,
  })
  @IsOptional()
  skipStaleCheck?: boolean = false;
}

/**
 * Response DTO for on-demand comparison.
 */
export class TriggerContractReconciliationResponseDto {
  @ApiProperty()
  runId: string;

  @ApiProperty()
  network: string;

  @ApiProperty()
  contractId: string;

  @ApiProperty()
  checkpointNumber: string;

  @ApiPropertyOptional()
  digestVersion?: string;

  @ApiProperty({ enum: ["PASSED", "FAILED"] })
  verificationStatus: "PASSED" | "FAILED";

  @ApiPropertyOptional({
    type: [ContractReconciliationVerificationFailureDto],
  })
  verificationFailures?: ContractReconciliationVerificationFailureDto[];

  @ApiPropertyOptional({ enum: ["MATCH", "MISMATCH"] })
  comparisonStatus?: "MATCH" | "MISMATCH";

  @ApiPropertyOptional()
  mismatchCount?: number;

  @ApiProperty()
  detectedAt: string; // ISO-8601
}
