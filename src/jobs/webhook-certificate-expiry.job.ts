import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { WebhookClientCertificateService } from "../webhooks/webhook-client-certificate.service";

/** Sweeps webhook client certificates past their notAfter into EXPIRED. */
@Injectable()
export class WebhookCertificateExpiryJob {
  private readonly logger = new Logger(WebhookCertificateExpiryJob.name);

  constructor(private readonly certificates: WebhookClientCertificateService) {}

  @Cron(process.env.WEBHOOK_CERTIFICATE_EXPIRY_CRON ?? CronExpression.EVERY_HOUR)
  async sweep(): Promise<void> {
    const count = await this.certificates.expireStale();
    if (count > 0) {
      this.logger.log(`Expired ${count} webhook client certificate(s)`);
    }
  }
}
