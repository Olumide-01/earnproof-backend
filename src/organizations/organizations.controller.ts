import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from "@nestjs/swagger";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { CreateOrganizationDto } from "./dto/create-organization.dto";
import { ListOrganizationsDto } from "./dto/list-organizations.dto";
import { OrganizationResponseDto } from "./dto/organization-response.dto";
import { UpdateOrganizationDto } from "./dto/update-organization.dto";
import { Request } from "express";
import { OrganizationsService } from "./organizations.service";
import { OrganizationMembersService } from "./organization-members.service";
import { AssignOrganizationMemberDto } from "./dto/assign-organization-member.dto";
import { OrganizationMemberResponseDto } from "./dto/organization-member-response.dto";
import { UpdateOrganizationMemberRoleDto } from "./dto/update-organization-member-role.dto";
import { ListOrganizationMembersDto } from "./dto/list-organization-members.dto";
import { OrganizationMemberGuard } from "./guards/organization-member.guard";
import { RequiredOrganizationRole } from "./decorators/required-organization-role.decorator";
import { RecentAuthGuard, RequireRecentAuth } from "../common/guards/recent-auth.guard";
import { RecentAuthService, DESTRUCTIVE_ACTIONS } from "../auth/recent-auth.service";
import { OrganizationReadinessService } from "./organization-readiness.service";
import { OrganizationReadinessResponseDto } from "./dto/organization-readiness-response.dto";


