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

@Module({
  imports: [AuthModule, QuotasModule],
  controllers: [ApiKeysController, IntegrationAuthController],
  providers: [
    ApiKeyService,
    ApiKeyUsageService,
    ApiKeyQuotaService,
    ApiKeyGuard,
    ApiKeyQuotaGuard,
    RequestSigningGuard,
    RequestNonceService,
    ScopesGuard,
  ],
  exports: [
    ApiKeyService,
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