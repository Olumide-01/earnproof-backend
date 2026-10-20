import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import type { ConfigSnapshotDocument } from "../../config/config-snapshot";
import { RollbackReason, type RollbackReasonValue } from "../config-rollout";

const ENVIRONMENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class ImportConfigSnapshotDto {
  @ApiProperty({
    description:
      "A snapshot document exported from another environment. Accepted only if it verifies " +
      "under this deployment's snapshot signing key and contains nothing secret-looking.",
    type: "object",
    additionalProperties: true,
  })
  @IsObject()
  document!: ConfigSnapshotDocument;
}

export class CompareConfigSnapshotsQueryDto {
  @ApiProperty({ description: "Base snapshot id." })
  @Matches(ID_PATTERN)
  base!: string;

  @ApiProperty({ description: "Target snapshot id." })
  @Matches(ID_PATTERN)
  target!: string;
}

export class CreateConfigRolloutDto {
  @ApiProperty({ description: "Snapshot to roll out." })
  @Matches(ID_PATTERN)
  snapshotId!: string;

  @ApiProperty({ description: "Target environment slug.", example: "production" })
  @Matches(ENVIRONMENT_PATTERN, { message: "environment must be a lowercase slug" })
  environment!: string;

  @ApiPropertyOptional({
    description:
      "Canary percentages, strictly increasing and ending at 100. Defaults to " +
      "CONFIG_ROLLOUT_DEFAULT_STAGES.",
    example: [5, 25, 100],
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(100, { each: true })
  stages?: number[];

  @ApiPropertyOptional({
    description:
      "Snapshot restored on rollback. Defaults to the environment's last completed rollout.",
  })
  @IsOptional()
  @Matches(ID_PATTERN)
  baselineSnapshotId?: string;
}

export class GateCheckDto {
  @ApiProperty({ example: "error_rate" })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/)
  name!: string;

  @ApiProperty()
  @IsBoolean()
  passed!: boolean;

  @ApiProperty({ description: "When the signal was observed (ISO-8601 UTC).", example: "2030-01-01T00:05:00.000Z" })
  @IsISO8601({ strict: true })
  observedAt!: string;
}

export class RecordGateDto {
  @ApiProperty({ description: "Rollout version the evidence was gathered against." })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiProperty({ description: "Stage the evidence is for; must be the current stage." })
  @IsInt()
  @Min(0)
  @Max(9)
  stageIndex!: number;

  @ApiProperty({ type: [GateCheckDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => GateCheckDto)
  checks!: GateCheckDto[];
}

export class PromoteConfigRolloutDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class RollbackConfigRolloutDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiProperty({ enum: Object.values(RollbackReason) })
  @IsIn(Object.values(RollbackReason))
  reason!: RollbackReasonValue;
}

export class CohortQueryDto {
  @ApiProperty({ description: "Opaque, stable instance identifier.", example: "api-7f9c" })
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._-]{1,128}$/)
  instanceId!: string;
}
