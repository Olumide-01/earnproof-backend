import { QuotasModule } from "../quotas/quotas.module";
import { HealthModule } from "../health/health.module";
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { AttestationsModule } from "../attestations/attestations.module";
import { IssuersModule } from "../issuers/issuers.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { CredentialVerificationKeyService } from "../common/crypto/credential-verification-key.service";
import { ContractAnchoringService } from "./contract-anchoring.service";
import { ProofsController } from "./proofs.controller";
import { ProofsService } from "./proofs.service";
import { ProofSharingService } from "./proof-sharing.service";
import { ProofReconciliationService } from "./proof-reconciliation.service";
import { RevocationCheckpointService } from "./revocation-checkpoint.service";
import { RevocationCheckpointController } from "./revocation-checkpoint.controller";
import { ProofVerificationAbuseService } from "../common/rate-limit/proof-verification-abuse.service";
import { ProofExpirationReminderService } from "./proof-expiration-reminder.service";
import { ProofExpirationReminderController } from "./proof-expiration-reminder.controller";
import { ProofCapacityPreflightService } from "./proof-capacity-preflight.service";
import { BoundedRefreshService } from "./bounded-refresh.service";
import { PurposeDeclarationsService } from "./purpose-declarations.service";
import { PurposeEnforcementService } from "./purpose-enforcement.service";
import { PurposeDeclarationsController } from "./purpose-declarations.controller";

@Module({
  imports: [
    AuthModule,
    AuditModule,
    AttestationsModule,
    IssuersModule,
    WebhooksModule,
    NotificationsModule,
    QuotasModule,
    HealthModule,
  ],
  controllers: [ProofsController, ProofExpirationReminderController, RevocationCheckpointController, PurposeDeclarationsController],
  providers: [
    ContractAnchoringService,
    CredentialVerificationKeyService,
    ProofsService,
    ProofSharingService,
    ProofReconciliationService,
    RevocationCheckpointService,
    ProofVerificationAbuseService,
    ProofReconciliationService,
    ProofExpirationReminderService,
    ProofCapacityPreflightService,
    BoundedRefreshService,
    PurposeDeclarationsService,
    PurposeEnforcementService,
  ],
  exports: [
    ContractAnchoringService,
    CredentialVerificationKeyService,
    PurposeDeclarationsService,
    PurposeEnforcementService,
    ProofSharingService,
    ProofReconciliationService,
    ProofExpirationReminderService,
    ProofCapacityPreflightService,
    BoundedRefreshService,
  ],
})
export class ProofsModule {}
