import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { ApiKeyScope } from "@prisma/client";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { RequireScopes } from "../common/decorators/require-scopes.decorator";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { ScopesGuard } from "../common/guards/scopes.guard";
import { METRIC_NAMES } from "../common/observability/metrics.catalog";
import { MetricsRegistry } from "../common/observability/metrics.registry";

/**
 * Read-only operator view of revocation-propagation health (#212).
 *
 * Like the job-execution and health-diagnostics endpoints, this sits behind
 * the same API-key + ORG_ADMIN scope guards rather than inventing a second
 * authorization path. The response carries only the two revocation
 * propagation metric series (bounded `channel`/`propagation_state` labels and
 * a lag histogram) — no proof identifiers, no payloads, nothing that singles
 * out a specific revocation.
 */
@ApiTags("jobs")
@ApiBearerAuth()
@SkipThrottle({ default: true, strict: true, verification: true })
@Controller("jobs/revocation-propagation")
@UseGuards(ApiKeyGuard, ScopesGuard)
@RequireScopes(ApiKeyScope.ORG_ADMIN)
export class RevocationPropagationController {
  constructor(private readonly metrics: MetricsRegistry) {}

  @ApiOperation({
    summary: "Revocation propagation health (authorized)",
    description:
      "Aggregate counts and lag for revocation propagation across the " +
      "anchoring and webhook channels, by channel and observed state. " +
      "Requires an API key with the ORG_ADMIN scope. Carries no proof " +
      "identifiers or payloads — counts and durations only.",
  })
  @ApiResponse({ status: 200, description: "Current revocation propagation metrics." })
  @ApiResponse({
    status: 401,
    description: "Missing or invalid API key.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 403,
    description: "API key lacks the ORG_ADMIN scope.",
    type: ApiErrorDto,
  })
  @Get("health")
  getHealth() {
    const names: string[] = [
      METRIC_NAMES.revocationPropagationChecksTotal,
      METRIC_NAMES.revocationPropagationLagSeconds,
    ];
    const metrics = this.metrics
      .snapshot()
      .filter((metric) => names.includes(metric.name));

    return { metrics };
  }
}
