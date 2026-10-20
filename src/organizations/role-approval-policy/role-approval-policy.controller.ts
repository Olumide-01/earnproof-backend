import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
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
import { ApiErrorDto } from "../../common/dto/api-error.dto";
import { AuthGuard } from "../../common/guards/auth.guard";
import { SESSION_AUTH_SCHEME } from "../../common/swagger/security-schemes";
import {
  ListRoleApprovalPolicyHistoryDto,
  PreviewRoleApprovalPolicyDto,
  RoleApprovalPolicyHistoryResponseDto,
  RoleApprovalPolicyResponseDto,
  UpdateRoleApprovalPolicyDto,
} from "./dto/role-approval-policy.dto";
import { RoleApprovalPolicyService } from "./role-approval-policy.service";

/**
 * Organization role approval policy endpoints (#298).
 *
 * Organization-level authorization (member, ADMIN, OWNER) is checked by the
 * service because it depends on the organization named in the path.
 */
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@ApiTags("organizations")
@AuthenticatedRoute()
@Controller("organizations/:organizationId/role-approval-policy")
@UseGuards(AuthGuard)
@ApiUnauthorizedResponse({ description: "Missing or invalid session.", type: ApiErrorDto })
@ApiNotFoundResponse({ description: "Organization not found.", type: ApiErrorDto })
export class RoleApprovalPolicyController {
  constructor(private readonly policies: RoleApprovalPolicyService) {}

  @Get()
  @ApiOperation({
    summary: "Get the active role approval policy",
    description:
      "Returns the active policy, or the platform default reported as version 0 " +
      "when none has been stored. Any active organization member may read it.",
  })
  @ApiOkResponse({ type: RoleApprovalPolicyResponseDto })
  @ApiForbiddenResponse({ description: "Not an organization member.", type: ApiErrorDto })
  getActive(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
  ) {
    return this.policies.getActive(user, organizationId);
  }

  @Put()
  @ApiOperation({
    summary: "Update the role approval policy",
    description:
      "Creates the next policy version and supersedes the active one. Requires " +
      "the organization OWNER role. `expectedVersion` must equal the active " +
      "version; otherwise the update is stale and rejected with 409.",
  })
  @ApiOkResponse({ type: RoleApprovalPolicyResponseDto })
  @ApiBadRequestResponse({
    description:
      "Invalid body, a policy below platform minimums (with violation codes), or no change.",
    type: ApiErrorDto,
  })
  @ApiForbiddenResponse({ description: "Caller is not an organization OWNER.", type: ApiErrorDto })
  @ApiConflictResponse({
    description: "Stale expectedVersion, a concurrent update won, or the organization is archived.",
    type: ApiErrorDto,
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Body() dto: UpdateRoleApprovalPolicyDto,
  ) {
    return this.policies.update(user, organizationId, dto);
  }

  @Post("preview")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Preview a role approval policy change",
    description:
      "Validates a proposed policy without saving it. Platform-minimum " +
      "violations are returned as codes in a 200 response; the field-level " +
      "diff against the active version and, optionally, the approvals a sample " +
      "role change would need are included. Requires the organization ADMIN role.",
  })
  @ApiOkResponse({ description: "Preview result." })
  @ApiBadRequestResponse({ description: "Structurally invalid body.", type: ApiErrorDto })
  @ApiForbiddenResponse({ description: "Caller is not an organization ADMIN or OWNER.", type: ApiErrorDto })
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Body() dto: PreviewRoleApprovalPolicyDto,
  ) {
    return this.policies.preview(user, organizationId, dto);
  }

  @Get("history")
  @ApiOperation({
    summary: "List role approval policy versions",
    description:
      "Stored versions, newest first, paged with `beforeVersion`. The implicit " +
      "platform default (version 0) is never stored and so never listed.",
  })
  @ApiOkResponse({ type: RoleApprovalPolicyHistoryResponseDto })
  @ApiForbiddenResponse({ description: "Not an organization member.", type: ApiErrorDto })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Query() query: ListRoleApprovalPolicyHistoryDto,
  ) {
    return this.policies.history(user, organizationId, query);
  }
}
