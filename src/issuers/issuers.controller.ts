import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { CreateIssuerDto } from "./dto/create-issuer.dto";
import {
  IssuerPublicResponseDto,
  IssuerResponseDto,
} from "./dto/issuer-response.dto";
import { ListIssuersDto } from "./dto/list-issuers.dto";
import { SyncIssuerStatusResponseDto } from "./dto/sync-issuer-status.dto";
import { UpdateIssuerMetadataDto } from "./dto/update-issuer-metadata.dto";
import { UpdateIssuerStatusDto } from "./dto/update-issuer-status.dto";
import { IssuersService } from "./issuers.service";

@ApiTags("issuers")
@AuthenticatedRoute({ roles: ["ADMIN"] })
@Controller("issuers")
export class IssuersController {
  constructor(private readonly issuersService: IssuersService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Create a new issuer",
    description:
      "Admin-only endpoint to create a new issuer for an organization",
  })
  @ApiResponse({
    status: 201,
    description: "Issuer created successfully with PENDING status",
    type: IssuerResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: "Issuer with this Stellar address already exists",
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - admin role required",
  })
  @ApiResponse({
    status: 404,
    description: "Organization not found",
  })
  @ApiResponse({
    status: 400,
    description: "Invalid Stellar address format",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  createIssuer(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateIssuerDto,
  ) {
    return this.issuersService.createIssuer(user, input);
  }

  @Patch(":id/metadata")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Update issuer public metadata",
    description:
      "Admin-only endpoint to update issuer metadata (name, description, logo)",
  })
  @ApiResponse({
    status: 200,
    description: "Issuer metadata updated successfully",
    type: IssuerResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Issuer not found",
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
  updateIssuerMetadata(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") issuerId: string,
    @Body() input: UpdateIssuerMetadataDto,
  ) {
    return this.issuersService.updateIssuerMetadata(user, issuerId, input);
  }

  @Patch(":id/status")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Update issuer status",
    description:
      "Admin-only endpoint to transition issuer status (PENDING→ACTIVE, ACTIVE→SUSPENDED, etc.)",
  })
  @ApiResponse({
    status: 200,
    description: "Issuer status updated successfully",
    type: IssuerResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Issuer not found",
  })
  @ApiResponse({
    status: 400,
    description: "Invalid status transition",
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
  updateIssuerStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") issuerId: string,
    @Body() input: UpdateIssuerStatusDto,
  ) {
    return this.issuersService.updateIssuerStatus(user, issuerId, input);
  }

  @Post(":id/sync")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Sync issuer status to contract",
    description:
      "Admin-only endpoint to synchronize issuer status to the Stellar issuer registry contract",
  })
  @ApiResponse({
    status: 200,
    description: "Sync status recorded",
    type: SyncIssuerStatusResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Issuer not found",
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
  syncIssuerStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") issuerId: string,
  ) {
    return this.issuersService.syncIssuerStatus(user, issuerId);
  }

  @Get()
  @ApiOperation({
    summary: "List issuers (public)",
    description:
      "Public, cursor-paginated endpoint listing active issuers with allowlisted " +
      "metadata, ordered deterministically by `createdAt` then `id`. Non-authenticated " +
      "users see public listing. Pass `pageInfo.nextCursor` from a response as the next " +
      "request's `cursor`.",
  })
  @ApiResponse({
    status: 200,
    description: "Issuers retrieved successfully",
  })
  @ApiResponse({
    status: 400,
    description: "Invalid pagination or filter parameters",
    type: ApiErrorDto,
  })
  listIssuersPublic(@Query() query: ListIssuersDto) {
    return this.issuersService.listIssuersPublic(query);
  }

  @Get("admin/:id")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Get issuer details (admin)",
    description:
      "Admin-only endpoint to get full issuer details including metadata hash and timestamps",
  })
  @ApiResponse({
    status: 200,
    description: "Issuer retrieved successfully",
    type: IssuerResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Issuer not found",
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
  getIssuer(@Param("id") issuerId: string) {
    return this.issuersService.getIssuer(issuerId);
  }

  @Get("admin")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "List issuers (admin)",
    description:
      "Admin-only, cursor-paginated endpoint to list all issuers with full details and " +
      "ability to filter by status/organization, ordered deterministically by " +
      "`createdAt` then `id`. Pass `pageInfo.nextCursor` from a response as the next " +
      "request's `cursor`.",
  })
  @ApiResponse({
    status: 200,
    description: "Issuers retrieved successfully",
  })
  @ApiResponse({
    status: 401,
    description: "Session token is missing, malformed, invalid, or expired",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 403,
    description: "Unauthorized - admin role required",
    type: ApiErrorDto,
  })
  listIssuersAdmin(@Query() query: ListIssuersDto) {
    return this.issuersService.listIssuers(query);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get issuer details (public)",
    description:
      "Public endpoint to get issuer details with allowlisted metadata and trust status",
  })
  @ApiResponse({
    status: 200,
    description: "Issuer retrieved successfully",
    type: IssuerPublicResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: "Issuer not found",
  })
  getIssuerPublic(@Param("id") issuerId: string) {
    return this.issuersService.getIssuerPublic(issuerId);
  }
}
