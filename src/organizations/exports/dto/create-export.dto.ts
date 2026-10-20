import { ApiProperty } from "@nestjs/swagger";
import { OrganizationExportCategory } from "@prisma/client";
import { ArrayMinSize, ArrayUnique, IsEnum } from "class-validator";

export class CreateExportDto {
  @ApiProperty({
    description:
      "Data categories to include in the export. At least one is required; " +
      "each is scoped to the organization and never includes secrets.",
    enum: OrganizationExportCategory,
    isArray: true,
    example: [
      OrganizationExportCategory.ORGANIZATION_PROFILE,
      OrganizationExportCategory.ISSUERS,
    ],
  })
  @IsEnum(OrganizationExportCategory, { each: true })
  @ArrayMinSize(1)
  @ArrayUnique()
  categories: OrganizationExportCategory[];
}
