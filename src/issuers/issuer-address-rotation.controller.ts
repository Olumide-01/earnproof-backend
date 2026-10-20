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
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import {
  IssuerAddressRotationResponseDto,
  IssuerAddressRotationsResponseDto,
  RequestIssuerAddressRotationDto,
} from "./dto/issuer-address-rotation.dto";
import { IssuerAddressRotationService } from "./issuer-address-rotation.service";

@ApiTags("issuers")
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@ApiResponse({
  status: HttpStatus.UNAUTHORIZED,
  description: "Session token is missing, malformed, invalid, or expired",
  type: ApiErrorDto,
})
@ApiResponse({ status: HttpStatus.FORBIDDEN, description: "ADMIN role required", type: ApiErrorDto })
@ApiResponse({ status: HttpStatus.NOT_FOUND, description: "Issuer or rotation not found", type: ApiErrorDto })
@UseGuards(AuthGuard, RoleGuard)
@Controller("issuers")
export class IssuerAddressRotationController {
  constructor(private readonly rotations: IssuerAddressRotationService) {}

  @Post(":id/address-rotations")
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Rotate an issuer's Stellar address",
    description:
      "Records the rotation and submits it to the issuer registry contract. The issuer's " +
      "address changes only once the contract is observed to hold the new address; until " +
      "then the rotation stays open and is reconciled automatically, including after a " +
      "timeout or restart.",
  })
  @ApiResponse({ status: HttpStatus.ACCEPTED, type: IssuerAddressRotationResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: "Invalid or unchanged address", type: ApiErrorDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      "Stale revision, revoked or unregistered issuer, a rotation already in progress, or a " +
      "replacement address that is registered, reserved, or previously used.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: "The issuer registry is not configured",
    type: ApiErrorDto,
  })
  request(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("id") issuerId: string,
    @Body() body: RequestIssuerAddressRotationDto,
  ) {
    return this.rotations.requestRotation(actor, issuerId, body);
  }

  @Get(":id/address-rotations")
  @RequiredRole("ADMIN")
  @ApiOperation({ summary: "List an issuer's address rotations and retired addresses" })
  @ApiResponse({ status: HttpStatus.OK, type: IssuerAddressRotationsResponseDto })
  list(@Param("id") issuerId: string) {
    return this.rotations.listForIssuer(issuerId);
  }

  @Post(":id/address-rotations/:rotationId/reconcile")
  @HttpCode(HttpStatus.OK)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Reconcile an open address rotation now",
    description:
      "Reads the contract and moves the rotation forward. Safe to repeat; a closed rotation is " +
      "returned unchanged.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: IssuerAddressRotationResponseDto })
  reconcile(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("id") issuerId: string,
    @Param("rotationId") rotationId: string,
  ) {
    return this.rotations.reconcileForIssuer(actor, issuerId, rotationId);
  }
}
