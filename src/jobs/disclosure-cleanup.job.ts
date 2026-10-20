import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ReceiptService } from "../common/disclosure/receipt.service";

/**
 * Disclosure Cleanup Job
 * 
 * Background job to clean up expired disclosure receipts.
 * Runs daily to maintain storage bounds and comply with data retention policies.
 * 
 * Schedule: Daily at 2 AM UTC
 * Retention: Receipts are deleted after expiration (no grace period needed as they're already expired)
 */
@Injectable()
export class DisclosureCleanupJob {
  private readonly logger = new Logger(DisclosureCleanupJob.name);

  constructor(private readonly receiptService: ReceiptService) {}

  /**
   * Clean up expired disclosure receipts
   * 
   * Removes receipts that have passed their expiration date.
   * Expired receipts are no longer valid for verification so can be safely deleted.
   */
  @Cron("0 2 * * *", {
    name: "disclosure-receipt-cleanup",
    timeZone: "UTC",
  })
  async cleanupExpiredReceipts(): Promise<void> {
    this.logger.log("Starting disclosure receipt cleanup job");

    try {
      const result = await this.receiptService.cleanupExpiredReceipts();
      
      if (result.deletedCount > 0) {
        this.logger.log(
          `Disclosure receipt cleanup completed: ${result.deletedCount} expired receipts deleted`,
        );
      } else {
        this.logger.log("Disclosure receipt cleanup completed: no expired receipts found");
      }
    } catch (error) {
      this.logger.error("Disclosure receipt cleanup job failed:", error);
      // Don't throw - let the job scheduler handle retries
    }
  }
}