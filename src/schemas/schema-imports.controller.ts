import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { UploadSchemaImportDto } from "./dto/upload-schema-import.dto";
import { ReviewSchemaImportDto } from "./dto/review-schema-import.dto";
import { SchemaImportsService } from "./schema-imports.service";

@ApiBearerAuth()
@ApiTags("schema-imports")
@Controller("organizations/:organizationId/schema-imports")
@UseGuards(AuthGuard)
export class SchemaImportsController {
  constructor(private readonly schemaImports: SchemaImportsService) {}

  @Post()
  @ApiOperation({ summary: "Upload a bulk schema import and run its dry-run pass" })
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Body() dto: UploadSchemaImportDto,
  ) {
    return this.schemaImports.uploadAndDryRun(user, organizationId, dto);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a schema import job" })
  get(@Param("id") id: string) {
    return this.schemaImports.get(id);
  }

  @Get(":id/rows")
  @ApiOperation({ summary: "List row-level dry-run results" })
  rows(@Param("id") id: string) {
    return this.schemaImports.listRows(id);
  }

  @Post(":id/approve")
  @ApiOperation({ summary: "Approve a completed dry run, pinned to its canonical hash" })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: ReviewSchemaImportDto,
  ) {
    return this.schemaImports.approve(user, id, dto);
  }

  @Post(":id/apply")
  @ApiOperation({ summary: "Apply an approved import to SchemaDefinition" })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: ReviewSchemaImportDto,
  ) {
    return this.schemaImports.apply(user, id, dto);
  }
}
