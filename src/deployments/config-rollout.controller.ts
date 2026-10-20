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
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { ConfigRolloutService } from "./config-rollout.service";
import {
  CohortQueryDto,
  CompareConfigSnapshotsQueryDto,
  CreateConfigRolloutDto,
  ImportConfigSnapshotDto,
  PromoteConfigRolloutDto,
  RecordGateDto,
  RollbackConfigRolloutDto,
} from "./dto/config-rollout.dto";

/**
 * Configuration snapshots, environment comparison and canary rollouts (#329).
 * Admin only: snapshots exclude secrets, but the rest of the configuration
 * still describes the deployment's topology.
 */
@ApiBearerAuth()
@ApiTags("Deployments & Maintenance")
@AuthenticatedRoute({ roles: ["ADMIN"] })
@UseGuards(AuthGuard, RoleGuard)
@ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ApiErrorDto })
@ApiResponse({ status: HttpStatus.FORBIDDEN, description: "Admin role required.", type: ApiErrorDto })
@Controller("deployments/config")
export class ConfigRolloutController {
  constructor(private readonly rollouts: ConfigRolloutService) {}

  @ApiOperation({
    summary: "Capture this environment's configuration as a signed snapshot",
    description:
      "Secrets are excluded by key name and by value shape; excluded paths are listed without values. " +
      "Capturing unchanged configuration returns the existing snapshot.",
  })
  @ApiResponse({ status: HttpStatus.CREATED })
  @ApiResponse({ status: HttpStatus.SERVICE_UNAVAILABLE, description: "No signing key.", type: ApiErrorDto })
  @RequiredRole("ADMIN")
  @Post("snapshots")
  capture(@CurrentUser() user: AuthenticatedUser) {
    return this.rollouts.captureSnapshot(user);
  }

  @ApiOperation({ summary: "Import a signed snapshot exported from another environment" })
  @ApiResponse({ status: HttpStatus.CREATED })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Malformed, altered, foreign-signed, or secret-bearing document.",
    type: ApiErrorDto,
  })
  @RequiredRole("ADMIN")
  @Post("snapshots/import")
  import(@CurrentUser() user: AuthenticatedUser, @Body() body: ImportConfigSnapshotDto) {
    return this.rollouts.importSnapshot(user, body.document);
  }

  @ApiOperation({ summary: "Semantic diff between two snapshots" })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, type: ApiErrorDto })
  @RequiredRole("ADMIN")
  @Get("snapshots/compare")
  compare(@Query() query: CompareConfigSnapshotsQueryDto) {
    return this.rollouts.compare(query.base, query.target);
  }

  @ApiOperation({ summary: "Read a snapshot and re-verify its signature" })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, type: ApiErrorDto })
  @RequiredRole("ADMIN")
  @Get("snapshots/:id")
  getSnapshot(@Param("id") id: string) {
    return this.rollouts.getSnapshot(id);
  }

  @ApiOperation({ summary: "Start a canary rollout of a snapshot into an environment" })
  @ApiResponse({ status: HttpStatus.CREATED })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: "Invalid stages.", type: ApiErrorDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Environment has an open rollout.", type: ApiErrorDto })
  @RequiredRole("ADMIN")
  @Post("rollouts")
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateConfigRolloutDto) {
    return this.rollouts.createRollout(user, body);
  }

  @ApiOperation({ summary: "Read a rollout and its decision history" })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, type: ApiErrorDto })
  @RequiredRole("ADMIN")
  @Get("rollouts/:id")
  get(@Param("id") id: string) {
    return this.rollouts.getRollout(id);
  }

  @ApiOperation({
    summary: "Submit health gate evidence for the current stage",
    description:
      "Evidence must be observed during the current stage and be fresh. A failing gate blocks the rollout.",
  })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Stale version or stage, or not in canary.", type: ApiErrorDto })
  @RequiredRole("ADMIN")
  @HttpCode(HttpStatus.OK)
  @Post("rollouts/:id/gates")
  gate(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() body: RecordGateDto) {
    return this.rollouts.recordGate(user, id, {
      expectedVersion: body.expectedVersion,
      stageIndex: body.stageIndex,
      checks: body.checks.map((check) => ({
        name: check.name,
        passed: check.passed,
        observedAtMs: Date.parse(check.observedAt),
      })),
    });
  }

  @ApiOperation({ summary: "Promote the current stage (requires a fresh passing gate)" })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "No passing gate, gate expired, or stale version.", type: ApiErrorDto })
  @RequiredRole("ADMIN")
  @HttpCode(HttpStatus.OK)
  @Post("rollouts/:id/promote")
  promote(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() body: PromoteConfigRolloutDto) {
    return this.rollouts.promote(user, id, body.expectedVersion);
  }

  @ApiOperation({ summary: "Roll back an open rollout, recording the evidence" })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: "Rollout is not open, or stale version.", type: ApiErrorDto })
  @RequiredRole("ADMIN")
  @HttpCode(HttpStatus.OK)
  @Post("rollouts/:id/rollback")
  rollback(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() body: RollbackConfigRolloutDto) {
    return this.rollouts.rollback(user, id, body);
  }

  @ApiOperation({ summary: "Which snapshot an instance should run under this rollout" })
  @ApiParam({ name: "id" })
  @ApiResponse({ status: HttpStatus.OK })
  @RequiredRole("ADMIN")
  @Get("rollouts/:id/cohort")
  cohort(@Param("id") id: string, @Query() query: CohortQueryDto) {
    return this.rollouts.cohort(id, query.instanceId);
  }
}
