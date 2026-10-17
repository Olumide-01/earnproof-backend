import { Module } from "@nestjs/common";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { ContractsModule } from "../contracts/contracts.module";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";
import { AnchoringWorkerService } from "./anchoring-worker.service";
import { CompatibilityAssessmentJob } from "./compatibility/compatibility-assessment.job";
import { CompatibilityAssessmentWorkerService } from "./compatibility/compatibility-assessment-worker.service";
import { RetentionCleanupService } from "./retention/retention-cleanup.service";
import { RetentionJob } from "./retention/retention.job";

@Module({
  imports: [ContractsModule],
  providers: [
    ContractAnchoringService,
    AnchoringWorkerService,
    AnchoringReconcilerService,
    RetentionCleanupService,
    RetentionJob,
    CompatibilityAssessmentWorkerService,
    CompatibilityAssessmentJob,
  ],
  exports: [
    AnchoringWorkerService,
    AnchoringReconcilerService,
    RetentionCleanupService,
    CompatibilityAssessmentWorkerService,
  ],
})
export class JobsModule {}