import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { QuotasModule } from "../quotas/quotas.module";
import { WebhookCircuitBreakerService } from "./webhook-circuit-breaker.service";
import { WebhookClientCertificateService } from "./webhook-client-certificate.service";
import { WebhookClientCertificatesController } from "./webhook-client-certificates.controller";
import { WebhookDeadLetterService } from "./webhook-dead-letter.service";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookSigningService } from "./webhook-signing.service";
import { WebhookVerificationService } from "./webhook-verification.service";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";
import { PredicateEvaluatorService } from "./services/predicate-evaluator.service";
import { PredicatePreviewService } from "./services/predicate-preview.service";
import { WebhookTlsPostureController } from "./tls-posture/webhook-tls-posture.controller";
import { WebhookTlsPostureService } from "./tls-posture/webhook-tls-posture.service";

@Module({
  imports: [AuthModule, QuotasModule],
  controllers: [
    WebhooksController,
    WebhookClientCertificatesController,
    WebhookTlsPostureController,
  ],
  providers: [
    WebhooksService,
    WebhookDeliveryService,
    WebhookSigningService,
    WebhookClientCertificateService,
    WebhookCircuitBreakerService,
    WebhookDeadLetterService,
    PredicateEvaluatorService,
    PredicatePreviewService,
    WebhookTlsPostureService,
  ],
  exports: [
    WebhookDeliveryService,
    WebhookClientCertificateService,
    WebhookCircuitBreakerService,
    WebhookDeadLetterService,
    WebhooksService,
    PredicateEvaluatorService,
    PredicatePreviewService,
    WebhookTlsPostureService,
  ],
})
export class WebhooksModule {}
