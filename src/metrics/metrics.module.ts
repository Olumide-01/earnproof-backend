import { Module } from "@nestjs/common";
import { CapacitySamplerService } from "./capacity-sampler.service";
import { CapacityTrendService } from "./capacity-trend.service";
import { CapacityTrendController } from "./capacity-trend.controller";

@Module({
  controllers: [CapacityTrendController],
  providers: [CapacitySamplerService, CapacityTrendService],
  exports: [CapacitySamplerService, CapacityTrendService],
})
export class MetricsModule {}