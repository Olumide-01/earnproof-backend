import {
  Body,
  Controller,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "../common/guards/auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../auth/auth.types";
import { SupportAccessService } from "./support-access.service";
import { CreateSupportAccessGrantDto, RevokeSupportAccessGrantDto } from "./dto/support-access.dto";

@ApiTags("Support Access")
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller("organizations/:organizationId/support-access")
export class SupportAccessController {
  constructor(private readonly supportAccessService: SupportAccessService) {}

  @Post()
  @ApiOperation({ summary: "Request a time-limited support access grant" })
  createGrant(
    @CurrentUser() user: AuthenticatedUser,
    @Param("organizationId") organizationId: string,
    @Body() dto: CreateSupportAccessGrantDto,
  ) {
    return this.supportAccessService.createGrant(organizationId, user.id, dto);
  }

  @Patch(":grantId/approve")
  @ApiOperation({ summary: "Approve a pending support access grant (tenant admin)" })
  approveGrant(
    @CurrentUser() user: AuthenticatedUser,
    @Param("grantId") grantId: string,
  ) {
    return this.supportAccessService.approveGrant(grantId, user.id);
  }

  @Patch(":grantId/activate")
  @ApiOperation({ summary: "Activate an approved support access grant (support user)" })
  activateGrant(
    @CurrentUser() user: AuthenticatedUser,
    @Param("grantId") grantId: string,
  ) {
    return this.supportAccessService.activateGrant(grantId, user.id);
  }

  @Patch(":grantId/revoke")
  @ApiOperation({ summary: "Revoke an active or approved support access grant" })
  revokeGrant(
    @CurrentUser() user: AuthenticatedUser,
    @Param("grantId") grantId: string,
    @Body() dto: RevokeSupportAccessGrantDto,
  ) {
    return this.supportAccessService.revokeGrant(grantId, user.id, dto);
  }
}
