import { Body, Controller, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { PublicRoute } from "../common/decorators/authorization-policy.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { CspViolationService } from "./csp-violation.service";
import { ReportCspViolationDto } from "./dto/report-csp-violation.dto";

/**
 * Privacy-safe CSP violation report ingestion (#336).
 *
 * Unauthenticated by necessity — a browser reporting its own page's CSP
 * violations has no session or API key. Responds 204 unconditionally for
 * any validly-shaped report, whether or not it was actually counted (sampled
 * out by CspViolationAbuseService, or a storage failure the service itself
 * fails open on): the response can never be used to infer whether a report
 * was retained, which bucket it landed in, or the bucket's current count.
 */
@ApiTags("security")
@Controller("security/csp-reports")
export class CspViolationController {
  constructor(private readonly violations: CspViolationService) {}

  @ApiOperation({
    summary: "Report a CSP violation (privacy-safe, aggregated)",
    description:
      "Accepts a bounded, already-redacted CSP violation summary — directive, " +
      "route category, release, and disposition only. Never accepts a " +
      "document/blocked URI, DOM data, or free-form user input; unknown " +
      "properties are rejected, not stored. Always responds 204 regardless of " +
      "whether the report was counted, so the response cannot be used to probe " +
      "sampling or storage state.",
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: "Accepted. The report may or may not have been counted.",
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "Request body failed validation.",
    type: ApiErrorDto,
  })
  @Post()
  @PublicRoute()
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(
    @Body() body: ReportCspViolationDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.violations.ingest(body, { ip: request.ip });
  }
}
