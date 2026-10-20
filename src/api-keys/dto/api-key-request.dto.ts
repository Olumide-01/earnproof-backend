import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ApiKeyScope } from "@prisma/client";
import {
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { FIELD_LIMITS } from "../../common/limits/request-limits";
import { CursorPaginationQueryDto } from "../../common/pagination/pagination.dto";

export class OrganizationApiKeysQueryDto {
  @ApiPropertyOptional({
    description:
      "Organization to manage. Required when an administrator can manage more than one organization.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(FIELD_LIMITS.id)
  organizationId?: string;
}

export class ListApiKeysQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({
    description:
      "Organization to manage. Required when an administrator can manage more than one organization.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(FIELD_LIMITS.id)
  organizationId?: string;
}

export class CreateApiKeyDto extends OrganizationApiKeysQueryDto {
  @ApiProperty({ example: "Reporting integration" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ enum: ApiKeyScope, isArray: true, default: [] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(ApiKeyScope, { each: true })
  scopes?: ApiKeyScope[];

  @ApiPropertyOptional({ description: "Optional future expiry timestamp." })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
