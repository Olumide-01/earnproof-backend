import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { WebhookTlsPostureService } from "../webhooks/tls-posture/webhook-tls-posture.service";

/**
 * Probes due webhook endpoints' TLS posture (#315).
 *
 * Hourly by default; each run probes at most one bounded batch of webhooks
 * whose latest probe is older than a day, so every endpoint is probed roughly
 * daily without a burst of outbound connections.
 */
@Injectable()
export class WebhookTlsProbeJob {
  private readonly logger = new Logger(WebhookTlsProbeJob.name);

  constructor(private readonly posture: WebhookTlsPostureService) {}

  @Cron(process.env.WEBHOOK_TLS_PROBE_CRON ?? CronExpression.EVERY_HOUR)
  async sweep(): Promise<void> {
    const run = await this.posture.runScheduledProbes();
    if (run.skipped) {
      this.logger.debug("Webhook TLS probe run already in progress; skipping");
      return;
    }
    if (run.probed > 0 || run.failed > 0) {
      this.logger.log(
        `Probed ${run.probed} webhook endpoint(s); ${run.alerts} alert(s), ${run.failed} failure(s)`,
      );
    }
  }
}
