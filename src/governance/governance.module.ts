import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { CommonModule } from "../common/common.module";
import { GovernanceController } from "./governance.controller";
import { GovernanceService } from "./governance.service";
import { ApprovalIntentReceiptController } from "./controllers/approval-intent-receipt.controller";
import { ApprovalIntentReceiptService } from "./services/approval-intent-receipt.service";
import { ApprovalIntentReceiptKeysService } from "./services/approval-intent-receipt-keys.service";

@Module({
  imports: [DatabaseModule, AuthModule, CommonModule],
  controllers: [GovernanceController, ApprovalIntentReceiptController],
  providers: [GovernanceService, ApprovalIntentReceiptService, ApprovalIntentReceiptKeysService],
  exports: [GovernanceService, ApprovalIntentReceiptService],
})
export class GovernanceModule {}
