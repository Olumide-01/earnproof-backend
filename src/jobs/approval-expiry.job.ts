import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ApprovalsService } from "../approvals/approvals.service";

/** Sweeps PENDING approval requests whose deadline has passed to EXPIRED. */
@Injectable()
export class ApprovalExpiryJob {
  private readonly logger = new Logger(ApprovalExpiryJob.name);

  constructor(private readonly approvals: ApprovalsService) {}

  @Cron(process.env.APPROVAL_EXPIRY_CRON ?? CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    const count = await this.approvals.expireStale();
    if (count > 0) {
      this.logger.log(`Expired ${count} stale approval request(s)`);
    }
  }
}
