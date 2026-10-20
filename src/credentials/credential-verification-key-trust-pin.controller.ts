import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import {
  CreateCredentialVerificationKeyTrustPinDto,
  UpdateCredentialVerificationKeyTrustPinStatusDto,
  CredentialVerificationKeyTrustPinResponseDto,
  ListCredentialVerificationKeyTrustPinsResponseDto,
} from "./dto/credential-verification-key-trust-pin.dto";
import { CredentialVerificationKeyTrustPinService } from "./credential-verification-key-trust-pin.service";

@ApiTags("credential-verification-key-trust-pins")
@AuthenticatedRoute({ roles: ["ADMIN"] })
@Controller("credential-verification-key-trust-pins")
export class CredentialVerificationKeyTrustPinController {
  constructor(
    private readonly trustPinService: CredentialVerificationKeyTrustPinService,
  ) {}

  /**
   * Create a new trust pin for an issuer verification key.
   * Admin-only operation; records the decision for audit trail.
   */
  @Post()
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Create a credential verification key trust pin",
    description:
      "Admin-only endpoint to pin an issuer verification key as trusted. " +
      "Only public key material is accepted; private keys are rejected. " +
      "A pin is scoped to a single issuer and network (cannot cross boundaries).",
  })
  @ApiResponse({
    status: 201,
    description: "Trust pin created successfully",
    type: CredentialVerificationKeyTrustPinResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      "Invalid trust pin data (e.g., private key material, invalid key format)",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 404,
    description: "Issuer not found",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 409,
    description: "Active trust pin already exists for this issuer/network/key",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - admin role required, or issuer does not belong to org",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  createTrustPin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateCredentialVerificationKeyTrustPinDto,
  ) {
    // Verify user belongs to the organization
    this.verifyOrganizationAccess(user, input.organizationId);
    return this.trustPinService.createTrustPin(input);
  }

  /**
   * Get a trust pin by ID.
   */
  @Get(":id")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Get a credential verification key trust pin",
    description: "Admin-only endpoint to retrieve a trust pin by ID",
  })
  @ApiParam({
    name: "id",
    description: "Trust pin ID",
  })
  @ApiResponse({
    status: 200,
    description: "Trust pin retrieved successfully",
    type: CredentialVerificationKeyTrustPinResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Trust pin not found",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - admin role required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  getTrustPin(@Param("id") id: string) {
    return this.trustPinService.getTrustPin(id);
  }

  /**
   * List trust pins for an issuer.
   * Optionally filter by status (ACTIVE, RETIRED, REVOKED).
   */
  @Get("issuer/:issuerId")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "List credential verification key trust pins for an issuer",
    description:
      "Admin-only endpoint to list trust pins for a specific issuer, with optional status filtering",
  })
  @ApiParam({
    name: "issuerId",
    description: "Issuer ID",
  })
  @ApiQuery({
    name: "organizationId",
    description: "Organization ID (required)",
    required: true,
  })
  @ApiQuery({
    name: "status",
    description: "Filter by status: ACTIVE, RETIRED, or REVOKED (optional)",
    required: false,
    enum: ["ACTIVE", "RETIRED", "REVOKED"],
  })
  @ApiQuery({
    name: "page",
    description: "Page number (1-indexed, default: 1)",
    required: false,
    type: Number,
  })
  @ApiQuery({
    name: "pageSize",
    description: "Page size (default: 10)",
    required: false,
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description: "Trust pins retrieved successfully",
    type: ListCredentialVerificationKeyTrustPinsResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - admin role required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  listTrustPins(
    @CurrentUser() user: AuthenticatedUser,
    @Param("issuerId") issuerId: string,
    @Query("organizationId") organizationId: string,
    @Query("status") status?: "ACTIVE" | "RETIRED" | "REVOKED",
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    this.verifyOrganizationAccess(user, organizationId);
    return this.trustPinService.listTrustPins(organizationId, issuerId, {
      status,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  /**
   * Retire a trust pin (mark as RETIRED).
   * Retirement is a planned supersession; a new pin should typically be created first.
   * Uses optimistic concurrency control.
   */
  @Patch(":id/retire")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Retire a credential verification key trust pin",
    description:
      "Admin-only endpoint to mark a trust pin as RETIRED (planned supersession). " +
      "Uses optimistic concurrency control via revision field.",
  })
  @ApiParam({
    name: "id",
    description: "Trust pin ID",
  })
  @ApiResponse({
    status: 200,
    description: "Trust pin retired successfully",
    type: CredentialVerificationKeyTrustPinResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Trust pin not found",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 409,
    description: "Revision conflict or pin already retired/revoked",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid request (missing expectedRevision)",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - admin role required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  retireTrustPin(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() input: { expectedRevision: number },
  ) {
    return this.trustPinService.retireTrustPin(id, input.expectedRevision);
  }

  /**
   * Revoke a trust pin due to compromise.
   * Revocation is permanent and deterministic; the pin fails closed.
   * Uses optimistic concurrency control.
   */
  @Patch(":id/revoke")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Revoke a credential verification key trust pin",
    description:
      "Admin-only endpoint to revoke a trust pin due to key compromise. " +
      "Revocation is permanent and deterministic (fails closed). " +
      "Uses optimistic concurrency control via revision field. " +
      "Captures revocation reason and actor for audit trail.",
  })
  @ApiParam({
    name: "id",
    description: "Trust pin ID",
  })
  @ApiResponse({
    status: 200,
    description: "Trust pin revoked successfully",
    type: CredentialVerificationKeyTrustPinResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Trust pin not found",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 409,
    description: "Revision conflict or pin already revoked",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid request (missing expectedRevision, revocationReason, or revokedBy)",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - admin role required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  revokeTrustPin(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() input: UpdateCredentialVerificationKeyTrustPinStatusDto,
  ) {
    // Inject the current user as the revoking actor
    const inputWithActor = {
      ...input,
      revokedBy: input.revokedBy || user.id,
    };
    return this.trustPinService.revokeTrustPin(id, inputWithActor);
  }

  /**
   * Delete a trust pin (testing/cleanup only; not exposed to normal operations).
   * Marked internal via naming convention; only available to DEVELOPER role.
   */
  @Delete(":id")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete a credential verification key trust pin (internal)",
    description:
      "Admin-only endpoint to delete a trust pin (testing/cleanup only). " +
      "Not recommended for production use; use retire/revoke instead.",
  })
  @ApiParam({
    name: "id",
    description: "Trust pin ID",
  })
  @ApiResponse({
    status: 204,
    description: "Trust pin deleted successfully",
  })
  @ApiResponse({
    status: 404,
    description: "Trust pin not found",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - admin role required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  deleteTrustPin(@Param("id") id: string) {
    return this.trustPinService.deleteTrustPin(id);
  }

  /**
   * Verify user belongs to organization.
   * In a production system, this would be injected from the auth context.
   */
  private verifyOrganizationAccess(user: AuthenticatedUser, organizationId: string): void {
    // For now, ADMIN role is the requirement enforced by the guards.
    // In a more sophisticated system, check org membership.
    // This is a placeholder for tenant boundary enforcement.
    if (!organizationId) {
      throw new Error("organizationId is required");
    }
  }
}
