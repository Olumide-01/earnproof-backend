import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsObject,
  IsString,
  MinLength,
  ValidateNested,
} from "class-validator";

/** Mirrors {@link MAX_IMPORT_ROWS} in schema-imports.service.ts. */
export const MAX_IMPORT_ROWS_DTO_BOUND = 2000;

export class SchemaImportRowInputDto {
  @ApiProperty({ example: "proof.minimum_income" })
  @IsString()
  @MinLength(1)
  schemaKey: string;

  @ApiProperty({ example: "3" })
  @IsString()
  @MinLength(1)
  version: string;

  @ApiProperty({ example: { fields: ["amount", "asset"] } })
  @IsObject()
  definition: Record<string, unknown>;
}

export class UploadSchemaImportDto {
  @ApiProperty({ type: [SchemaImportRowInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IMPORT_ROWS_DTO_BOUND)
  @ValidateNested({ each: true })
  @Type(() => SchemaImportRowInputDto)
  rows: SchemaImportRowInputDto[];
}
