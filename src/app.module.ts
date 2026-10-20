import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_INTERCEPTOR, DiscoveryModule } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { AuditModule } from "./audit/audit.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { ApprovalsModule } from "./approvals/approvals.module";
import { AuthModule } from "./auth/auth.module";
import { RateLimitModule } from "./common/rate-limit/rate-limit.module";
import { ConsentModule } from "./common/consent/consent.module";
import { DisclosureModule } from "./common/disclosure/disclosure.module";
import { AuthorizationPolicyRegistry } from "./common/guards/authorization-policy.registry";
import { CommonModule } from "./common/common.module";
import { configuration } from "./config/configuration";
import { validateEnv } from "./config/env.validation";
import { CredentialsModule } from "./credentials/credentials.module";
import { DatabaseModule } from "./database/database.module";
import { DisputesModule } from "./disputes/disputes.module";
import { HealthModule } from "./health/health.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { HttpMetricsInterceptor } from "./common/interceptors/http-metrics.interceptor";
import { IdempotentInterceptor } from "./common/interceptors/idempotent.interceptor";
import { ObservabilityModule } from "./common/observability/observability.module";
import { ResilienceModule } from "./common/resilience/resilience.module";
import { JobsModule } from "./jobs/jobs.module";
import { IssuersModule } from "./issuers/issuers.module";
import { OrganizationsModule } from "./organizations/organizations.module";
import { DataResidencyModule } from "./organizations/residency/data-residency.module";
import { PaymentsModule } from "./payments/payments.module";
import { ProofsModule } from "./proofs/proofs.module";
import { SchemaImportsModule } from "./schemas/schema-imports.module";
import { TrustedSourcesModule } from "./trusted-sources/trusted-sources.module";
import { UsersModule } from "./users/users.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { SupportedAssetsModule } from "./supported-assets/supported-assets.module";
import { GovernanceModule } from "./governance/governance.module";
import { SupportAccessModule } from "./support-access/support-access.module";
import { ReconciliationModule } from "./reconciliation/reconciliation.module";
import { DeploymentsModule } from "./deployments/deployments.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { SecurityModule } from "./security/security.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    DiscoveryModule,
    ObservabilityModule,
    ResilienceModule,
    DatabaseModule,
    CommonModule,
    ConsentModule,
    DisclosureModule,
    AuditModule,
    ApiKeysModule,
    ApprovalsModule,
    AuthModule,
    RateLimitModule,
    DisputesModule,
    HealthModule,
    IntegrationsModule,
    OrganizationsModule,
    DataResidencyModule,
    IssuersModule,
    PaymentsModule,
    ProofsModule,
    CredentialsModule,
    SchemaImportsModule,
    TrustedSourcesModule,
    UsersModule,
    JobsModule,
    WebhooksModule,
    SupportedAssetsModule,
    GovernanceModule,
    SupportAccessModule,
    ReconciliationModule,
    DeploymentsModule,
    NotificationsModule,
    SecurityModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpMetricsInterceptor,
    },
    AuthorizationPolicyRegistry,
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotentInterceptor,
    },
  ],
})
export class AppModule {}
