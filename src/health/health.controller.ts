import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { ApiKeyScope } from "@prisma/client";
import type { Request, Response } from "express";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { RequireScopes } from "../common/decorators/require-scopes.decorator";
import {
  AuthenticatedRoute,
  PublicRoute,
} from "../common/decorators/authorization-policy.decorator";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { ScopesGuard } from "../common/guards/scopes.guard";
import { HealthResponseDto } from "./dto/health-response.dto";
import { DeploymentMetadataResponseDto } from "./dto/deployment-metadata.dto";
import {
  LivenessResponseDto,
  ReadinessResponseDto,
} from "./dto/health-probe.dto";
import { HealthService } from "./health.service";
import { DependencyStatus } from "./health.types";

/**
 * Deployment metadata only changes on redeploy, so clients may reuse it
 * briefly, but must revalidate (cheaply, via ETag) rather than trust a stale
 * copy across a deployment.
 */
export const DEPLOYMENT_METADATA_CACHE_CONTROL =
  "public, max-age=60, must-revalidate";

/**
 * If-None-Match uses weak comparison (RFC 9110 §13.1.2): a list of tags, each
 * possibly `W/`-prefixed, or `*`.
 */
function ifNoneMatchSatisfied(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  if (header === undefined) return false;
  const tags = (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""));
  return tags.includes("*") || tags.includes(etag);
}

@ApiTags("health")
@SkipThrottle({ default: true, strict: true, verification: true })
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Existing aggregate endpoint, preserved for backwards compatibility.
   *
   * Deployments, dashboards, and compose healthchecks already point at
   * `/health`, so its shape and semantics are left exactly as they were.
   * New callers should use `/health/live` and `/health/ready`, which answer
   * distinguishable questions.
   */
  @ApiOperation({
    summary: "Health check (legacy aggregate)",
    description:
      "Returns the service status and verifies database connectivity. Retained " +
      "for backwards compatibility; prefer `/health/live` and `/health/ready`, " +
      "which distinguish process availability from readiness to serve work.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Service and database are healthy.",
    type: HealthResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: "Database is unreachable.",
    type: ApiErrorDto,
  })
  @Get()
  @PublicRoute()
  async getHealth(): Promise<HealthResponseDto> {
    const readiness = await this.health.checkReadiness();
    const database = readiness.dependencies.find(
      (dependency) => dependency.name === "database",
    );

    if (!database || database.status !== DependencyStatus.OK) {
      throw new ServiceUnavailableException("Database is unreachable");
    }

    return {
      status: "ok",
      service: "earnproof-api",
      database: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Liveness probe.
   *
   * Answers only "is this process up?" and performs no external calls, so a
   * dependency outage can never cause the orchestrator to restart otherwise
   * healthy replicas — restarts cannot fix a downstream outage, and they remove
   * the capacity needed to absorb it.
   */
  @ApiOperation({
    summary: "Liveness probe",
    description:
      "Reports process availability only. Performs no database, network, or " +
      "contract calls, and never fails because a dependency is unhealthy.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Process is alive.",
    type: LivenessResponseDto,
  })
  @Get("live")
  @PublicRoute()
  getLiveness(): LivenessResponseDto {
    return this.health.checkLiveness();
  }

  /**
   * Readiness probe.
   *
   * Returns 503 when a required dependency is unhealthy so a load balancer stops
   * routing traffic here, and 200 otherwise. Optional dependencies are reported
   * but never change the status code.
   */
  @ApiOperation({
    summary: "Readiness probe",
    description:
      "Reports whether the service can accept dependent work. Required " +
      "dependencies (database, configuration) gate the verdict; optional " +
      "dependencies are excluded so an unrelated outage cannot take unrelated " +
      "routes offline. Probes are timeout-bounded and cached.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "All required dependencies are healthy.",
    type: ReadinessResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: "A required dependency is unhealthy.",
    type: ReadinessResponseDto,
  })
  @Get("ready")
  @PublicRoute()
  async getReadiness(): Promise<ReadinessResponseDto> {
    const result = await this.health.checkReadiness();

    if (result.status === "not_ready") {
      // The body is the readiness result itself, not an error envelope: an
      // operator needs to see WHICH dependency blocked readiness.
      throw new ServiceUnavailableException(result);
    }

    return result;
  }

  /**
   * Public deployment metadata.
   *
   * Unauthenticated by design: clients need the network passphrase and
   * contract addresses before they can do anything else, and nothing here is
   * secret — the document is built by allow-list from a validated manifest.
   */
  @ApiOperation({
    summary: "Deployment and contract network metadata",
    description:
      "Returns the versioned deployment metadata document (network, contract " +
      "addresses, deployment version, artifact hashes) loaded from the " +
      "validated deployment manifest, with an integrity digest. To verify: " +
      "canonicalize `document` by sorting object keys recursively and " +
      "serializing with compact JSON.stringify (UTF-8), compute its SHA-256, " +
      "and compare the lowercase hex with `integrity.digest`. The digest is " +
      "also the ETag; send it as If-None-Match to revalidate. Answers 503 " +
      "when the manifest is absent, malformed, incomplete, or inconsistent " +
      "with the runtime network configuration; the stable reason codes are " +
      "reported by the `deployment_manifest` dependency of `/health/ready`.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Validated deployment metadata.",
    type: DeploymentMetadataResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_MODIFIED,
    description: "The If-None-Match ETag matches the current document.",
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: "No valid deployment manifest is configured.",
    type: ApiErrorDto,
  })
  @Get("deployment")
  getDeploymentMetadata(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): DeploymentMetadataResponseDto | undefined {
    const state = this.health.deploymentMetadata();

    if (state.status !== "valid") {
      // The global filter maps any 503 onto the standard error envelope; the
      // reason codes are published through readiness, not repeated here.
      throw new ServiceUnavailableException(
        "Deployment metadata is unavailable",
      );
    }

    const etag = `"${state.envelope.integrity.digest}"`;
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", DEPLOYMENT_METADATA_CACHE_CONTROL);

    if (ifNoneMatchSatisfied(request.headers["if-none-match"], etag)) {
      response.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }

    return state.envelope;
  }

  /**
   * Detailed dependency diagnostics.
   *
   * Authorized callers only. This surface names every dependency and its state,
   * which is exactly the reconnaissance an attacker wants, so it sits behind the
   * same API-key + scope guards as other privileged routes.
   *
   * It always returns 200 when authorized: this is an inspection endpoint, and
   * making it 503 on degradation would tempt operators to point load balancers
   * at it, which would reintroduce the conflation this module removes.
   */
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Dependency diagnostics (authorized)",
    description:
      "Returns per-dependency status for required and optional dependencies. " +
      "Requires an API key with the ORG_ADMIN scope. Reasons are stable, " +
      "non-identifying codes; connection strings, credentials, and raw driver " +
      "errors are never exposed.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Diagnostics for all known dependencies.",
    type: ReadinessResponseDto,
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
  @Get("diagnostics")
  @AuthenticatedRoute({ roles: ["ORG_ADMIN"] })
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard, ScopesGuard)
  @RequireScopes(ApiKeyScope.ORG_ADMIN)
  async getDiagnostics(): Promise<ReadinessResponseDto> {
    return this.health.checkDiagnostics();
  }
}
