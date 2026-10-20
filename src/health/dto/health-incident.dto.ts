import { IsString, IsEnum, IsInt, IsOptional, IsDateString, IsUUID, MaxLength, Min, Max } from "class-validator";
import {
  HealthIncidentStatus,
  HealthIncidentReasonCode,
} from "@prisma/client";

/**
 * DTO for incident state and timeline.
 * Versions are implicit and cannot be specified by clients.
 */
export class HealthIncidentDto {
  @IsUUID()
  id: string;

  @IsString()
  dependencyName: string;

  @IsEnum(HealthIncidentStatus)
  status: HealthIncidentStatus;

  @IsEnum(HealthIncidentReasonCode)
  @IsOptional()
  reasonCode?: HealthIncidentReasonCode;

  @IsInt()
  @Min(1)
  failureThreshold: number;

  @IsInt()
  @Min(1)
  recoveryThreshold: number;

  @IsInt()
  @Min(1_000)
  failureWindowMs: number;

  @IsInt()
  @Min(1_000)
  recoveryWindowMs: number;

  @IsDateString()
  @IsOptional()
  openedAt?: string;

  @IsDateString()
  @IsOptional()
  acknowledgedAt?: string;

  @IsDateString()
  @IsOptional()
  closedAt?: string;

  @IsInt()
  currentProbeCount: number;

  @IsInt()
  totalFailedProbes: number;

  @IsInt()
  totalSuccessfulProbes: number;

  @IsInt()
  version: number;

  @IsDateString()
  createdAt: string;

  @IsDateString()
  updatedAt: string;

  transitions?: HealthTransitionDto[];
  acknowledgement?: HealthIncidentAcknowledgementDto;
}

/**
 * DTO for a single state transition in the incident timeline.
 * Transitions are immutable; this DTO is read-only.
 */
export class HealthTransitionDto {
  @IsUUID()
  id: string;

  @IsEnum(HealthIncidentReasonCode)
  reason: HealthIncidentReasonCode;

  @IsEnum(HealthIncidentStatus)
  status: HealthIncidentStatus;

  @IsInt()
  @Min(0)
  probeCount: number;

  @IsInt()
  @Min(0)
  durationMs: number;

  @IsString()
  @IsOptional()
  actorId?: string;

  @IsString()
  @MaxLength(1_024)
  @IsOptional()
  note?: string;

  @IsDateString()
  createdAt: string;
}

/**
 * DTO for operator acknowledgement of an incident.
 * Used to suppress alerts during known issues or maintenance windows.
 */
export class HealthIncidentAcknowledgementDto {
  @IsUUID()
  id: string;

  @IsString()
  acknowledgedBy: string;

  @IsString()
  @MaxLength(1_024)
  note: string;

  @IsDateString()
  expiresAt: string;

  @IsDateString()
  createdAt: string;
}

/**
 * Request to acknowledge an incident.
 * Requires ORG_ADMIN authorization.
 */
export class AcknowledgeIncidentRequest {
  @IsString()
  @MaxLength(1_024)
  note: string;

  @IsInt()
  @Min(300_000) // At least 5 minutes
  @Max(86_400_000) // At most 24 hours
  ttlMs: number;
}

/**
 * Request to close an incident manually.
 * Requires ORG_ADMIN authorization and is an admin override.
 */
export class CloseIncidentRequest {
  @IsString()
  @MaxLength(1_024)
  @IsOptional()
  note?: string;
}

/**
 * Response listing incidents with optional filtering.
 */
export class HealthIncidentsListResponse {
  incidents: HealthIncidentDto[];
  count: number;
  status?: HealthIncidentStatus;
}
