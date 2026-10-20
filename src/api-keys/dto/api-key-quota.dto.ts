import { ApiProperty } from "@nestjs/swagger";
import { ApiKeyScope } from "@prisma/client";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, Min, ValidateNested } from "class-validator";

export class ApiKeyQuotaConfigDto {
  @ApiProperty({
    enum: ApiKeyScope,
    description: "The scope this quota applies to",
    example: "PROOF_VERIFY",
  })
  @IsEnum(ApiKeyScope)
  scope: ApiKeyScope;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Quota limit: null = unlimited, 0 = disabled, positive = requests per window",
    example: 1000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  quotaLimit: number | null;

  @ApiProperty({
    description: "Rolling window in seconds",
    example: 3600,
  })
  @IsInt()
  @Min(60) // Minimum 1 minute window
  windowSeconds: number = 3600;
}

export class SetApiKeyQuotasDto {
  @ApiProperty({
    type: [ApiKeyQuotaConfigDto],
    description: "Quota configurations to set for the API key",
  })
  @ValidateNested({ each: true })
  @Type(() => ApiKeyQuotaConfigDto)
  quotas: ApiKeyQuotaConfigDto[];
}

export class ApiKeyQuotaResponseDto {
  @ApiProperty({
    enum: ApiKeyScope,
    description: "The scope this quota applies to",
  })
  scope: ApiKeyScope;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Quota limit: null = unlimited, 0 = disabled",
  })
  quotaLimit: number | null;

  @ApiProperty({
    description: "Rolling window in seconds",
  })
  windowSeconds: number;

  @ApiProperty({
    description: "When this quota configuration was last updated",
  })
  updatedAt: Date;

  @ApiProperty({
    description: "Whether this scope has unlimited quota",
  })
  isUnlimited: boolean;

  @ApiProperty({
    description: "Whether this scope is disabled",
  })
  isDisabled: boolean;
}

export class ApiKeyQuotaUsageDto {
  @ApiProperty({
    enum: ApiKeyScope,
    description: "The scope being checked",
  })
  scope: ApiKeyScope;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Current quota limit (null = unlimited)",
  })
  quotaLimit: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Current usage in this window (null if unlimited)",
  })
  currentUsage: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Remaining quota in this window (null if unlimited)",
  })
  remaining: number | null;

  @ApiProperty({
    description: "When the current window resets",
  })
  resetTime: Date;

  @ApiProperty({
    description: "Window size in seconds",
  })
  windowSeconds: number;

  @ApiProperty({
    description: "Whether this scope has unlimited quota",
  })
  isUnlimited: boolean;

  @ApiProperty({
    description: "Whether this scope is disabled",
  })
  isDisabled: boolean;
}