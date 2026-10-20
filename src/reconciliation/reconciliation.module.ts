import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { ApprovalsModule } from "../approvals/approvals.module";
import { ReconciliationConflictService } from "./reconciliation-conflict.service";

@Module({
  imports: [DatabaseModule, ApprovalsModule],
  providers: [ReconciliationConflictService],
  exports: [ReconciliationConflictService],
})
export class ReconciliationModule {}
