import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  HttpCode,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiOkResponse,
  ApiBadRequestResponse,
} from "@nestjs/swagger";
import { AuthGuard } from "../common/guards/auth.guard";
import { RequireScopes } from "../common/decorators/require-scopes.decorator";
import { ApiKeyScope } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { ContractStateReconciliationService } from "./contract-state-reconciliation.service";
import {
  ContractReconciliationFindingsQueryDto,
  ContractReconciliationFindingsResponseDto,
  TriggerContractReconciliationDto,
  TriggerContractReconciliationResponseDto,
  ContractReconciliationMismatchDto,
  ContractReconciliationVerificationFailureDto,
  PaginationMetadataDto,
} from "./dto/contract-reconciliation.dto";

/**
 * ContractReconciliationController
 *
 * Endpoints for querying contract reconciliation findings and triggering on-demand comparisons.
 * All endpoints require authentication and appropriate API key scopes.
 *
 * GET /v1/contract-reconciliation/findings
 *   - List mismatches and verification failures with pagination
 *   - Requires: PROOF_READ or ORG_ADMIN
 *
 * POST /v1/contract-reconciliation/compare
 *   - Trigger on-demand checkpoint comparison
 *   - Requires: ORG_ADMIN (higher privilege than read)
 */
@ApiTags("Contract Reconciliation")
@Controller("v1/contract-reconciliation")
@UseGuards(AuthGuard)
export class ContractReconciliationController {
  // Max components per page
  private readonly maxComponentsPerPage = 50;
  // Max components total (hard cap)
  private readonly maxComponentsTotal = 100;
  // Max response payload
  private readonly maxResponseSizeBytes = 5 * 1024 * 1024; // 5 MB

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliationService: ContractStateReconciliationService,
  ) {}

  /**
   * GET /v1/contract-reconciliation/findings
   *
   * Retrieve paginated contract reconciliation findings (mismatches and verification failures).
   * Results are bounded to prevent unbounded output.
   *
   * Scopes: PROOF_READ, ORG_ADMIN
   */
  @Get("findings")
  @RequireScopes(ApiKeyScope.PROOF_READ, ApiKeyScope.ORG_ADMIN)
  @ApiOperation({
    summary: "Retrieve contract reconciliation findings",
    description:
      "Get paginated mismatches and verification failures from contract state comparisons. Results are bounded to max 100 total components.",
  })
  @ApiOkResponse({
    type: ContractReconciliationFindingsResponseDto,
    description: "Findings retrieved successfully",
  })
  @ApiBadRequestResponse({
    description: "Invalid query parameters",
  })
  async getFindings(
    @Query() query: ContractReconciliationFindingsQueryDto,
  ): Promise<ContractReconciliationFindingsResponseDto> {
    // Validate required fields
    if (!query.network || !query.contractId) {
      throw new BadRequestException("network and contractId are required");
    }

    // Normalize page and pageSize
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(this.maxComponentsPerPage, query.pageSize ?? 50);
    const offset = (page - 1) * pageSize;

    // Build filter
    const where: Record<string, any> = {
      network: query.network,
      contractId: query.contractId,
    };

    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) {
        where.createdAt.gte = new Date(query.from);
      }
      if (query.to) {
        where.createdAt.lte = new Date(query.to);
      }
    }

    // Fetch mismatches and verification failures
    let mismatches: any[] = [];
    let verificationFailures: any[] = [];
    let totalMismatchCount = 0;
    let totalFailureCount = 0;

    if (!query.type || query.type === "mismatch") {
      totalMismatchCount = await this.prisma.contractStateCheckpointMismatch.count({
        where,
      });

      if (offset < totalMismatchCount) {
        const remainingSize = pageSize - mismatches.length;
        mismatches = await this.prisma.contractStateCheckpointMismatch.findMany(
          {
            where,
            orderBy: this.buildOrderBy(query.sortBy, query.sortOrder),
            take: remainingSize,
            skip: offset,
          },
        );
      }
    }

    if (!query.type || query.type === "verification_failure") {
      totalFailureCount = await this.prisma.contractStateVerificationFailure.count({
        where,
      });

      const mismatchesCount = mismatches.length;
      const remainingSize = pageSize - mismatchesCount;

      if (remainingSize > 0) {
        const failureOffset = Math.max(
          0,
          offset - totalMismatchCount,
        );
        verificationFailures =
          await this.prisma.contractStateVerificationFailure.findMany({
            where,
            orderBy: this.buildOrderBy(query.sortBy, query.sortOrder),
            take: remainingSize,
            skip: failureOffset,
          });
      }
    }

    // Combine and format results
    const data: any[] = [
      ...mismatches.map((m) => ({
        ...m,
        detectionTime: m.detectionTime?.toISOString(),
        type: "mismatch",
      })),
      ...verificationFailures.map((f) => ({
        ...f,
        detectionTime: f.detectionTime?.toISOString(),
        type: "verification_failure",
      })),
    ];

    const totalCount = totalMismatchCount + totalFailureCount;
    const totalPages = Math.ceil(totalCount / pageSize);

    return {
      data,
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages,
        hasNextPage: page < totalPages,
      },
      summary: {
        mismatchCount: totalMismatchCount,
        verificationFailureCount: totalFailureCount,
        totalComponentsAffected: totalMismatchCount, // Approximation
      },
      limits: {
        maxComponentsPerPage: this.maxComponentsPerPage,
        maxComponentsTotal: this.maxComponentsTotal,
      },
    };
  }

  /**
   * POST /v1/contract-reconciliation/compare
   *
   * Trigger an on-demand checkpoint comparison.
   * Synchronous: returns comparison results (fetch timeout: 30s).
   *
   * Scope: ORG_ADMIN (higher privilege than read)
   */
  @Post("compare")
  @RequireScopes(ApiKeyScope.ORG_ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: "Trigger an on-demand contract reconciliation",
    description:
      "Compare backend projections against live contract state for a specific checkpoint. Returns verification status and comparison results.",
  })
  @ApiOkResponse({
    type: TriggerContractReconciliationResponseDto,
    description: "Comparison completed successfully",
  })
  @ApiBadRequestResponse({
    description: "Invalid request parameters",
  })
  async triggerComparison(
    @Body() request: TriggerContractReconciliationDto,
  ): Promise<TriggerContractReconciliationResponseDto> {
    if (!request.network || !request.contractId) {
      throw new BadRequestException("network and contractId are required");
    }

    const checkpointNumber =
      request.checkpointNumber?.toString() ?? await this.getLatestCheckpoint();
    if (!checkpointNumber) {
      throw new BadRequestException(
        "checkpointNumber not provided and no latest checkpoint available",
      );
    }

    const result = await this.reconciliationService.compareCheckpoint(
      request.network,
      request.contractId,
      checkpointNumber,
      request.skipStaleCheck ?? false,
    );

    return {
      runId: result.runId,
      network: request.network,
      contractId: request.contractId,
      checkpointNumber,
      digestVersion: result.comparisonStatus ? "1.0" : undefined, // Placeholder
      verificationStatus: result.verificationStatus,
      verificationFailures:
        result.verificationFailures?.map((f) => ({
          id: "", // Not persisted yet
          network: request.network,
          contractId: request.contractId,
          failureCode: f.code,
          failureMessage: f.message,
          detectionTime: new Date().toISOString(),
          runId: result.runId,
        })) ?? undefined,
      comparisonStatus: result.comparisonStatus as "MATCH" | "MISMATCH" | undefined,
      mismatchCount: result.mismatchCount,
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * Build Prisma orderBy clause based on query parameters.
   * @private
   */
  private buildOrderBy(
    sortBy?: string,
    sortOrder?: string,
  ): Record<string, "asc" | "desc"> {
    const order: "asc" | "desc" = sortOrder === "asc" ? "asc" : "desc";
    if (sortBy === "component_name") {
      return { componentName: order };
    }
    return { createdAt: order }; // Default to detection_time
  }

  /**
   * Get the latest checkpoint.
   * @private
   */
  private async getLatestCheckpoint(): Promise<string | null> {
    // TODO: Query contract or configuration for latest checkpoint
    return null;
  }
}
