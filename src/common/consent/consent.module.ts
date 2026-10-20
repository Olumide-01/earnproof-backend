import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module";
import { ConsentController } from "./consent.controller";
import { ConsentService } from "./consent.service";

/**
 * Consent Management Module
 * 
 * Handles policy version management and user consent tracking.
 * Provides immutable audit trail for compliance requirements.
 */
@Module({
  imports: [AuthModule],
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}