@ApiBearerAuth()
@AuthenticatedRoute({ roles: ["ADMIN"] })
@ApiTags("organizations")
@Controller("organizations")
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly membersService: OrganizationMembersService,
    private readonly recentAuthService: RecentAuthService,
     private readonly readinessService: OrganizationReadinessService,
  ) {}

  @Post()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Create a new organization",
    description:
      "Admin-only endpoint to create a new organization with pending status",
  })
  @ApiResponse({
    status: 201,
    description: "Organization created successfully",
    type: OrganizationResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: "Organization slug already exists",
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - admin role required",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  createOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateOrganizationDto,
  ) {
    return this.organizationsService.createOrganization(user, input);
  }

  @Get()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "List organizations",
    description:
      "List organizations. Admins see all, others see only their own created organizations.",
  })
  @ApiResponse({
    status: 200,
    description: "Organizations retrieved successfully",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  listOrganizations(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrganizationsDto,
  ) {
    return this.organizationsService.listOrganizations(user, query);
  }

  @Get(":id")
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "Get organization details",
    description:
      "Retrieve full details of an organization including issuer count",
  })
  @ApiResponse({
    status: 200,
    description: "Organization retrieved successfully",
    type: OrganizationResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Organization not found",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  getOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
  ) {
    return this.organizationsService.getOrganization(user, organizationId);
  }

  @Get(":id/usage")
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "Get organization quota usage",
    description:
      "Current usage, limits, and reset times for the organization's operational quotas " +
      "(active API keys, webhooks, proof requests per day, payment syncs per hour). " +
      "Only the organization creator or an admin may view it.",
  })
  @ApiResponse({ status: 200, description: "Quota usage report" })
  @ApiResponse({ status: 403, description: "Not the creator or an admin" })
  @ApiResponse({ status: 404, description: "Organization not found" })
  getUsage(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
  ) {
    return this.organizationsService.getUsage(user, organizationId);
  }

  @Patch(":id")
  @UseGuards(AuthGuard, RoleGuard)
  @ApiOperation({
    summary: "Update organization",
    description:
      "Update organization name and/or website. Only creator or admin can update.",
  })
  @ApiResponse({
    status: 200,
    description: "Organization updated successfully",
    type: OrganizationResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Organization not found",
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - not creator or admin",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  updateOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
    @Body() input: UpdateOrganizationDto,
  ) {
    return this.organizationsService.updateOrganization(
      user,
      organizationId,
      input,
    );
  }

  // ==================== MEMBERSHIP ENDPOINTS ====================

  @Get(":id/readiness")
@UseGuards(AuthGuard, OrganizationMemberGuard)
@RequiredOrganizationRole("VIEWER")
@ApiOperation({
  summary: "Assess organization onboarding readiness",
  description:
    "Returns a read-only, versioned readiness assessment for the organization.",
})
@ApiResponse({
  status: 200,
  description: "Organization readiness assessment returned.",
  type: OrganizationReadinessResponseDto,
})
@ApiResponse({
  status: 403,
  description: "User is not authorized for the organization.",
})
@ApiResponse({
  status: 404,
  description: "Organization not found.",
})
async getReadiness(
  @Param("id") organizationId: string,
): Promise<OrganizationReadinessResponseDto> {
  return this.readinessService.assess(organizationId);
}
  
  @Post(":id/members")
  @UseGuards(AuthGuard, OrganizationMemberGuard)
  @RequiredOrganizationRole("ADMIN")
  @ApiOperation({
    summary: "Assign a member to organization",
    description: "Assign a user to the organization with a specific role. Only organization admins or owners can assign members.",
  })
  @ApiResponse({
    status: 201,
    description: "Member assigned successfully",
    type: OrganizationMemberResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: "User is already a member of this organization",
  })
  @ApiResponse({
    status: 404,
    description: "Organization or user not found",
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - admin or owner role required",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  assignMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
    @Body() input: AssignOrganizationMemberDto,
  ) {
    return this.membersService.assignMember(user, organizationId, input);
  }

  @Get(":id/members")
  @UseGuards(AuthGuard, OrganizationMemberGuard)
  @ApiOperation({
    summary: "List organization members",
    description: "List members of an organization. All members can view the member list.",
  })
  @ApiResponse({
    status: 200,
    description: "Members retrieved successfully",
  })
  @ApiResponse({
    status: 404,
    description: "Organization not found or user is not a member",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
    @Query() query: ListOrganizationMembersDto,
  ) {
    return this.membersService.listMembers(user, organizationId, query);
  }

  @Patch(":id/members/:memberId/role")
  @UseGuards(AuthGuard, OrganizationMemberGuard)
  @RequiredOrganizationRole("OWNER")
  @ApiOperation({
    summary: "Update member role",
    description: "Update a member's role in the organization. Only organization owners can change roles.",
  })
  @ApiResponse({
    status: 200,
    description: "Member role updated successfully",
    type: OrganizationMemberResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Organization or member not found",
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - owner role required, or cannot demote final owner",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  updateMemberRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
    @Param("memberId") memberId: string,
    @Body() input: UpdateOrganizationMemberRoleDto,
  ) {
    return this.membersService.updateMemberRole(
      user,
      organizationId,
      memberId,
      input,
    );
  }

  @Delete(":id/members/:memberId")
  @UseGuards(AuthGuard, OrganizationMemberGuard)
  @RequiredOrganizationRole("OWNER")
  @ApiOperation({
    summary: "Remove member from organization",
    description: "Remove a user from the organization. Only organization owners can remove members.",
  })
  @ApiResponse({
    status: 204,
    description: "Member removed successfully",
  })
  @ApiResponse({
    status: 404,
    description: "Organization or member not found",
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - owner role required, or cannot remove final owner",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
    @Param("memberId") memberId: string,
  ) {
    return this.membersService.removeMember(user, organizationId, memberId);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard, RoleGuard, RecentAuthGuard)
  @RequireRecentAuth(DESTRUCTIVE_ACTIONS.ORG_DELETE)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Delete an organization (destructive — requires recent-auth)",
    description:
      "Permanently deletes an organization. Requires a recent-auth assertion token " +
      "in the X-Recent-Auth header (obtained from POST /auth/assert).",
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: "Organization deleted." })
  @ApiResponse({ status: 401, description: "Session token invalid.", type: ApiErrorDto })
  @ApiResponse({ status: 403, description: "Not authorized or recent-auth missing.", type: ApiErrorDto })
  async deleteOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") organizationId: string,
    @Req() req: Request,
  ): Promise<void> {
    const assertionToken = String(req.headers["x-recent-auth"] ?? "");
    const origin = String(req.headers["origin"] ?? "null");
    // Consume the assertion — this is the point of no return.
    await this.recentAuthService.consume({
      token: assertionToken,
      action: DESTRUCTIVE_ACTIONS.ORG_DELETE,
      resourceId: organizationId,
      origin,
    });
    await this.organizationsService.deleteOrganization(user, organizationId);
  }
}
