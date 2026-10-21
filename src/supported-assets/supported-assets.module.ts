import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { SupportedAssetsController } from "./supported-assets.controller";
import { SupportedAssetsService } from "./supported-assets.service";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [SupportedAssetsController],
  providers: [SupportedAssetsService],
  exports: [SupportedAssetsService],
})
export class SupportedAssetsModule {}
