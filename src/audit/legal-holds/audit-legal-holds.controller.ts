import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../../auth/auth.types";
import { AuthenticatedRoute } from "../../common/decorators/authorization-policy.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RequiredRole } from "../../common/decorators/required-role.decorator";
import { ApiErrorDto } from "../../common/dto/api-error.dto";
import { AuthGuard } from "../../common/guards/auth.guard";
import { RoleGuard } from "../../common/guards/role.guard";
import { SESSION_AUTH_SCHEME } from "../../common/swagger/security-schemes";
import { AuditLegalHoldService } from "./audit-legal-hold.service";
import {
  AuditLegalHoldTransitionDto,
  CreateAuditLegalHoldDto,
  ListAuditLegalHoldsDto,
} from "./dto/audit-legal-hold.dto";

const STALE_OR_INVALID =
  "Stale expectedRevision, a concurrent decision won, the hold is not in the " +
  "required status, or its approval deadline or expiry has passed.";

/**
 * Audit retention legal holds (#311). Platform ADMIN only, like the rest of
 * the audit administration surface; independence between administrators is
 * enforced per transition by the service.
 */
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@ApiTags("admin-audit-logs")
@AuthenticatedRoute({ roles: ["ADMIN"] })
@Controller("admin/audit-legal-holds")
@UseGuards(AuthGuard, RoleGuard)
@RequiredRole("ADMIN")
@ApiUnauthorizedResponse({ description: "Missing or invalid session.", type: ApiErrorDto })
@ApiForbiddenResponse({
  description: "Not a platform ADMIN, or the same administrator on both sides of a decision.",
  type: ApiErrorDto,
})
export class AuditLegalHoldsController {
  constructor(private readonly holds: AuditLegalHoldService) {}

  @Post()
  @ApiOperation({
    summary: "Request an audit legal hold",
    description:
      "Creates a PENDING_APPROVAL hold that suspends audit cleanup for the range " +
      "immediately, until approved by another administrator or until its 72-hour " +
      "approval window lapses. The reason is accepted only as a SHA-256 commitment.",
  })
  @ApiBadRequestResponse({ description: "Invalid scope, range, expiry, or commitment.", type: ApiErrorDto })
  @ApiNotFoundResponse({ description: "Organization not found.", type: ApiErrorDto })
  @ApiConflictResponse({ description: "Too many holds already in effect.", type: ApiErrorDto })
  request(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAuditLegalHoldDto) {
    return this.holds.request(user, dto);
  }

  @Get()
  @ApiOperation({ summary: "List audit legal holds", description: "Newest first, cursor-paged." })
  @ApiOkResponse({ description: "Holds and the next cursor." })
  list(@Query() query: ListAuditLegalHoldsDto) {
    return this.holds.list(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get an audit legal hold" })
  @ApiNotFoundResponse({ description: "Hold not found.", type: ApiErrorDto })
  get(@Param("id") id: string) {
    return this.holds.get(id);
  }

  @Post(":id/approve")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Approve a pending legal hold (not by its requester)" })
  @ApiNotFoundResponse({ description: "Hold not found.", type: ApiErrorDto })
  @ApiConflictResponse({ description: STALE_OR_INVALID, type: ApiErrorDto })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: AuditLegalHoldTransitionDto,
  ) {
    return this.holds.approve(user, id, dto);
  }

  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reject a pending legal hold (not by its requester)" })
  @ApiNotFoundResponse({ description: "Hold not found.", type: ApiErrorDto })
  @ApiConflictResponse({ description: STALE_OR_INVALID, type: ApiErrorDto })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: AuditLegalHoldTransitionDto,
  ) {
    return this.holds.reject(user, id, dto);
  }

  @Post(":id/release-request")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Request release of an active legal hold",
    description: "The hold keeps protecting records until a different administrator approves the release.",
  })
  @ApiNotFoundResponse({ description: "Hold not found.", type: ApiErrorDto })
  @ApiConflictResponse({ description: STALE_OR_INVALID, type: ApiErrorDto })
  requestRelease(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: AuditLegalHoldTransitionDto,
  ) {
    return this.holds.requestRelease(user, id, dto);
  }

  @Post(":id/release")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Approve a pending release (not by the administrator who requested it)" })
  @ApiNotFoundResponse({ description: "Hold not found.", type: ApiErrorDto })
  @ApiConflictResponse({ description: STALE_OR_INVALID, type: ApiErrorDto })
  approveRelease(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: AuditLegalHoldTransitionDto,
  ) {
    return this.holds.approveRelease(user, id, dto);
  }
}
