import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ProofSharingService } from "../proofs/proof-sharing.service";

/**
 * Proof Sharing Cleanup Job
 * 
 * Background job to clean up expired proof sharing events.
 * Runs daily to maintain storage bounds and privacy compliance.
 * 
 * Design decisions:
 * - Independent retention from general verification events
 * - Fail-safe operation (errors logged but don't stop service)
 * - Conservative daily schedule to avoid performance impact
 */
@Injectable()
export class ProofSharingCleanupJob {
  private readonly logger = new Logger(ProofSharingCleanupJob.name);

  constructor(private readonly proofSharingService: ProofSharingService) {}

  /**
   * Clean up expired sharing events.
   * Runs daily at 2 AM UTC.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, {
    name: "proof-sharing-cleanup",
    timeZone: "UTC",
  })
  async handleCleanup() {
    this.logger.log("Starting proof sharing events cleanup...");
    
    try {
      const result = await this.proofSharingService.cleanupExpiredEvents();
      
      if (result.deletedCount > 0) {
        this.logger.log(
          `Cleaned up ${result.deletedCount} expired sharing events`,
        );
      } else {
        this.logger.debug("No expired sharing events to clean up");
      }
    } catch (error) {
      this.logger.error("Failed to cleanup expired sharing events:", error);
      // Don't throw - this is a background job and shouldn't crash the service
    }
  }
}