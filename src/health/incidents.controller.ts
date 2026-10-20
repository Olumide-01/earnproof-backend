import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiParam,
} from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { ApiKeyScope } from "@prisma/client";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { RequireScopes } from "../common/decorators/require-scopes.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { ScopesGuard } from "../common/guards/scopes.guard";
import { HealthIncidentService } from "./health-incident.service";
import {
  HealthIncidentDto,
  HealthIncidentsListResponse,
  AcknowledgeIncidentRequest,
  CloseIncidentRequest,
} from "./dto/health-incident.dto";
import { HealthIncidentStatus } from "@prisma/client";

/**
 * Incidents controller for dependency health incident management.
 *
 * Requires ORG_ADMIN authorization. Provides endpoints to:
 * - List incidents (with optional status filter)
 * - Get a single incident by dependency name
 * - Acknowledge an unhealthy incident
 * - Close an incident (admin override)
 *
 * All incident data is redacted: no raw errors, credentials, or diagnostics.
 * Only stable, bounded reason codes and timestamps are exposed.
 */
@ApiTags("health/incidents")
@ApiBearerAuth()
@AuthenticatedRoute({ roles: ["ORG_ADMIN"] })
@UseGuards(ApiKeyGuard, ScopesGuard)
@RequireScopes(ApiKeyScope.ORG_ADMIN)
@SkipThrottle({ default: true, strict: true })
@Controller("health/incidents")
export class IncidentsController {
  constructor(
    private readonly incidentService: HealthIncidentService,
  ) {}

