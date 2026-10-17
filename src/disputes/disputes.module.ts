import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DisputeEvidenceService } from "./dispute-evidence.service";
import { DisputesController } from "./disputes.controller";

@Module({
  imports: [AuthModule],
  controllers: [DisputesController],
  providers: [DisputeEvidenceService],
  exports: [DisputeEvidenceService],
})
export class DisputesModule {}