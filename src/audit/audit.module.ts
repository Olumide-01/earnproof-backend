import { Module } from "@nestjs/common";
import { AuditAdminController } from "./audit-admin.controller";
import { AuditAdminService } from "./audit-admin.service";
import { AuditVerificationService } from "./audit-verification.service";
import { VerificationEventService } from "./verification-event.service";
import { SecretRetrievalReceiptService } from "./secret-retrieval-receipt.service";

import { AuditGraphService } from "./audit-graph.service";
import { AuditLegalHoldService } from "./legal-holds/audit-legal-hold.service";
import { AuditLegalHoldsController } from "./legal-holds/audit-legal-holds.controller";

@Module({
  controllers: [AuditAdminController, AuditLegalHoldsController],
  providers: [
    VerificationEventService,
    AuditAdminService,
    AuditVerificationService,
    AuditGraphService,
    AuditLegalHoldService,
  ],
  exports: [
    VerificationEventService,
    AuditVerificationService,
    AuditGraphService,
    AuditLegalHoldService,
  ],
})
export class AuditModule {}
