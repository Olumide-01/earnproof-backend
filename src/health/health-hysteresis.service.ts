import { Injectable, Logger } from "@nestjs/common";
import { HealthIncidentService } from "./health-incident.service";
import {
  DependencyResult,
  DependencyStatusValue,
} from "./health.types";
import { HealthIncidentReasonCode, HealthIncidentStatus } from "@prisma/client";

/**
 * Hysteresis application layer for health probes.
 *
 * This service bridges probe results from HealthService to incident state machine.
 * It maps probe statuses to incident reason codes and prevents transient failures
 * from cascading into false incidents through time-window-based thresholds.
 *
 * The hysteresis layer is stateless; all state is persisted by HealthIncidentService.
 * This separation allows the probe pipeline to remain unchanged while adding
 * incident tracking transparently.
 */
@Injectable()
export class HealthHysteresisService {
  private readonly logger = new Logger(HealthHysteresisService.name);

  constructor(
    private readonly incidentService: HealthIncidentService
  ) {}

  /**
   * Apply hysteresis to a dependency probe result.
   *
   * Maps the probe status to an incident reason code and delegates to the
   * incident state machine. A successful probe always transitions toward
   * recovery or closes the incident; a failed probe accumulates toward
   * opening a new incident if sustained.
   *
   * @param dependencyName The dependency name
   * @param probeResult The probe result from HealthService
   */
  async applyHysteresis(
    dependencyName: string,
    probeResult: DependencyResult
  ): Promise<void> {
    const success = probeResult.status === "ok";
    const reasonCode = this.mapProbeStatusToReasonCode(
      probeResult.status
    );

    // Update incident state
    const incident = await this.incidentService.recordProbe(
      dependencyName,
      success,
      reasonCode
    );

    // Log transitions for observability
    if (incident.status !== HealthIncidentStatus.HEALTHY) {
      this.logger.warn(
        `Health incident: ${dependencyName}=${incident.status} reason=${incident.reasonCode}`,
        {
          dependency: dependencyName,
          status: incident.status,
          reason: incident.reasonCode,
          probeCount: incident.currentProbeCount,
          failedProbes: incident.totalFailedProbes,
          successfulProbes: incident.totalSuccessfulProbes,
        }
      );
    }
  }

  /**
   * Check if a dependency is currently in incident state.
   *
   * Useful for making real-time decisions about probe behavior or alert routing.
   *
   * @param dependencyName The dependency name
   */
  async isIncident(dependencyName: string): Promise<boolean> {
    const incident =
      await this.incidentService.getIncident(dependencyName);
    return (
      incident !== null &&
      (incident.status === HealthIncidentStatus.UNHEALTHY ||
        incident.status === HealthIncidentStatus.ACKNOWLEDGED)
    );
  }

  /**
   * Map a probe status to an incident reason code.
   *
   * Never returns raw error text; always uses bounded, stable codes.
   *
   * @private
   */
  private mapProbeStatusToReasonCode(
    probeStatus: DependencyStatusValue
  ): HealthIncidentReasonCode {
    switch (probeStatus) {
      case "timeout":
        return HealthIncidentReasonCode.PROBE_TIMEOUT;
      case "error":
        return HealthIncidentReasonCode.PROBE_ERROR;
      case "degraded":
        return HealthIncidentReasonCode.PROBE_DEGRADED;
      case "ok":
      case "disabled":
      case "not_configured":
        return HealthIncidentReasonCode.SUSTAINED_RECOVERY;
      default:
        return HealthIncidentReasonCode.SUSTAINED_FAILURE;
    }
  }
}
