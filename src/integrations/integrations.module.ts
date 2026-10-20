import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { SignatureDiagnosticsController } from "./signature-diagnostics/signature-diagnostics.controller";
import { SignatureDiagnosticsService } from "./signature-diagnostics/signature-diagnostics.service";

@Module({
  imports: [ApiKeysModule],
  controllers: [SignatureDiagnosticsController],
  providers: [SignatureDiagnosticsService],
})
export class IntegrationsModule {}
