import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CredentialQuarantineService } from '../credentials/credential-quarantine.service';

/**
 * Credential Quarantine Expiry Job
 *
 * Scheduled job that automatically expires quarantine records past their deadline.
 * Moves QUARANTINED records with expiresAt <= now to EXPIRED terminal state.
 *
 * Runs daily at midnight (configurable via environment variable).
 * Job is reentrant and idempotent: safe to run multiple times or be interrupted.
 */
@Injectable()
export class CredentialQuarantineExpiryJob {
  private readonly logger = new Logger(CredentialQuarantineExpiryJob.name);

  constructor(private readonly quarantineService: CredentialQuarantineService) {}

  /**
   * Expire quarantine records past their deadline.
   *
   * Cron expression:
   * - Default: EVERY_DAY_AT_MIDNIGHT (0 0 * * *)
   * - Override: QUARANTINE_EXPIRY_CRON environment variable
   *
   * Run behavior:
   * - Idempotent: no state preserved between runs
   * - Reentrant: safe to interrupt and restart
   * - No pagination: assumes expiry set is small (<100K records)
   * - Error handling: caught and logged, job continues
   */
  @Cron(process.env.QUARANTINE_EXPIRY_CRON ?? CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async expireQuarantineRecords(): Promise<void> {
    try {
      const count = await this.quarantineService.expireQuarantineRecords();
      this.logger.log(`Expired ${count} quarantine record(s) in this run`);
    } catch (error) {
      this.logger.error(`Failed to expire quarantine records: ${error.message}`, error.stack);
      // Don't rethrow; allow job to continue on next interval
    }
  }
}
