import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { Clock, SystemClock } from "../common/time/clock";
import { ConfigRolloutController } from "./config-rollout.controller";
import { ConfigRolloutService } from "./config-rollout.service";
import { ConfigRolloutStore, PrismaConfigRolloutStore } from "./config-rollout.store";
import { MaintenanceDrainService } from "./maintenance-drain.service";
import { MaintenanceDrainController } from "./maintenance-drain.controller";

@Module({
  imports: [AuthModule],
  controllers: [MaintenanceDrainController, ConfigRolloutController],
  providers: [
    MaintenanceDrainService,
    ConfigRolloutService,
    { provide: ConfigRolloutStore, useClass: PrismaConfigRolloutStore },
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [MaintenanceDrainService, ConfigRolloutService],
})
export class DeploymentsModule {}
