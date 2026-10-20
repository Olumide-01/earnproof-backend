import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
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
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { AttestationsService } from "./attestations.service";
import { CreateAttestationDto } from "./dto/create-attestation.dto";
import { RevokeAttestationDto } from "./dto/revoke-attestation.dto";
import {
  AttestationResponseDto,
  ListAttestationsResponseDto,
} from "./dto/attestation-response.dto";
import { ListAttestationsDto } from "./dto/list-attestations.dto";

@ApiTags("attestations")
@Controller("attestations")
export class AttestationsController {
  constructor(private readonly attestationsService: AttestationsService) {}

  @Post(":issuerId")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Create a new attestation",
    description:
      "Admin-only endpoint to create an attestation issued by an active issuer. " +
      "The attestation is created with ACTIVE status and optional expiration.",
  })
  @ApiParam({
    name: "issuerId",
    description: "ID of the issuer creating this attestation",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Attestation created successfully",
    type: AttestationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "Issuer is not ACTIVE or expiresAt is invalid (not in future)",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Issuer not found",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Unauthorized - admin role required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  createAttestation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("issuerId") issuerId: string,
    @Body() input: CreateAttestationDto,
  ) {
    return this.attestationsService.createAttestation(user, issuerId, input);
  }

  @Get(":issuerId/:attestationId")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Retrieve a specific attestation",
    description:
      "Admin-only endpoint to retrieve a single attestation by ID, " +
      "including lifecycle metadata and revocation details.",
  })
  @ApiParam({
    name: "issuerId",
    description: "ID of the issuer that created this attestation",
  })
  @ApiParam({
    name: "attestationId",
    description: "ID of the attestation to retrieve",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Attestation retrieved successfully",
    type: AttestationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Attestation not found or does not belong to this issuer",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Unauthorized - admin role required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  getAttestation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("issuerId") issuerId: string,
    @Param("attestationId") attestationId: string,
  ) {
    return this.attestationsService.getAttestation(issuerId, attestationId);
  }

  @Get(":issuerId")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "List attestations for an issuer",
    description:
      "Admin-only endpoint to list attestations created by an issuer. " +
      "Supports filtering by status, type, subject, and expiration date range. " +
      "Results are paginated (default 20 per page, max 100).",
  })
  @ApiParam({
    name: "issuerId",
    description: "ID of the issuer",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Attestations retrieved successfully",
    type: ListAttestationsResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Invalid filter parameters or pagination",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Unauthorized - admin role required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  listAttestations(
    @CurrentUser() user: AuthenticatedUser,
    @Param("issuerId") issuerId: string,
    @Query() query: ListAttestationsDto,
  ) {
    return this.attestationsService.listAttestations(issuerId, query);
  }

  @Patch(":issuerId/:attestationId/revoke")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Revoke an attestation",
    description:
      "Admin-only endpoint to revoke an attestation. " +
      "The attestation is marked as REVOKED and the revocation is recorded in the immutable audit trail. " +
      "Revoked attestations cannot be used for proof issuance. " +
      "An optional reason can be provided for audit purposes.",
  })
  @ApiParam({
    name: "issuerId",
    description: "ID of the issuer that created this attestation",
  })
  @ApiParam({
    name: "attestationId",
    description: "ID of the attestation to revoke",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Attestation revoked successfully",
    type: AttestationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Attestation not found or does not belong to this issuer",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Attestation is already revoked",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Unauthorized - admin role required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  revokeAttestation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("issuerId") issuerId: string,
    @Param("attestationId") attestationId: string,
    @Body() input: RevokeAttestationDto,
  ) {
    return this.attestationsService.revokeAttestation(
      user,
      issuerId,
      attestationId,
      input,
    );
  }
}
