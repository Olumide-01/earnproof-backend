import {
  Controller,
  Get,
  Post,
  HttpCode,
  HttpStatus,
  Param,
  Body,
  UseGuards,
  Req,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { ApiKeyScope } from "@prisma/client";
import type { Request } from "express";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { RequireScopes } from "../common/decorators/require-scopes.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { ScopesGuard } from "../common/guards/scopes.guard";
import { ContractSuccessorService } from "./contract-successor.service";
import {
  AssessSuccessorReadinessResponse,
  AcknowledgeSuccessorFindingRequest,
  AcknowledgeSuccessorFindingResponse,
} from "./contracts.dto";
import { ContractIdentity } from "./contracts.types";

/**
 * Contracts Controller
 *
 * Provides endpoints for contract successor migration readiness assessment
 * and management. Requires ORG_ADMIN scope for all operations.
 */
@ApiTags("contracts")
@ApiBearerAuth()
@Controller("contracts/:network/:contractId")
export class ContractsController {
  constructor(private readonly contractSuccessor: ContractSuccessorService) {}

  /**
   * Assess contract successor migration readiness.
   *
   * Returns a deterministic readiness verdict with blocking findings and
   * live contract identity verification. The assessment is cached for 5 seconds
   * and is considered stale after 60 seconds.
   *
   * @param network - The network (e.g., "testnet", "mainnet")
   * @param contractId - The successor contract ID
   * @returns Readiness assessment with findings and verdict
   */
  @ApiOperation({
    summary: "Assess contract successor migration readiness",
    description:
      "Returns a coordinated view of compatibility, pause state, migrations, checkpoints, " +
      "and dependent services. The assessment is deterministic, immutable once computed, " +
      "and blocks migration if any finding cannot be individually acknowledged.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Readiness assessment completed.",
    type: AssessSuccessorReadinessResponse,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Missing or invalid API key.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "API key lacks the ORG_ADMIN scope.",
    type: ApiErrorDto,
  })
  @Get("successor/readiness")
  @AuthenticatedRoute({ roles: ["ORG_ADMIN"] })
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard, ScopesGuard)
  @RequireScopes(ApiKeyScope.ORG_ADMIN)
  async assessReadiness(
    @Param("network") network: string,
    @Param("contractId") contractId: string,
    @Req() request: Request,
  ): Promise<AssessSuccessorReadinessResponse> {
    const successor: ContractIdentity = {
      network,
      contractId,
      expectedVersion: this.getExpectedVersion(request),
    };

    const assessment = await this.contractSuccessor.assessReadiness(successor);
    return assessment as AssessSuccessorReadinessResponse;
  }

  /**
   * Acknowledge a contract successor readiness finding.
   *
   * Acknowledgements are stored with bounded TTL (max 7 days). An acknowledged
   * blocking finding allows migration to proceed, but only until the
   * acknowledgement expires or is withdrawn.
   *
   * @param network - The network
   * @param contractId - The successor contract ID
   * @param findingKey - The finding key to acknowledge
   * @param input - Acknowledgement details (note, TTL)
   * @returns Acknowledgement details (when it expires, who acknowledged it)
   */
  @ApiOperation({
    summary: "Acknowledge a successor readiness finding",
    description:
      "Records an operator acknowledgement for a readiness finding. " +
      "Acknowledgements are stored with bounded TTL (max 7 days). " +
      "Blocking findings remain blocking until acknowledged or resolved.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Acknowledgement recorded.",
    type: AcknowledgeSuccessorFindingResponse,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Invalid TTL or acknowledgement details.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Missing or invalid API key.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "API key lacks the ORG_ADMIN scope.",
    type: ApiErrorDto,
  })
  @Post("successor/findings/:findingKey/acknowledge")
  @AuthenticatedRoute({ roles: ["ORG_ADMIN"] })
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard, ScopesGuard)
  @RequireScopes(ApiKeyScope.ORG_ADMIN)
  async acknowledgeFinding(
    @Param("network") network: string,
    @Param("contractId") contractId: string,
    @Param("findingKey") findingKey: string,
    @Body() input: AcknowledgeSuccessorFindingRequest,
    @Req() request: Request,
  ): Promise<AcknowledgeSuccessorFindingResponse> {
    const successor: ContractIdentity = {
      network,
      contractId,
      expectedVersion: this.getExpectedVersion(request),
    };

    const actorId = this.getActorId(request);

    try {
      await this.contractSuccessor.acknowledgeFinding(successor, {
        findingKey,
        acknowledgedBy: actorId,
        note: input.note,
        ttlSeconds: input.ttlSeconds,
      });

      const expiresAt = new Date(
        Date.now() + input.ttlSeconds * 1000,
      ).toISOString();

      return {
        findingKey,
        acknowledgedAt: new Date().toISOString(),
        expiresAt,
        acknowledgedBy: actorId,
      };
    } catch (error) {
      throw new Error(
        `Failed to acknowledge finding: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Check if contract successor can migrate.
   *
   * Returns a boolean indicating whether all readiness checks pass and
   * all blocking findings are acknowledged.
   *
   * @param network - The network
   * @param contractId - The successor contract ID
   * @returns Boolean indicating readiness for migration
   */
  @ApiOperation({
    summary: "Check if contract successor can migrate",
    description:
      "Returns true if migration can proceed (all blocking findings acknowledged " +
      "or absent, live contract identity verified, pause state compatible). " +
      "Returns false otherwise.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Migration readiness check completed.",
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Missing or invalid API key.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "API key lacks the ORG_ADMIN scope.",
    type: ApiErrorDto,
  })
  @Get("successor/can-migrate")
  @AuthenticatedRoute({ roles: ["ORG_ADMIN"] })
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard, ScopesGuard)
  @RequireScopes(ApiKeyScope.ORG_ADMIN)
  async canMigrate(
    @Param("network") network: string,
    @Param("contractId") contractId: string,
    @Req() request: Request,
  ): Promise<{ canMigrate: boolean }> {
    const successor: ContractIdentity = {
      network,
      contractId,
      expectedVersion: this.getExpectedVersion(request),
    };

    const canMigrate = await this.contractSuccessor.canMigrate(successor);
    return { canMigrate };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Extract expected version from request context or config.
   * In a full implementation, this would come from the authenticated request context
   * or be queried from the database based on network.
   */
  private getExpectedVersion(request: Request): number {
    // For now, return a default value. In production, this would be:
    // 1. Looked up from request context (if injected)
    // 2. Queried from database for the network
    // 3. Read from configuration
    return 1;
  }

  /**
   * Extract actor ID from authenticated request.
   * Uses the API key's associated user ID or actor identifier.
   */
  private getActorId(request: Request): string {
    // In production, this would come from:
    // - The decoded API key's user/org association
    // - The authenticated principal from the request context
    // For now, return a placeholder
    return request.headers["x-actor-id"] as string || "system";
  }
}
