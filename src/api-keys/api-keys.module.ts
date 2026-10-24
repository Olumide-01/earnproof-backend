import { QuotasModule } from "../quotas/quotas.module";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ApiKeyService } from "./api-key.service";
import { ApiKeyUsageService } from "./api-key-usage.service";
import { ApiKeyQuotaService } from "./api-key-quota.service";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { ApiKeyQuotaGuard } from "../common/guards/api-key-quota.guard";
import { RequestSigningGuard } from "../common/guards/request-signing.guard";
import { ScopesGuard } from "../common/guards/scopes.guard";
import { RequestNonceService } from "./request-nonce.service";
import { IntegrationAuthController } from "./integration-auth.controller";
import { AuditModule } from "../audit/audit.module";
import { Clock, SystemClock } from "../common/time/clock";
import { ApiKeyRotationService } from "./api-key-rotation.service";

@Module({
  imports: [AuthModule, QuotasModule, AuditModule],
  controllers: [ApiKeysController, IntegrationAuthController],
  providers: [
    ApiKeyService,
    ApiKeyRotationService,
    ApiKeyUsageService,
    ApiKeyQuotaService,
    ApiKeyGuard,
    ApiKeyQuotaGuard,
    RequestSigningGuard,
    RequestNonceService,
    ScopesGuard,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [
    ApiKeyService,
    ApiKeyRotationService,
    ApiKeyUsageService,
    ApiKeyQuotaService,
    ApiKeyGuard,
    ApiKeyQuotaGuard,
    RequestSigningGuard,
    RequestNonceService,
    ScopesGuard,
  ],
})
export class ApiKeysModule {}