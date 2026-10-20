import { Controller, Get, Optional, Param, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { AuditAdminService } from "./audit-admin.service";
import { AuditVerificationService } from "./audit-verification.service";
import { AuditGraphService } from "./audit-graph.service";
import { ExportAuditLogsDto } from "./dto/export-audit-logs.dto";
import { ListAuditLogsDto } from "./dto/list-audit-logs.dto";
import { VerifyAuditChainParamsDto } from "./dto/verify-audit-chain.dto";
import { AuditGraphQueryDto, AuditGraphResponseDto } from "./dto/audit-graph.dto";

/**
 * Administrator retrieval path for tamper-evident AuditLog records.
 *
 * Every endpoint here requires the ADMIN role (platform-wide role, not a
 * per-organization membership -- this codebase has no org-staff membership
 * table) and requires an explicit `organizationId`. Org scoping is enforced
 * by that required filter, not by matching the admin's own organization.
 */
@ApiBearerAuth()
@ApiTags("admin-audit-logs")
@Controller("admin/audit-logs")
export class AuditAdminController {
  constructor(
    private readonly auditAdminService: AuditAdminService,
    private readonly auditVerificationService: AuditVerificationService,
    @Optional()
    private readonly auditGraphService?: AuditGraphService,
  ) {}

  @Get()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "List audit log records",
    description:
      "Cursor-paginated, filtered administrator query. organizationId is required.",
  })
  @ApiResponse({ status: 200, description: "Audit log records retrieved" })
  @ApiResponse({ status: 403, description: "Unauthorized - admin role required" })
  list(@Query() query: ListAuditLogsDto) {
    return this.auditAdminService.list(query);
  }

  @Get("export")
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Export audit log records",
    description:
      "Bounded JSON export scoped to one organization and a date range no " +
      "wider than MAX_EXPORT_RANGE_DAYS, with a hard MAX_EXPORT_RECORDS " +
      "safety cap (truncated: true when the cap was hit).",
  })
  @ApiResponse({ status: 200, description: "Audit log export produced" })
  @ApiResponse({ status: 400, description: "Date range missing or too wide" })
  @ApiResponse({ status: 403, description: "Unauthorized - admin role required" })
  export(@Query() query: ExportAuditLogsDto) {
    return this.auditAdminService.export(query);
  }

  @Get("graph")
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Query causal and correlation audit graph",
    description:
      "Bounded graph traversal across parent and correlation references within a tenant organization. " +
      "Enforces depth limits, cycle detection, tenant boundaries, and metadata redaction.",
  })
  @ApiResponse({ status: 200, description: "Audit correlation graph returned", type: AuditGraphResponseDto })
  @ApiResponse({ status: 403, description: "Unauthorized - admin role required" })
  getGraph(@Query() query: AuditGraphQueryDto) {
    if (!this.auditGraphService) {
      throw new Error("AuditGraphService is not configured");
    }
    return this.auditGraphService.buildCorrelationGraph(query);
  }

  @Get(":organizationId/verify")
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Verify an organization's audit log hash chain",
    description:
      "Walks the chain in sequence order and reports the first broken " +
      "link, if any, distinguishing tamper findings from a legitimate " +
      "retention truncation boundary.",
  })
  @ApiResponse({ status: 200, description: "Verification result" })
  @ApiResponse({ status: 403, description: "Unauthorized - admin role required" })
  verify(@Param() params: VerifyAuditChainParamsDto) {
    return this.auditVerificationService.verifyChain(params.organizationId);
  }
}
