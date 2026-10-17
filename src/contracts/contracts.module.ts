import { Module } from "@nestjs/common";
import { CompatibilityAssessmentService } from "./compatibility-assessment.service";

@Module({
  providers: [CompatibilityAssessmentService],
  exports: [CompatibilityAssessmentService],
})
export class ContractsModule {}
