import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { RequiredOrganizationRole } from "./decorators/required-organization-role.decorator";
import { AcceptOrganizationInvitationDto } from "./dto/accept-organization-invitation.dto";
import { CreateOrganizationInvitationDto } from "./dto/create-organization-invitation.dto";
import { DeclineOrganizationInvitationDto } from "./dto/decline-organization-invitation.dto";
import { ListOrganizationInvitationsDto } from "./dto/list-organization-invitations.dto";
import {
  CreateOrganizationInvitationResponseDto,
  InspectOrganizationInvitationResponseDto,
  OrganizationInvitationResponseDto,
  PaginatedOrganizationInvitationsDto,
} from "./dto/organization-invitation-response.dto";
import { OrganizationMemberGuard } from "./guards/organization-member.guard";
import { OrganizationInvitationsService } from "./organization-invitations.service";

@ApiTags("organization-invitations")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("organizations/:organizationId/invitations")
export class OrganizationInvitationsController {
  constructor(
    private readonly invitationsService: OrganizationInvitationsService,
  ) {}

  @Post()
  @UseGuards(OrganizationMemberGuard)
  @RequiredOrganizationRole("ADMIN")
  @ApiOperation({
    summary: "Create an organization invitation",
    description:
      "Admin-only endpoint to create a time-bounded, single-use invitation for a recipient wallet. " +
      "Stores only the hashed invitation secret. Returns the plaintext secret token once upon creation.",
  })
  @ApiParam({ name: "organizationId", description: "Target organization ID" })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Invitation created successfully",
    type: CreateOrganizationInvitationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Recipient is already an active member of this organization",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Insufficient organization permissions",
    type: ApiErrorDto,
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Body() dto: CreateOrganizationInvitationDto,
  ): Promise<CreateOrganizationInvitationResponseDto> {
    return this.invitationsService.createInvitation(user, organizationId, dto);
  }

  @Get()
  @UseGuards(OrganizationMemberGuard)
  @RequiredOrganizationRole("ADMIN")
  @ApiOperation({
    summary: "List organization invitations",
    description:
      "Returns a paginated list of invitations for this organization. Plaintext tokens and hashes are never exposed.",
  })
  @ApiParam({ name: "organizationId", description: "Target organization ID" })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Invitations retrieved successfully",
    type: PaginatedOrganizationInvitationsDto,
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Query() query: ListOrganizationInvitationsDto,
  ): Promise<PaginatedOrganizationInvitationsDto> {
    return this.invitationsService.listInvitations(user, organizationId, query);
  }

  @Get(":invitationId")
  @UseGuards(OrganizationMemberGuard)
  @RequiredOrganizationRole("ADMIN")
  @ApiOperation({
    summary: "Get organization invitation details",
    description: "Retrieves details of an invitation by ID within the organization.",
  })
  @ApiParam({ name: "organizationId", description: "Target organization ID" })
  @ApiParam({ name: "invitationId", description: "Invitation ID" })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Invitation retrieved successfully",
    type: OrganizationInvitationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Invitation not found in this organization",
    type: ApiErrorDto,
  })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("invitationId") invitationId: string,
  ): Promise<OrganizationInvitationResponseDto> {
    return this.invitationsService.getInvitation(user, organizationId, invitationId);
  }

  @Get(":invitationId/inspect")
  @ApiOperation({
    summary: "Inspect an organization invitation",
    description: "Inspects invitation details and current status within the organization.",
  })
  @ApiParam({ name: "organizationId", description: "Target organization ID" })
  @ApiParam({ name: "invitationId", description: "Invitation ID" })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Invitation inspected successfully",
    type: InspectOrganizationInvitationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Invitation not found",
    type: ApiErrorDto,
  })
  inspect(
    @Param("organizationId") organizationId: string,
    @Param("invitationId") invitationId: string,
  ): Promise<InspectOrganizationInvitationResponseDto> {
    return this.invitationsService.inspectInvitation(invitationId, organizationId);
  }

  @Delete(":invitationId")
  @HttpCode(HttpStatus.OK)
  @UseGuards(OrganizationMemberGuard)
  @RequiredOrganizationRole("ADMIN")
  @ApiOperation({
    summary: "Revoke an organization invitation",
    description: "Revokes a pending invitation. Takes effect immediately. Fails if already accepted.",
  })
  @ApiParam({ name: "organizationId", description: "Target organization ID" })
  @ApiParam({ name: "invitationId", description: "Invitation ID" })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Invitation revoked successfully",
    type: OrganizationInvitationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Cannot revoke an already accepted invitation",
    type: ApiErrorDto,
  })
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("invitationId") invitationId: string,
  ): Promise<OrganizationInvitationResponseDto> {
    return this.invitationsService.revokeInvitation(user, organizationId, invitationId);
  }

  @Post(":invitationId/revoke")
  @HttpCode(HttpStatus.OK)
  @UseGuards(OrganizationMemberGuard)
  @RequiredOrganizationRole("ADMIN")
  @ApiOperation({
    summary: "Revoke an organization invitation (POST alias)",
  })
  @ApiParam({ name: "organizationId", description: "Target organization ID" })
  @ApiParam({ name: "invitationId", description: "Invitation ID" })
  revokePost(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("invitationId") invitationId: string,
  ): Promise<OrganizationInvitationResponseDto> {
    return this.invitationsService.revokeInvitation(user, organizationId, invitationId);
  }

  @Post(":invitationId/accept")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Accept an organization invitation under this organization",
    description:
      "Accepts the invitation and atomically creates organization membership. " +
      "Fails closed on replay, wrong-wallet, expired, revoked, or cross-tenant attempts.",
  })
  @ApiParam({ name: "organizationId", description: "Target organization ID" })
  @ApiParam({ name: "invitationId", description: "Invitation ID" })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Invitation accepted and membership created",
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Wrong wallet or cross-tenant attempt",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Replay or already accepted/declined/revoked",
    type: ApiErrorDto,
  })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("invitationId") invitationId: string,
    @Body() body: Partial<AcceptOrganizationInvitationDto>,
  ) {
    const token = body?.token || invitationId;
    return this.invitationsService.acceptInvitation(
      user,
      { token, organizationId },
      organizationId,
    );
  }

  @Post(":invitationId/decline")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Decline an organization invitation under this organization",
    description: "Declines the invitation. Fails closed on wrong-wallet or cross-tenant attempts.",
  })
  @ApiParam({ name: "organizationId", description: "Target organization ID" })
  @ApiParam({ name: "invitationId", description: "Invitation ID" })
  decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Param("invitationId") invitationId: string,
    @Body() body: Partial<DeclineOrganizationInvitationDto>,
  ) {
    const token = body?.token || invitationId;
    return this.invitationsService.declineInvitation(
      user,
      { token, organizationId },
      organizationId,
    );
  }
}
