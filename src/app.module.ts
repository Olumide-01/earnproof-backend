import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { AuditModule } from "./audit/audit.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { AuthModule } from "./auth/auth.module";
import { RateLimitModule } from "./common/rate-limit/rate-limit.module";
import { configuration } from "./config/configuration";
import { validateEnv } from "./config/env.validation";
import { CredentialsModule } from "./credentials/credentials.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { HttpMetricsInterceptor } from "./common/interceptors/http-metrics.interceptor";
import { ObservabilityModule } from "./common/observability/observability.module";
import { JobsModule } from "./jobs/jobs.module";
import { MetricsModule } from "./metrics/metrics.module";
import { IssuersModule } from "./issuers/issuers.module";
import { OrganizationsModule } from "./organizations/organizations.module";
import { PaymentsModule } from "./payments/payments.module";
import { ProofsModule } from "./proofs/proofs.module";
import { TrustedSourcesModule } from "./trusted-sources/trusted-sources.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    ObservabilityModule,
    DatabaseModule,
    AuditModule,
    ApiKeysModule,
    AuthModule,
    RateLimitModule,
    HealthModule,
    OrganizationsModule,
    IssuersModule,
    PaymentsModule,
    ProofsModule,
    CredentialsModule,
    TrustedSourcesModule,
    JobsModule,
    MetricsModule,
    WebhooksModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpMetricsInterceptor,
    },
  ],
})
export class AppModule {}
