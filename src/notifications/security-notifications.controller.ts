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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "../common/guards/auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../auth/auth.types";
import { SecurityNotificationService } from "./security-notification.service";
import {
  CreateSecurityNotificationDto,
  ListSecurityNotificationsDto,
} from "./dto/security-notification.dto";

@ApiTags("security-notifications")
@Controller("organizations/:orgId/security-notifications")
export class SecurityNotificationsController {
  constructor(
    private readonly notificationService: SecurityNotificationService,
  ) {}

  @ApiOperation({
    summary: "Create a security notification",
    description: "Persists a typed security notification to the tenant's inbox with sensitive data redacted.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Security notification created.",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post()
  async createNotification(
    @Param("orgId") organizationId: string,
    @Body() dto: CreateSecurityNotificationDto,
  ) {
    return this.notificationService.createNotification(organizationId, dto);
  }

  @ApiOperation({
    summary: "List tenant security notifications",
    description: "Returns paginated notifications visible to the authenticated member.",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get()
  async listNotifications(
    @Param("orgId") organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListSecurityNotificationsDto,
  ) {
    return this.notificationService.listNotifications(organizationId, user.id, query);
  }

  @ApiOperation({
    summary: "Get unread security notification count",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get("unread-count")
  async getUnreadCount(
    @Param("orgId") organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificationService.getUnreadCount(organizationId, user.id);
  }

  @ApiOperation({
    summary: "Get security notification detail",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get(":id")
  async getNotification(
    @Param("orgId") organizationId: string,
    @Param("id") notificationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificationService.getNotification(organizationId, notificationId, user.id);
  }

  @ApiOperation({
    summary: "Acknowledge a security notification",
    description: "Marks notification as acknowledged (idempotent). Does not resolve the underlying incident.",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(":id/acknowledge")
  async acknowledgeNotification(
    @Param("orgId") organizationId: string,
    @Param("id") notificationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificationService.acknowledgeNotification(
      organizationId,
      notificationId,
      user.id,
    );
  }

  @ApiOperation({
    summary: "Get resolution link for a security notification",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get(":id/resolve")
  async getResolutionLink(
    @Param("orgId") organizationId: string,
    @Param("id") notificationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificationService.getResolutionLink(
      organizationId,
      notificationId,
      user.id,
    );
  }
}
