import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { IssuerAddressRotationService } from "../issuers/issuer-address-rotation.service";

/**
 * Drives open issuer address rotations to a terminal state.
 *
 * A rotation is submitted as soon as it is requested; this job is what makes
 * that submission survive a timeout, a failed read or a process restart. Each
 * pass reads the contract before acting, and each rotation is leased, so
 * overlapping passes and multiple instances do not double-submit.
 */
@Injectable()
export class IssuerAddressRotationJob {
  private readonly logger = new Logger(IssuerAddressRotationJob.name);
  private running = false;

  constructor(private readonly rotations: IssuerAddressRotationService) {}

  @Interval(60_000)
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const processed = await this.rotations.reconcileDue();
      if (processed > 0) {
        this.logger.log(`Reconciled ${processed} issuer address rotation(s)`);
      }
      return processed;
    } catch (error) {
      this.logger.error(
        `Issuer address rotation reconciliation failed: ${
          error instanceof Error ? error.name : "unknown"
        }`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
