import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { CommonModule } from "../common/common.module";
import { OrganizationsModule } from "../organizations/organizations.module";
import { DisputesController } from "./disputes.controller";
import { DisputesService } from "./disputes.service";

@Module({
  imports: [AuthModule, WebhooksModule, CommonModule, OrganizationsModule],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}