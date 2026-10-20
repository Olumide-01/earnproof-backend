import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
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
import { UpdateAccountStatusDto } from "./dto/update-account-status.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UpdateUserRoleDto } from "./dto/update-user-role.dto";
import {
  AccountStatusChangeResponseDto,
  AdminUserResponseDto,
  UserProfileResponseDto,
  UserRoleChangeResponseDto,
} from "./dto/user-profile-response.dto";
import { UsersService } from "./users.service";

/**
 * User profile and account administration.
 *
 * Self-service routes (`/users/me`) take the user's identity from the session
 * and never from a path parameter, so there is no identifier a caller could
 * swap to reach another account. Routes addressed by `:id` are ADMIN-only.
 */
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@ApiTags("users")
@ApiResponse({
  status: HttpStatus.UNAUTHORIZED,
  description:
    "Session token is missing, malformed, expired or revoked, or the account is not active.",
  type: ApiErrorDto,
})
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("me")
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: "Get the caller's own profile" })
  @ApiResponse({ status: HttpStatus.OK, type: UserProfileResponseDto })
  getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getProfile(user.id);
  }

  @Patch("me")
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "Update the caller's own profile",
    description:
      "Only `displayName` is writable. Any other field (role, status, wallet address) is rejected.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: UserProfileResponseDto })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "Request body failed validation or carried a non-writable field.",
    type: ApiErrorDto,
  })
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.id, input);
  }

  @Get(":id")
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({ summary: "Get an account (admin)" })
  @ApiResponse({ status: HttpStatus.OK, type: AdminUserResponseDto })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: "ADMIN role required", type: ApiErrorDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: "User not found", type: ApiErrorDto })
  getUser(@Param("id") userId: string) {
    return this.usersService.getUser(userId);
  }

  @Patch(":id/status")
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Change an account's status (admin)",
    description:
      "Allowed transitions: PENDING→ACTIVE|SUSPENDED|REVOKED, ACTIVE→SUSPENDED|REVOKED, " +
      "SUSPENDED→ACTIVE|REVOKED. REVOKED is terminal. SUSPENDED and REVOKED revoke every " +
      "live session in the same transaction. Administrators cannot change their own status.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: AccountStatusChangeResponseDto })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: "ADMIN role required, or self-change attempted", type: ApiErrorDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: "User not found", type: ApiErrorDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Transition not allowed or concurrent change", type: ApiErrorDto })
  changeStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("id") userId: string,
    @Body() input: UpdateAccountStatusDto,
  ) {
    return this.usersService.changeStatus(actor, userId, input);
  }

  @Patch(":id/role")
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Change an account's role (admin)",
    description:
      "Requires an ACTIVE account. An account that still owns a live organization cannot be " +
      "moved to WORKER. Administrators cannot change their own role.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: UserRoleChangeResponseDto })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: "ADMIN role required, or self-change attempted", type: ApiErrorDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: "User not found", type: ApiErrorDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Role change violates account or organization policy", type: ApiErrorDto })
  changeRole(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("id") userId: string,
    @Body() input: UpdateUserRoleDto,
  ) {
    return this.usersService.changeRole(actor, userId, input);
  }
}
