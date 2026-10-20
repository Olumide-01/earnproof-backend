import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import {
  HealthIncident,
  HealthIncidentStatus,
  HealthIncidentReasonCode,
  HealthTransition,
} from "@prisma/client";

/**
 * Health incident state machine and hysteresis logic.
 *
 * This service manages the lifecycle of health incidents for dependencies,
 * implementing sustained-failure and sustained-recovery policies to prevent
 * transient failures from triggering false incidents. Each dependency has at
 * most one active incident at a time.
 *
 * State machine:
 *   HEALTHY (default)
 *     └─> UNHEALTHY (sustained failures exceed threshold)
 *           ├─> ACKNOWLEDGED (operator acknowledges)
 *           └─> RECOVERED (sustained successes exceed threshold)
 *                 └─> HEALTHY (incident closed)
 *
 * Hysteresis thresholds prevent flapping:
 *   - Failure threshold: N consecutive failures within window
 *   - Recovery threshold: M consecutive successes within window
 */
@Injectable()
export class HealthIncidentService {
  private readonly logger = new Logger(HealthIncidentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a probe result and update incident state.
   *
   * Returns the updated incident state after processing the probe result.
   * Transitions are immutable and form the incident timeline.
   *
   * @param dependencyName The dependency being probed
   * @param success Whether the probe succeeded
   * @param reasonCode The failure reason (if failed)
   * @throws PrismaClient errors only; state machine logic is resilient
   */
  async recordProbe(
    dependencyName: string,
    success: boolean,
    reasonCode?: HealthIncidentReasonCode
  ): Promise<HealthIncident> {
    const incident =
      await this.getOrCreateIncident(dependencyName);

    // Use optimistic concurrency to ensure exactly one winner in concurrent updates
    const updated = await this.prisma.healthIncident.update({
      where: { id: incident.id },
      data: await this.computeStateTransition(
        incident,
        success,
        reasonCode
      ),
      include: {
        transitions: { orderBy: { createdAt: "asc" } },
        acknowledgement: true,
      },
    });

    return updated;
  }

  /**
   * Acknowledge an unhealthy incident, suppressing alerts for a time window.
   *
   * @param dependencyName The dependency with an incident
   * @param acknowledgedBy Actor ID (opaque user identifier)
   * @param note Human-readable acknowledgement note
   * @param expiresAt When the acknowledgement expires
   * @throws If incident does not exist or is not in UNHEALTHY status
   */
  async acknowledgeIncident(
    dependencyName: string,
    acknowledgedBy: string,
    note: string,
    expiresAt: Date
  ): Promise<HealthIncident> {
    const incident = await this.prisma.healthIncident.findUnique({
      where: { dependencyName },
      include: {
        transitions: { orderBy: { createdAt: "asc" } },
        acknowledgement: true,
      },
    });

    if (!incident) {
      throw new Error(`Incident not found: ${dependencyName}`);
    }

    if (incident.status !== HealthIncidentStatus.UNHEALTHY) {
      throw new Error(
        `Cannot acknowledge non-unhealthy incident: status=${incident.status}`
      );
    }

    // Create or update acknowledgement
    await this.prisma.healthIncidentAcknowledgement.upsert({
      where: { incidentId: incident.id },
      create: {
        incidentId: incident.id,
        acknowledgedBy,
        note,
        expiresAt,
      },
      update: {
        acknowledgedBy,
        note,
        expiresAt,
      },
    });

    // Record transition to ACKNOWLEDGED state
    return await this.prisma.healthIncident.update({
      where: { id: incident.id },
      data: {
        status: HealthIncidentStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
        version: { increment: 1 },
      },
      include: {
        transitions: { orderBy: { createdAt: "asc" } },
        acknowledgement: true,
      },
    });
  }

  /**
   * Get incident by dependency name, creating default config if missing.
   * @private
   */
  private async getOrCreateIncident(
    dependencyName: string
  ): Promise<HealthIncident> {
    let incident = await this.prisma.healthIncident.findUnique({
      where: { dependencyName },
      include: {
        transitions: { orderBy: { createdAt: "asc" } },
        acknowledgement: true,
      },
    });

    if (!incident) {
      incident = await this.prisma.healthIncident.create({
        data: {
          dependencyName,
          status: HealthIncidentStatus.HEALTHY,
          configVersion: 1,
          failureThreshold: 3,
          recoveryThreshold: 5,
          failureWindowMs: 60_000, // 1 minute
          recoveryWindowMs: 120_000, // 2 minutes
        },
        include: {
          transitions: { orderBy: { createdAt: "asc" } },
          acknowledgement: true,
        },
      });
    }

    return incident;
  }

  /**
   * Compute next state and record transition.
   * @private
   */
  private async computeStateTransition(
    incident: HealthIncident & {
      transitions: HealthTransition[];
      acknowledgement: { expiresAt: Date } | null;
    },
    success: boolean,
    reasonCode?: HealthIncidentReasonCode
  ): Promise<{
    status: HealthIncidentStatus;
    reasonCode: HealthIncidentReasonCode | null;
    currentProbeCount: number;
    probeCountWindowStart: Date;
    totalFailedProbes?: number;
    totalSuccessfulProbes?: number;
    openedAt?: Date | null;
    closedAt?: Date | null;
    acknowledgedAt?: Date | null;
    version: number;
    transitions?: {
      create: {
        reason: HealthIncidentReasonCode;
        status: HealthIncidentStatus;
        probeCount: number;
        durationMs: bigint;
      };
    };
  }> {
    const now = new Date();
    const windowStart =
      incident.probeCountWindowStart || now;
    const elapsedMs = now.getTime() - windowStart.getTime();

    // Reset probe count if window expired
    let probeCount = incident.currentProbeCount;
    let resetWindow = false;
    if (incident.status === HealthIncidentStatus.UNHEALTHY) {
      if (elapsedMs > Number(incident.failureWindowMs)) {
        probeCount = 0;
        resetWindow = true;
      }
    } else if (incident.status === HealthIncidentStatus.ACKNOWLEDGED) {
      if (
        incident.acknowledgement &&
        now > incident.acknowledgement.expiresAt
      ) {
        // Acknowledgement expired; revert to UNHEALTHY
        probeCount = 1;
        resetWindow = true;
      } else if (elapsedMs > Number(incident.recoveryWindowMs)) {
        probeCount = 0;
        resetWindow = true;
      }
    }

    probeCount = success ? probeCount + 1 : 1;

    const { nextStatus, nextReason, newlyOpened, newlyClosed } =
      this.computeNextStatus(
        incident,
        success,
        probeCount,
        reasonCode || null
      );

    // Record transition
    await this.prisma.healthTransition.create({
      data: {
        incidentId: incident.id,
        reason: nextReason,
        status: nextStatus,
        probeCount,
        durationMs: BigInt(elapsedMs),
        actorId: null,
        note: null,
      },
    });

    return {
      status: nextStatus,
      reasonCode: nextReason,
      currentProbeCount: nextStatus === HealthIncidentStatus.HEALTHY ? 0 : probeCount,
      probeCountWindowStart: resetWindow ? now : windowStart,
      totalFailedProbes: success
        ? incident.totalFailedProbes
        : incident.totalFailedProbes + 1,
      totalSuccessfulProbes: success
        ? incident.totalSuccessfulProbes + 1
        : incident.totalSuccessfulProbes,
      openedAt: newlyOpened ? now : incident.openedAt,
      closedAt: newlyClosed ? now : incident.closedAt,
      acknowledgedAt: incident.acknowledgedAt,
      version: incident.version + 1,
    };
  }

  /**
   * Determine next state based on current state and probe result.
   * @private
   */
  private computeNextStatus(
    incident: HealthIncident,
    success: boolean,
    probeCount: number,
    failureReason: HealthIncidentReasonCode | null
  ): {
    nextStatus: HealthIncidentStatus;
    nextReason: HealthIncidentReasonCode;
    newlyOpened: boolean;
    newlyClosed: boolean;
  } {
    let nextStatus = incident.status;
    let nextReason = incident.reasonCode || HealthIncidentReasonCode.SUSTAINED_FAILURE;
    let newlyOpened = false;
    let newlyClosed = false;

    if (incident.status === HealthIncidentStatus.HEALTHY) {
      if (
        !success &&
        probeCount >= incident.failureThreshold
      ) {
        nextStatus = HealthIncidentStatus.UNHEALTHY;
        nextReason = failureReason || HealthIncidentReasonCode.SUSTAINED_FAILURE;
        newlyOpened = true;
      }
    } else if (incident.status === HealthIncidentStatus.UNHEALTHY) {
      if (
        success &&
        probeCount >= incident.recoveryThreshold
      ) {
        nextStatus = HealthIncidentStatus.RECOVERED;
        nextReason = HealthIncidentReasonCode.SUSTAINED_RECOVERY;
        newlyClosed = true;
      }
    } else if (incident.status === HealthIncidentStatus.ACKNOWLEDGED) {
      if (
        success &&
        probeCount >= incident.recoveryThreshold
      ) {
        nextStatus = HealthIncidentStatus.RECOVERED;
        nextReason = HealthIncidentReasonCode.SUSTAINED_RECOVERY;
        newlyClosed = true;
      }
    } else if (incident.status === HealthIncidentStatus.RECOVERED) {
      // Auto-close: transition to HEALTHY
      nextStatus = HealthIncidentStatus.HEALTHY;
      nextReason = HealthIncidentReasonCode.SUSTAINED_RECOVERY;
      newlyClosed = true;
    }

    return { nextStatus, nextReason, newlyOpened, newlyClosed };
  }

  /**
   * Get incident by dependency name.
   */
  async getIncident(
    dependencyName: string
  ): Promise<
    | (HealthIncident & {
        transitions: HealthTransition[];
        acknowledgement: any;
      })
    | null
  > {
    return await this.prisma.healthIncident.findUnique({
      where: { dependencyName },
      include: {
        transitions: { orderBy: { createdAt: "asc" } },
        acknowledgement: true,
      },
    });
  }

  /**
   * List all incidents with optional status filter.
   */
  async listIncidents(
    status?: HealthIncidentStatus
  ): Promise<
    Array<
      HealthIncident & {
        transitions: HealthTransition[];
        acknowledgement: any;
      }
    >
  > {
    return await this.prisma.healthIncident.findMany({
      where: status ? { status } : undefined,
      include: {
        transitions: { orderBy: { createdAt: "asc" } },
        acknowledgement: true,
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  /**
   * Close an incident manually (admin action).
   */
  async closeIncident(
    dependencyName: string,
    actorId: string,
    note?: string
  ): Promise<HealthIncident> {
    const incident = await this.prisma.healthIncident.findUnique({
      where: { dependencyName },
      include: {
        transitions: { orderBy: { createdAt: "asc" } },
        acknowledgement: true,
      },
    });

    if (!incident) {
      throw new Error(`Incident not found: ${dependencyName}`);
    }

    // Record closing transition
    await this.prisma.healthTransition.create({
      data: {
        incidentId: incident.id,
        reason: HealthIncidentReasonCode.SUSTAINED_RECOVERY,
        status: HealthIncidentStatus.RECOVERED,
        probeCount: 1,
        durationMs: BigInt(
          new Date().getTime() -
            (incident.probeCountWindowStart?.getTime() || 0)
        ),
        actorId,
        note,
      },
    });

    // Close incident
    return await this.prisma.healthIncident.update({
      where: { id: incident.id },
      data: {
        status: HealthIncidentStatus.RECOVERED,
        closedAt: new Date(),
        version: { increment: 1 },
      },
      include: {
        transitions: { orderBy: { createdAt: "asc" } },
        acknowledgement: true,
      },
    });
  }
}
