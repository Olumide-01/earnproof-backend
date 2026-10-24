import { ApiPropertyOptional } from "@nestjs/swagger";
import { ApiKeyScope } from "@prisma/client";
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Type } from "class-transformer";
import { OrganizationApiKeysQueryDto } from "./api-key-request.dto";
import {
  DEFAULT_ROTATION_OVERLAP_MS,
  MAX_ROTATION_OVERLAP_MS,
  MIN_ROTATION_OVERLAP_MS,
} from "../api-key-rotation.types";

export class RotateApiKeyDto extends OrganizationApiKeysQueryDto {
  @ApiPropertyOptional({
    description:
      "Bounded overlap window duration in milliseconds. Defaults to 24 hours. Minimum 1 minute, maximum 30 days.",
    default: DEFAULT_ROTATION_OVERLAP_MS,
    example: 86400000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_ROTATION_OVERLAP_MS)
  @Max(MAX_ROTATION_OVERLAP_MS)
  overlapDurationMs?: number;

  @ApiPropertyOptional({
    description:
      "Optional scopes for the replacement key. If omitted, inherits predecessor scopes.",
    enum: ApiKeyScope,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(ApiKeyScope, { each: true })
  scopes?: ApiKeyScope[];

  @ApiPropertyOptional({
    description: "Optional name for replacement key. If omitted, inherits predecessor name.",
    example: "Reporting integration (v2)",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;
}

export class CutoverApiKeyDto extends OrganizationApiKeysQueryDto {
  @ApiPropertyOptional({
    description: "Optional reason or note for early cutover.",
    example: "Integration migration confirmed complete",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RevokeApiKeyDto extends OrganizationApiKeysQueryDto {
  @ApiPropertyOptional({
    description:
      "Revocation reason. If 'COMPROMISE', revokes all keys in the rotation family immediately.",
    example: "COMPROMISE",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reason?: string;
}
