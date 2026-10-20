import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { ApprovalsService } from "./approvals.service";
import { CreateApprovalRequestDto } from "./dto/create-approval-request.dto";
import { DecideApprovalRequestDto } from "./dto/decide-approval-request.dto";

@ApiBearerAuth()
@ApiTags("approvals")
@Controller("approvals")
@UseGuards(AuthGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post()
  @ApiOperation({ summary: "Request approval for a privileged operation" })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateApprovalRequestDto) {
    return this.approvals.create(user, dto);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get an approval request" })
  get(@Param("id") id: string) {
    return this.approvals.get(id);
  }

  @Post(":id/approve")
  @ApiOperation({ summary: "Approve a pending request (not the requester)" })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: DecideApprovalRequestDto,
  ) {
    return this.approvals.approve(user, id, dto);
  }

  @Post(":id/reject")
  @ApiOperation({ summary: "Reject a pending request (not the requester)" })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: DecideApprovalRequestDto,
  ) {
    return this.approvals.reject(user, id, dto);
  }

  @Post(":id/cancel")
  @ApiOperation({ summary: "Cancel a pending request (requester or admin)" })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.approvals.cancel(user, id);
  }
}
