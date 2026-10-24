import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { PublicRoute } from "../common/decorators/authorization-policy.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { AcceptOrganizationInvitationDto } from "./dto/accept-organization-invitation.dto";
import { DeclineOrganizationInvitationDto } from "./dto/decline-organization-invitation.dto";
import { InspectOrganizationInvitationDto } from "./dto/inspect-organization-invitation.dto";
import { InspectOrganizationInvitationResponseDto } from "./dto/organization-invitation-response.dto";
import { OrganizationInvitationsService } from "./organization-invitations.service";

@ApiTags("invitations")
@Controller("invitations")
export class InvitationsController {
  constructor(
    private readonly invitationsService: OrganizationInvitationsService,
  ) {}

  @Post("inspect")
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Inspect an organization invitation by token",
    description:
      "Returns invitation details (tenant, role, recipient wallet, status, expiry) " +
      "without requiring session authentication. Secrets and hashes are never returned.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Invitation inspected successfully",
    type: InspectOrganizationInvitationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Invalid or nonexistent invitation token",
    type: ApiErrorDto,
  })
  inspect(
    @Body() body: InspectOrganizationInvitationDto,
  ): Promise<InspectOrganizationInvitationResponseDto> {
    return this.invitationsService.inspectInvitation(body.token);
  }

  @Get(":token")
  @PublicRoute()
  @ApiOperation({
    summary: "Inspect an organization invitation by token in path",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Invitation inspected successfully",
    type: InspectOrganizationInvitationResponseDto,
  })
  inspectByParam(
    @Param("token") token: string,
  ): Promise<InspectOrganizationInvitationResponseDto> {
    return this.invitationsService.inspectInvitation(token);
  }

  @Post("accept")
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Accept an organization invitation with an authenticated wallet",
    description:
      "Accepts the invitation and atomically creates organization membership. " +
      "Fails closed on replay, wrong-wallet, expired, revoked, or cross-tenant attempts.",
  })
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
    @Body() body: AcceptOrganizationInvitationDto,
  ) {
    return this.invitationsService.acceptInvitation(user, body);
  }

  @Post("decline")
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Decline an organization invitation",
    description:
      "Declines the invitation. Fails closed on wrong-wallet or cross-tenant attempts.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Invitation declined successfully",
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Wrong wallet or cross-tenant attempt",
    type: ApiErrorDto,
  })
  decline(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DeclineOrganizationInvitationDto,
  ) {
    return this.invitationsService.declineInvitation(user, body);
  }
}
