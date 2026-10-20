import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { DatabaseModule } from "../database/database.module";
import { ContractsModule } from "../contracts/contracts.module";
import { Clock, SystemClock } from "../common/time/clock";
import { ClockSkewMonitorService } from "./clock-skew-monitor.service";
import { DeploymentMetadataService } from "./deployment-metadata.service";
import { HealthController } from "./health.controller";
import { IncidentsController } from "./incidents.controller";
import { HealthService } from "./health.service";
import { ProtocolPauseController } from "./protocol-pause.controller";
import { ProtocolPauseService } from "./protocol-pause.service";

@Module({
  imports: [ApiKeysModule, DatabaseModule, ContractsModule],
  controllers: [HealthController, ProtocolPauseController],
  providers: [
    HealthService,
    DeploymentMetadataService,
    ProtocolPauseService,
    ClockSkewMonitorService,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [HealthService, ProtocolPauseService, ClockSkewMonitorService],
})
export class HealthModule {}
