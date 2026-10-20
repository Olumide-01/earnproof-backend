import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PaymentsModule } from "../payments/payments.module";
import { TrustedSourcesController } from "./trusted-sources.controller";
import { TrustedSourcesService } from "./trusted-sources.service";

@Module({
  imports: [AuthModule, PaymentsModule],
  controllers: [TrustedSourcesController],
  providers: [TrustedSourcesService],
  exports: [TrustedSourcesService],
})
export class TrustedSourcesModule {}
