import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import {
  DeletionEligibilityResponseDto,
  OrganizationDeletionResponseDto,
  OrganizationLifecycleResponseDto,
  PlaceLegalHoldDto,
} from "./dto/organization-lifecycle.dto";
import { OrganizationLifecycleService } from "./organization-lifecycle.service";

/**
 * Organization retirement: archive, restore, legal hold and deletion.
 *
 * Every route is ADMIN-only. Deletion revokes the organization's credentials
 * and cannot be undone, so it is never delegated to the organization's
 * creator.
 */
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@ApiTags("organizations")
@ApiResponse({
  status: HttpStatus.UNAUTHORIZED,
  description: "Session token is missing, malformed, invalid, or expired",
  type: ApiErrorDto,
})
@ApiResponse({ status: HttpStatus.FORBIDDEN, description: "ADMIN role required", type: ApiErrorDto })
@ApiResponse({ status: HttpStatus.NOT_FOUND, description: "Organization not found", type: ApiErrorDto })
@UseGuards(AuthGuard, RoleGuard)
@Controller("organizations")
export class OrganizationLifecycleController {
  constructor(private readonly lifecycle: OrganizationLifecycleService) {}

  @Post(":id/archive")
  @HttpCode(HttpStatus.OK)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Archive an organization",
    description:
      "Atomically disables new privileged operations: its API keys stop authenticating, API keys " +
      "cannot be issued or rotated, webhooks stop receiving events, issuers cannot be registered " +
      "or activated, attestations cannot be issued and the profile cannot change. Nothing is " +
      "revoked, so restore is lossless. Issued proofs and attestations stay verifiable.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: OrganizationLifecycleResponseDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Already archived, or deleted", type: ApiErrorDto })
  archive(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
    return this.lifecycle.archive(actor, id);
  }

  @Post(":id/restore")
  @HttpCode(HttpStatus.OK)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Restore an archived organization",
    description: "Allowed for any archived organization that has not been deleted.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: OrganizationLifecycleResponseDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Not archived, or deleted", type: ApiErrorDto })
  restore(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
    return this.lifecycle.restore(actor, id);
  }

  @Put(":id/legal-hold")
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Place a legal hold on an organization",
    description:
      "A legal hold blocks deletion until it is released. It does not block archive or restore.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: OrganizationLifecycleResponseDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Already under legal hold, or deleted", type: ApiErrorDto })
  @ApiResponse({ status: HttpStatus.UNPROCESSABLE_ENTITY, description: "Invalid reference", type: ApiErrorDto })
  placeLegalHold(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: PlaceLegalHoldDto,
  ) {
    return this.lifecycle.placeLegalHold(actor, id, body.reference);
  }

  @Delete(":id/legal-hold")
  @RequiredRole("ADMIN")
  @ApiOperation({ summary: "Release a legal hold on an organization" })
  @ApiResponse({ status: HttpStatus.OK, type: OrganizationLifecycleResponseDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Not under legal hold, or deleted", type: ApiErrorDto })
  releaseLegalHold(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
    return this.lifecycle.releaseLegalHold(actor, id);
  }

  @Get(":id/deletion-eligibility")
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Report whether an organization can be deleted",
    description:
      "Lists blocking conditions as codes with counts, never identifiers: NOT_ARCHIVED, " +
      "ARCHIVE_RETENTION_PERIOD, LEGAL_HOLD, ACTIVE_ISSUERS, ISSUER_REGISTRY_OUT_OF_SYNC.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: DeletionEligibilityResponseDto })
  getDeletionEligibility(@Param("id") id: string) {
    return this.lifecycle.getDeletionEligibility(id);
  }

  @Delete(":id")
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Delete an archived organization",
    description:
      "Re-checks eligibility under a row lock, then revokes the organization's API keys, deletes " +
      "its webhooks, deliveries and idempotency records, and turns the organization into an " +
      "anonymised tombstone. Issuers, attestations, proofs and audit records are kept.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: OrganizationDeletionResponseDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Not eligible; the message lists blocker codes", type: ApiErrorDto })
  deleteOrganization(@CurrentUser() actor: AuthenticatedUser, @Param("id") id: string) {
    return this.lifecycle.deleteOrganization(actor, id);
  }
}
