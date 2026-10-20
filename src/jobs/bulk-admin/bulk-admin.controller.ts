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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "../../common/guards/auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../auth/auth.types";
import { BulkAdminService } from "./bulk-admin.service";
import { CreateBulkAdminJobDto } from "./dto/bulk-admin.dto";

@ApiTags("bulk-admin")
@Controller("organizations/:orgId/bulk-jobs")
export class BulkAdminController {
  constructor(private readonly bulkAdminService: BulkAdminService) {}

  @ApiOperation({
    summary: "Submit a bounded bulk administration job",
    description: "Enqueues a bulk administration job with idempotency and item-level authorization.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Job created or returned idempotently.",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post()
  async createJob(
    @Param("orgId") organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBulkAdminJobDto,
  ) {
    return this.bulkAdminService.createJob(organizationId, user.id, dto);
  }

  @ApiOperation({
    summary: "Execute or resume a bulk administration job",
    description: "Executes pending items under a distributed lease.",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(":id/execute")
  async executeJob(
    @Param("orgId") organizationId: string,
    @Param("id") jobId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bulkAdminService.executeJob(jobId, user.id);
  }

  @ApiOperation({
    summary: "Get bulk administration job status and item outcomes",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get(":id")
  async getJob(
    @Param("orgId") organizationId: string,
    @Param("id") jobId: string,
  ) {
    return this.bulkAdminService.getJob(organizationId, jobId);
  }

  @ApiOperation({
    summary: "Cancel a bulk administration job",
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(":id/cancel")
  async cancelJob(
    @Param("orgId") organizationId: string,
    @Param("id") jobId: string,
  ) {
    return this.bulkAdminService.cancelJob(organizationId, jobId);
  }
}
