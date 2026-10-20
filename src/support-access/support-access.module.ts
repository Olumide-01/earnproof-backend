import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { AuthModule } from "../auth/auth.module";
import { SupportAccessService } from "./support-access.service";
import { SupportAccessController } from "./support-access.controller";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [SupportAccessController],
  providers: [SupportAccessService],
  exports: [SupportAccessService],
})
export class SupportAccessModule {}
