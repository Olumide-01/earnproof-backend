import { Controller, Get, HttpStatus, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import {
  MetricRollupResponseDto,
  MetricRollupStatusDto,
  QueryMetricRollupsDto,
} from "./dto/metric-rollup.dto";
import { MetricRollupService } from "./metric-rollup.service";

/**
 * Operator read access to downsampled operational metrics (#330).
 *
 * Admin only. Aggregates carry bounded label sets and numbers, but capacity
 * and error-rate history is still operational intelligence.
 */
@ApiBearerAuth()
@ApiTags("metrics")
@AuthenticatedRoute({ roles: ["ADMIN"] })
@UseGuards(AuthGuard, RoleGuard)
@ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ApiErrorDto })
@ApiResponse({ status: HttpStatus.FORBIDDEN, description: "Admin role required.", type: ApiErrorDto })
@Controller("metrics/rollups")
export class MetricsRollupController {
  constructor(private readonly rollups: MetricRollupService) {}

  @ApiOperation({
    summary: "Read minute, hour or day aggregates for one metric (admin only)",
    description:
      "Returns sealed aggregates whose bucket start lies in [from, to), grouped by label set. " +
      "Buckets with no activity are absent rather than zero.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: MetricRollupResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Unknown tier or metric, inverted range, or range too large for the tier.",
    type: ApiErrorDto,
  })
  @RequiredRole("ADMIN")
  @Get()
  query(@Query() query: QueryMetricRollupsDto) {
    return this.rollups.query({
      tier: query.tier,
      metric: query.metric,
      fromMs: Date.parse(query.from),
      toMs: Date.parse(query.to),
    });
  }

  @ApiOperation({ summary: "Collector and rollup progress (admin only)" })
  @ApiResponse({ status: HttpStatus.OK, type: MetricRollupStatusDto })
  @RequiredRole("ADMIN")
  @Get("status")
  status() {
    return this.rollups.status();
  }
}