  /**
   * List all incidents with optional status filter.
   *
   * @query status Optional filter: HEALTHY, UNHEALTHY, ACKNOWLEDGED, RECOVERED
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "List health incidents",
    description:
      "Returns all dependency health incidents with optional status filtering. " +
      "Requires ORG_ADMIN scope. Diagnostics are redacted: only stable reason codes " +
      "and state machine info are exposed.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "List of incidents.",
    type: HealthIncidentsListResponse,
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
  async listIncidents(): Promise<HealthIncidentsListResponse> {
    const incidents = await this.incidentService.listIncidents();
    return {
      incidents: incidents.map(this.toDto),
      count: incidents.length,
    };
  }

  /**
   * Get a single incident by dependency name.
   *
   * @param dependencyName The dependency name (e.g., "database", "horizon")
   */
  @Get(":dependencyName")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Get incident by dependency name",
    description:
      "Returns the incident state and timeline for a specific dependency. " +
      "Requires ORG_ADMIN scope.",
  })
  @ApiParam({
    name: "dependencyName",
    description: "Dependency name (e.g., database, horizon)",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Incident details and timeline.",
    type: HealthIncidentDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Incident not found for this dependency.",
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
  async getIncident(
    @Param("dependencyName") dependencyName: string,
  ): Promise<HealthIncidentDto> {
    if (!dependencyName || dependencyName.trim().length === 0) {
      throw new BadRequestException("Dependency name is required");
    }

    const incident = await this.incidentService.getIncident(dependencyName);

    if (!incident) {
      throw new NotFoundException(
        `No incident found for dependency: ${dependencyName}`,
      );
    }

    return this.toDto(incident);
  }

  /**
   * Acknowledge an unhealthy incident.
   *
   * Transitions the incident from UNHEALTHY to ACKNOWLEDGED state.
   * Suppresses alerts for a configured time window.
   *
   * @param dependencyName The dependency name
   * @param request Acknowledgement details (note, ttlMs)
   */
  @Post(":dependencyName/acknowledge")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Acknowledge an incident",
    description:
      "Acknowledge an unhealthy incident to suppress alerts for a time window. " +
      "Transitions state to ACKNOWLEDGED. Requires ORG_ADMIN scope.",
  })
  @ApiParam({
    name: "dependencyName",
    description: "Dependency name (e.g., database, horizon)",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Incident acknowledged.",
    type: HealthIncidentDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Invalid request (missing note or ttlMs out of bounds).",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Incident not found or not in UNHEALTHY state.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Incident is not in UNHEALTHY state.",
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
  async acknowledgeIncident(
    @Param("dependencyName") dependencyName: string,
    @Body() request: AcknowledgeIncidentRequest,
  ): Promise<HealthIncidentDto> {
    if (!dependencyName || dependencyName.trim().length === 0) {
      throw new BadRequestException("Dependency name is required");
    }

    if (!request.note || request.note.trim().length === 0) {
      throw new BadRequestException("Acknowledgement note is required");
    }

    if (!request.ttlMs || request.ttlMs < 300_000) {
      throw new BadRequestException(
        "ttlMs must be at least 300000 (5 minutes)",
      );
    }

    if (request.ttlMs > 86_400_000) {
      throw new BadRequestException(
        "ttlMs must be at most 86400000 (24 hours)",
      );
    }

    try {
      const expiresAt = new Date(Date.now() + request.ttlMs);
      const updated = await this.incidentService.acknowledgeIncident(
        dependencyName,
        "system", // In a full implementation, would use ActorContext.userId
        request.note,
        expiresAt,
      );
      return this.toDto(updated);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("not in UNHEALTHY state")
      ) {
        throw new ForbiddenException(
          "Can only acknowledge incidents in UNHEALTHY state",
        );
      }
      if (error instanceof Error && error.message.includes("not found")) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  /**
   * Close an incident (admin override).
   *
   * Transitions the incident to RECOVERED state, closing it immediately.
   * Used for manual incident resolution when automatic recovery cannot proceed.
   *
   * @param dependencyName The dependency name
   * @param request Optional close note
   */
  @Post(":dependencyName/close")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Close an incident (admin override)",
    description:
      "Close an incident immediately, transitioning it to RECOVERED state. " +
      "Admin action for manual intervention. Requires ORG_ADMIN scope.",
  })
  @ApiParam({
    name: "dependencyName",
    description: "Dependency name (e.g., database, horizon)",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Incident closed.",
    type: HealthIncidentDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Invalid dependency name.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Incident not found.",
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
  async closeIncident(
    @Param("dependencyName") dependencyName: string,
    @Body() request?: CloseIncidentRequest,
  ): Promise<HealthIncidentDto> {
    if (!dependencyName || dependencyName.trim().length === 0) {
      throw new BadRequestException("Dependency name is required");
    }

    try {
      const updated = await this.incidentService.closeIncident(
        dependencyName,
        "system", // In a full implementation, would use ActorContext.userId
        request?.note,
      );
      return this.toDto(updated);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  /**
   * Convert incident entity to DTO with safe redaction.
   * @private
   */
  private toDto(incident: any): HealthIncidentDto {
    return {
      id: incident.id,
      dependencyName: incident.dependencyName,
      status: incident.status,
      reasonCode: incident.reasonCode,
      failureThreshold: incident.failureThreshold,
      recoveryThreshold: incident.recoveryThreshold,
      failureWindowMs: Number(incident.failureWindowMs),
      recoveryWindowMs: Number(incident.recoveryWindowMs),
      openedAt: incident.openedAt?.toISOString(),
      acknowledgedAt: incident.acknowledgedAt?.toISOString(),
      closedAt: incident.closedAt?.toISOString(),
      currentProbeCount: incident.currentProbeCount,
      totalFailedProbes: incident.totalFailedProbes,
      totalSuccessfulProbes: incident.totalSuccessfulProbes,
      version: incident.version,
      createdAt: incident.createdAt.toISOString(),
      updatedAt: incident.updatedAt.toISOString(),
      transitions: incident.transitions?.map((t: any) => ({
        id: t.id,
        reason: t.reason,
        status: t.status,
        probeCount: t.probeCount,
        durationMs: Number(t.durationMs),
        actorId: t.actorId,
        note: t.note,
        createdAt: t.createdAt.toISOString(),
      })),
      acknowledgement: incident.acknowledgement
        ? {
            id: incident.acknowledgement.id,
            acknowledgedBy: incident.acknowledgement.acknowledgedBy,
            note: incident.acknowledgement.note,
            expiresAt: incident.acknowledgement.expiresAt.toISOString(),
            createdAt: incident.acknowledgement.createdAt.toISOString(),
          }
        : undefined,
    };
  }
}
