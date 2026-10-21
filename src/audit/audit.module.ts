import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuditAdminController } from "./audit-admin.controller";
import { AuditAdminService } from "./audit-admin.service";
import { AuditVerificationService } from "./audit-verification.service";
import { VerificationEventService } from "./verification-event.service";
import { SecretRetrievalReceiptService } from "./secret-retrieval-receipt.service";

import { AuditService } from "./audit.service";
import { AuditGraphService } from "./audit-graph.service";
import { AuditLegalHoldService } from "./legal-holds/audit-legal-hold.service";
import { AuditLegalHoldsController } from "./legal-holds/audit-legal-holds.controller";

@Module({
  imports: [AuthModule],
  controllers: [AuditAdminController, AuditLegalHoldsController],
  providers: [
    AuditService,
    VerificationEventService,
    AuditAdminService,
    AuditVerificationService,
    AuditGraphService,
    AuditLegalHoldService,
    SecretRetrievalReceiptService,
  ],
  exports: [
    AuditService,
    VerificationEventService,
    AuditVerificationService,
    AuditGraphService,
    AuditLegalHoldService,
    SecretRetrievalReceiptService,
  ],
})
export class AuditModule {}
