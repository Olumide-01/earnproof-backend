import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ApiErrorDto } from "../../common/dto/api-error.dto";
import { AuthGuard } from "../../common/guards/auth.guard";
import { AuthenticatedUser } from "../../auth/auth.types";
import { CreateExportDto } from "./dto/create-export.dto";
import { OrganizationExportService } from "./organization-export.service";

/**
 * Request/response surface for organization data exports.
 *
 * Everything here is tenant-scoped and behind the session guard; the service
 * re-checks visibility on every call, so the guard and the service agree on who
 * may act. The one exception is the download redemption endpoint, which is
 * authorized by the single-use token itself rather than a session — the same
 * capability-URL pattern a signed download link uses.
 */
@ApiTags("organization-exports")
@ApiBearerAuth()
@Controller("organizations/:organizationId/exports")
@UseGuards(AuthGuard)
export class OrganizationExportsController {
  constructor(private readonly exports: OrganizationExportService) {}

  @Post()
  @ApiOperation({
    summary: "Create an organization data export job",
    description:
      "Queues an asynchronous, encrypted export of the named data categories. " +
      "Returns immediately with a QUEUED job; poll its status for completion.",
  })
  @ApiResponse({ status: 201, description: "Export job queued." })
  @ApiResponse({ status: 400, description: "No valid categories.", type: ApiErrorDto })
  @ApiResponse({ status: 404, description: "Organization not found.", type: ApiErrorDto })
  @ApiResponse({ status: 401, description: "Session token missing or invalid.", type: ApiErrorDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Body() body: CreateExportDto,
  ) {
    return this.exports.createExport(user, organizationId, body.categories);
  }

  @Get()
  @ApiOperation({ summary: "List an organization's export jobs" })
  @ApiResponse({ status: 200, description: "Export jobs." })
  @ApiResponse({ status: 401, description: "Session token missing or invalid.", type: ApiErrorDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
  ) {
    return this.exports.listExports(user, organizationId);
  }

  @Get(":exportId")
  @ApiOperation({ summary: "Get an export job's status" })
  @ApiResponse({ status: 200, description: "Export status." })
  @ApiResponse({ status: 404, description: "Export not found.", type: ApiErrorDto })
  @ApiResponse({ status: 401, description: "Session token missing or invalid.", type: ApiErrorDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("exportId") exportId: string,
  ) {
    return this.exports.getExport(user, organizationId, exportId);
  }

  @Post(":exportId/cancel")
  @ApiOperation({
    summary: "Cancel an export job",
    description:
      "Cancels a queued or running job, or removes a completed export. The " +
      "temporary archive, if any, is deleted.",
  })
  @ApiResponse({ status: 200, description: "Export cancelled." })
  @ApiResponse({ status: 409, description: "Export already terminal.", type: ApiErrorDto })
  @ApiResponse({ status: 401, description: "Session token missing or invalid.", type: ApiErrorDto })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("exportId") exportId: string,
  ) {
    return this.exports.cancelExport(user, organizationId, exportId);
  }

  @Post(":exportId/download")
  @ApiOperation({
    summary: "Issue a short-lived download handoff",
    description:
      "Returns a single-use, short-lived token for a completed export. Redeem " +
      "it at GET /exports/download. The raw token is returned once and not stored.",
  })
  @ApiResponse({ status: 201, description: "Download token issued." })
  @ApiResponse({ status: 409, description: "Export not ready.", type: ApiErrorDto })
  @ApiResponse({ status: 401, description: "Session token missing or invalid.", type: ApiErrorDto })
  issueDownload(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("exportId") exportId: string,
  ) {
    return this.exports.issueDownload(user, organizationId, exportId);
  }
}

/**
 * Public redemption of a download handoff.
 *
 * Separate controller, no session guard: the unguessable, short-lived,
 * single-use token *is* the authorization. Kept off the tenant-scoped path so a
 * capability URL need not also carry an organization id.
 */
@ApiTags("organization-exports")
@Controller("exports")
export class ExportDownloadController {
  constructor(private readonly exports: OrganizationExportService) {}

  @Get("download")
  @ApiOperation({
    summary: "Redeem an export download token",
    description:
      "Streams the encrypted export archive for a valid, unexpired, unspent " +
      "token. The token is consumed on redemption.",
  })
  @ApiResponse({ status: 200, description: "Encrypted archive." })
  @ApiResponse({ status: 404, description: "Download not available.", type: ApiErrorDto })
  async download(
    @Query("token") token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const archive = await this.exports.consumeDownload(token ?? "");

    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${archive.filename}"`,
      // Expose the integrity digest so a client can verify the download.
      "X-Archive-Digest": archive.digest,
    });

    return new StreamableFile(archive.content);
  }
}
