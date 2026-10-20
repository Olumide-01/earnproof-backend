import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsObject, IsOptional, IsString } from "class-validator";
import { ReconciliationConflictType } from "@prisma/client";

export class ProposeConflictResolutionDto {
  @ApiProperty({ description: "Target conflict ID" })
  @IsString()
  @IsNotEmpty()
  conflictId!: string;

  @ApiProperty({ description: "Proposed resolution action (e.g. ADOPT_CONTRACT_STATE, RE_ANCHOR, OVERWRITE_LOCAL)" })
  @IsString()
  @IsNotEmpty()
  action!: string;

  @ApiProperty({ description: "Detailed justification for the proposed resolution" })
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @ApiProperty({ description: "Risk classification: LOW, MEDIUM, HIGH, CRITICAL" })
  @IsString()
  @IsNotEmpty()
  riskLevel!: string;

  @ApiProperty({ description: "Authoritative snapshot / evidence captured during detection" })
  @IsObject()
  @IsOptional()
  evidence?: Record<string, any>;
}

export class ExecuteResolutionPlanDto {
  @ApiProperty({ description: "Execution lease token claimed from the approval request" })
  @IsString()
  @IsNotEmpty()
  executionLeaseToken!: string;
}
