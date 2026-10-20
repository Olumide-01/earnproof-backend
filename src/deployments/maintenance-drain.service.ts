import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { MaintenancePhase, InitiateDrainDto, DrainStatusResponseDto } from "./dto/maintenance-drain.dto";

@Injectable()
export class MaintenanceDrainService {
  private readonly logger = new Logger(MaintenanceDrainService.name);
  private phase: MaintenancePhase = MaintenancePhase.NORMAL;
  private inFlightMutations = 0;
  private drainStartedAt?: Date;
  private drainDeadline?: Date;
  private drainReason?: string;

  /**
   * Retrieves current drain and readiness status.
   */
  getStatus(): DrainStatusResponseDto {
    this.checkTimeout();

    return {
      phase: this.phase,
      mutationsAllowed: this.phase === MaintenancePhase.NORMAL,
      readsAllowed: true, // Reads remain available in all states
      inFlightMutations: this.inFlightMutations,
      drainStartedAt: this.drainStartedAt?.toISOString(),
      drainDeadline: this.drainDeadline?.toISOString(),
    };
  }

  /**
   * Initiates graceful draining before deployment or maintenance.
   * Gates all new incoming write requests while allowing in-flight mutations to finish.
   */
  initiateDrain(dto: InitiateDrainDto): DrainStatusResponseDto {
    if (this.phase === MaintenancePhase.DRAINING || this.phase === MaintenancePhase.MAINTENANCE) {
      throw new ConflictException(`Drain or maintenance is already in progress: ${this.phase}`);
    }

    const now = new Date();
    this.phase = MaintenancePhase.DRAINING;
    this.drainStartedAt = now;
    this.drainDeadline = new Date(now.getTime() + dto.timeoutSeconds * 1000);
    this.drainReason = dto.reason;

    this.logger.warn(`Maintenance drain initiated: ${dto.reason}. Timeout: ${dto.timeoutSeconds}s`);

    // If zero in-flight mutations, transition directly to MAINTENANCE
    if (this.inFlightMutations === 0) {
      this.phase = MaintenancePhase.MAINTENANCE;
      this.logger.log("Zero in-flight mutations, transitioned directly to MAINTENANCE phase");
    }

    return this.getStatus();
  }

  /**
   * Enters a mutation block. Increments in-flight counter or throws 503 if draining/maintenance.
   */
  trackMutationStart(): void {
    this.checkTimeout();

    if (this.phase !== MaintenancePhase.NORMAL) {
      throw new ServiceUnavailableException(
        "Service is currently draining or in maintenance mode for deployment.",
      );
    }

    this.inFlightMutations++;
  }

  /**
   * Exits a mutation block. Decrements in-flight counter and auto-advances to MAINTENANCE if draining.
   */
  trackMutationEnd(): void {
    if (this.inFlightMutations > 0) {
      this.inFlightMutations--;
    }

    if (this.phase === MaintenancePhase.DRAINING && this.inFlightMutations === 0) {
      this.phase = MaintenancePhase.MAINTENANCE;
      this.logger.log("All in-flight mutations completed. System is now in MAINTENANCE phase.");
    }
  }

  /**
   * Safely resumes normal traffic after deployment or maintenance completion.
   */
  resumeNormal(): DrainStatusResponseDto {
    this.phase = MaintenancePhase.NORMAL;
    this.drainStartedAt = undefined;
    this.drainDeadline = undefined;
    this.drainReason = undefined;

    this.logger.log("Maintenance mode completed. Resumed NORMAL operations.");
    return this.getStatus();
  }

  private checkTimeout(): void {
    if (this.phase === MaintenancePhase.DRAINING && this.drainDeadline) {
      if (Date.now() > this.drainDeadline.getTime()) {
        this.logger.warn("Drain deadline reached. Forcing transition to MAINTENANCE.");
        this.phase = MaintenancePhase.MAINTENANCE;
      }
    }
  }
}
