import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from "@nestjs/swagger";
import { AuthGuard } from "../common/guards/auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../auth/auth.types";
import { MembershipImportService } from "./membership-import.service";
import {
  CreateMembershipImportDto,
} from "./dto/create-membership-import.dto";
import {
  MembershipImportResponseDto,
  ListMembershipImportsDto,
} from "./dto/membership-import-response.dto";

@ApiTags("Organization Membership Imports")
@Controller("organizations/:organizationId/membership-imports")
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class MembershipImportController {
  constructor(private readonly importService: MembershipImportService) {}

  @Post()
  @ApiOperation({ summary: "Create a new membership import job" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiResponse({
    status: 201,
    description: "Import job created successfully",
    type: MembershipImportResponseDto,
  })
  @ApiResponse({ status: 400, description: "Invalid import data" })
  @ApiResponse({ status: 403, description: "Insufficient permissions" })
  async createImport(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Body() input: CreateMembershipImportDto,
  ): Promise<MembershipImportResponseDto> {
    return this.importService.createImport(user, organizationId, input);
  }

  @Get()
  @ApiOperation({ summary: "List membership import jobs" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiResponse({
    status: 200,
    description: "Import jobs retrieved successfully",
  })
  async listImports(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Query() query: ListMembershipImportsDto,
  ): Promise<{
    items: MembershipImportResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.importService.listImports(user, organizationId, query);
  }

  @Get(":importId")
  @ApiOperation({ summary: "Get membership import job details" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiParam({ name: "importId", description: "Import job ID" })
  @ApiResponse({
    status: 200,
    description: "Import job retrieved successfully",
    type: MembershipImportResponseDto,
  })
  @ApiResponse({ status: 404, description: "Import job not found" })
  async getImport(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("importId") importId: string,
  ): Promise<MembershipImportResponseDto> {
    return this.importService.getImport(user, organizationId, importId);
  }

  @Patch(":importId/cancel")
  @ApiOperation({ summary: "Cancel a pending or processing import job" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiParam({ name: "importId", description: "Import job ID" })
  @ApiResponse({ status: 200, description: "Import job cancelled successfully" })
  @ApiResponse({ status: 404, description: "Import job not found" })
  @ApiResponse({ status: 403, description: "Insufficient permissions" })
  async cancelImport(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("importId") importId: string,
  ): Promise<void> {
    return this.importService.cancelImport(user, organizationId, importId);
  }
}