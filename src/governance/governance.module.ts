import { Module } from "@nestjs/common";
import { GovernanceReviewService } from "./governance-review.service";

@Module({
  providers: [GovernanceReviewService],
  exports: [GovernanceReviewService],
})
export class GovernanceModule {}
