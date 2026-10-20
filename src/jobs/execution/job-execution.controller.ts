import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { ApiKeyScope, JobExecutionOutcome } from "@prisma/client";
import { ApiErrorDto } from "../../common/dto/api-error.dto";
import { RequireScopes } from "../../common/decorators/require-scopes.decorator";
import { ApiKeyGuard } from "../../common/guards/api-key.guard";
import { ScopesGuard } from "../../common/guards/scopes.guard";
import { JobExecutionService } from "./job-execution.service";

/**
 * Read-only operator view of recent background job executions.
 *
 * Authorized callers only. Like the health diagnostics endpoint, this names
 * internal job machinery and is exactly the reconnaissance an attacker wants, so
 * it sits behind the same API-key + ORG_ADMIN scope guards rather than inventing
 * a second authorization path. The rows carry no job payload — only identity,
 * timing, outcome, and a bounded error category.
 */
@ApiTags("jobs")
@ApiBearerAuth()
@SkipThrottle({ default: true, strict: true, verification: true })
@Controller("jobs/executions")
@UseGuards(ApiKeyGuard, ScopesGuard)
@RequireScopes(ApiKeyScope.ORG_ADMIN)
export class JobExecutionController {
  constructor(private readonly executions: JobExecutionService) {}

  @ApiOperation({
    summary: "List recent background job executions (authorized)",
    description:
      "Returns recent execution records for scheduled jobs, newest first. " +
      "Requires an API key with the ORG_ADMIN scope. Results are bounded; " +
      "records contain no job payloads or secrets, only a bounded error " +
      "category.",
  })
  @ApiQuery({ name: "jobName", required: false })
  @ApiQuery({ name: "outcome", required: false, enum: JobExecutionOutcome })
  @ApiQuery({ name: "onlyRunning", required: false, type: Boolean })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiResponse({ status: 200, description: "Recent executions." })
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
  @Get()
  async list(
    @Query("jobName") jobName?: string,
    @Query("outcome") outcome?: string,
    @Query("onlyRunning") onlyRunning?: string,
    @Query("limit") limit?: string,
  ) {
    const items = await this.executions.listRecent({
      jobName: jobName || undefined,
      outcome: this.parseOutcome(outcome),
      onlyRunning: onlyRunning === "true",
      limit: this.parseLimit(limit),
    });

    return { items };
  }

  private parseOutcome(value?: string): JobExecutionOutcome | undefined {
    if (!value) return undefined;
    if (!(value in JobExecutionOutcome)) {
      throw new BadRequestException(`Unknown outcome: ${value}`);
    }
    return value as JobExecutionOutcome;
  }

  private parseLimit(value?: string): number | undefined {
    if (value === undefined || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException("limit must be a positive integer");
    }
    return parsed;
  }
}
