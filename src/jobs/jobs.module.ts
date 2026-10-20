import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { ApprovalsModule } from "../approvals/approvals.module";
import { DisclosureModule } from "../common/disclosure/disclosure.module";
import { IssuerReconciliationService } from "../issuers/issuer-reconciliation.service";
import { IssuersModule } from "../issuers/issuers.module";
import { PaymentsModule } from "../payments/payments.module";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { ProofReconciliationService } from "../proofs/proof-reconciliation.service";
import { ProofsModule } from "../proofs/proofs.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { ApprovalExpiryJob } from "./approval-expiry.job";
import { AttestationReconcilerService } from "./attestation-reconciler.service";
import { DisclosureCleanupJob } from "./disclosure-cleanup.job";
import { JobExecutionMaintenanceJob } from "./execution/job-execution-maintenance.job";
import { JobExecutionController } from "./execution/job-execution.controller";
import { JobExecutionService } from "./execution/job-execution.service";
import { IssuerAddressRotationJob } from "./issuer-address-rotation.job";
import { PaymentBackfillWorkerService } from "./payment-backfill-worker.service";
import { ProofExpirationReconcilerService } from "./proof-expiration-reconciler.service";
import { ProofSharingCleanupJob } from "./proof-sharing-cleanup.job";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";
import { RevocationPropagationController } from "./revocation-propagation.controller";
import { RevocationPropagationReconcilerService } from "./revocation-propagation-reconciler.service";
import { WebhookCertificateExpiryJob } from "./webhook-certificate-expiry.job";
import { WebhookTlsProbeJob } from "./webhook-tls-probe.job";
import { DomainEventOutboxWorkerService } from "./domain-event-outbox-worker.service";
import { BulkAdminService } from "./bulk-admin/bulk-admin.service";
import { BulkAdminController } from "./bulk-admin/bulk-admin.controller";
import { MetricsModule } from "../metrics/metrics.module";
import { MetricsRollupJob } from "./metrics-rollup.job";

@Module({
  imports: [
    ApprovalsModule,
    IssuersModule,
    PaymentsModule,
    ProofsModule,
    DisclosureModule,
    WebhooksModule,
    ApiKeysModule,
    MetricsModule,
  ],
  controllers: [JobExecutionController, RevocationPropagationController],
  controllers: [JobExecutionController, BulkAdminController],
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    PaymentBackfillWorkerService,
    DomainEventOutboxWorkerService,
    AnchoringReconcilerService,
    IssuerAddressRotationJob,
    ProofExpirationReconcilerService,
    ProofSharingCleanupJob,
    DisclosureCleanupJob,
    ProofReconciliationService,
    IssuerReconciliationService,
    RetentionCleanupService,
    RetentionJob,
    ApprovalExpiryJob,
    WebhookCertificateExpiryJob,
    WebhookTlsProbeJob,
    JobExecutionService,
    JobExecutionMaintenanceJob,
    AttestationReconcilerService,
    RevocationPropagationReconcilerService,
    BulkAdminService,
    MetricsRollupJob,
  ],
  exports: [
    AnchoringWorkerService,
    PaymentBackfillWorkerService,
    DomainEventOutboxWorkerService,
    AnchoringReconcilerService,
    ProofExpirationReconcilerService,
    ProofSharingCleanupJob,
    DisclosureCleanupJob,
    ProofReconciliationService,
    IssuerReconciliationService,
    RetentionCleanupService,
    JobExecutionService,
    RevocationPropagationReconcilerService,
    BulkAdminService,
  ],
})
export class JobsModule {}
