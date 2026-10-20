import { Injectable, OnApplicationShutdown } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { randomUUID } from "crypto";
import { StructuredLogger } from "../common/logger";
import { PaymentBackfillService } from "../payments/payment-backfill.service";

/**
 * Drives ledger-range payment backfills (earnproof-backend#177).
 *
 * Each tick claims at most one job under a lease and processes a bounded
 * number of pages. Several instances can run this safely: claims use
 * FOR UPDATE SKIP LOCKED, and every page commit re-checks lease ownership.
 */
@Injectable()
export class PaymentBackfillWorkerService implements OnApplicationShutdown {
  private readonly logger = new StructuredLogger(
    PaymentBackfillWorkerService.name,
  );
  private readonly owner = `backfill-worker:${randomUUID()}`;
  private draining = false;
  private running = false;

  constructor(private readonly backfills: PaymentBackfillService) {}

  @Interval(15_000)
  async poll(): Promise<void> {
    // One lease at a time per instance; a slow Horizon page must not stack
    // overlapping ticks.
    if (this.draining || this.running) return;
    this.running = true;
    try {
      const outcome = await this.backfills.runLease(this.owner);
      if (outcome !== "idle") {
        this.logger.log(`Payment backfill lease finished: ${outcome}`);
      }
    } catch {
      // Never log the raw error: it can carry addresses or ledger data. The
      // lease expires and another tick resumes from the last checkpoint.
      this.logger.warn("Payment backfill lease failed unexpectedly");
    } finally {
      this.running = false;
    }
  }

  onApplicationShutdown(): void {
    // Stop claiming. A lease in flight either commits its page or is
    // reclaimed after expiry from the last committed checkpoint.
    this.draining = true;
  }
}
