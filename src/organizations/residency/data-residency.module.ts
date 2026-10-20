import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module";
import { DatabaseModule } from "../../database/database.module";
import { DataResidencyController } from "./data-residency.controller";
import { DataResidencyService } from "./data-residency.service";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [DataResidencyController],
  providers: [DataResidencyService],
  exports: [DataResidencyService],
})
export class DataResidencyModule {}
