import { INestApplication, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AuditModule } from "../../../src/audit/audit.module";
import { AuthModule } from "../../../src/auth/auth.module";
import { configuration } from "../../../src/config/configuration";
import { validateEnv } from "../../../src/config/env.validation";
import { DatabaseModule } from "../../../src/database/database.module";
import { ProofsModule } from "../../../src/proofs/proofs.module";
import { WebhooksModule } from "../../../src/webhooks/webhooks.module";
import { OrganizationsModule } from "../../../src/organizations/organizations.module";
import { ApiKeysModule } from "../../../src/api-keys/api-keys.module";
import { HealthModule } from "../../../src/health/health.module";
import { SecurityModule } from "../../../src/security/security.module";
import { UsersModule } from "../../../src/users/users.module";
import { configureApp } from "../../../src/bootstrap";
import { withDeadline } from "../../integration/harness/bounded";
import { integrationConfig } from "../../integration/harness/config";

/**
 * The application surface under e2e test.
 *
 * Deliberately not the real `AppModule`. That module also wires
 * `ScheduleModule.forRoot()` and `JobsModule` (cron sweeps, the anchoring
 * poll loop) and the global `ThrottlerGuard` — background timers and a rate
 * limit that have nothing to do with the request/response flows under test
 * and everything to do with a suite that either hangs on teardown or starts
 * failing requests once a spec sends more than the throttle's burst limit.
 *
 * Every module actually reachable from the auth and proofs HTTP surface is
 * included unchanged — same controllers, same guards, same providers,
 * wired the same way production wires them — so what is tested here is the
 * real request pipeline, not a stand-in for it.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    DatabaseModule,
    AuditModule,
    AuthModule,
    WebhooksModule,
    ProofsModule,
    OrganizationsModule,
    ApiKeysModule,
    HealthModule,
    UsersModule,
    SecurityModule,
  ],
})
class E2eAppModule {}

export interface E2eApp {
  readonly app: INestApplication;
  readonly httpServer: import("http").Server;
}

/**
 * Boots the real HTTP pipeline (guards, pipes, interceptors, the global
 * exception filter — see `src/bootstrap.ts`) against this worker's database,
 * and registers its lifecycle with Jest.
 *
 * Call after `integrationDatabase()` in the same file, same as
 * `test/integration/harness/nest.ts`: that call's `beforeAll` creates the
 * worker database and Jest runs `beforeAll` hooks in registration order.
 */
export function e2eApp(): E2eApp {
  const config = integrationConfig();
  let app: INestApplication | undefined;

  const handle = {
    get app(): INestApplication {
      if (!app) {
        throw new Error(
          "The e2e app is only available inside a test or hook; it is created in beforeAll.",
        );
      }
      return app;
    },
    get httpServer(): import("http").Server {
      return handle.app.getHttpServer();
    },
  };

  beforeAll(async () => {
    app = await withDeadline(
      "Creating the e2e Nest application",
      config.adminTimeoutMs,
      () => NestFactory.create(E2eAppModule, { logger: false }),
    );

    configureApp(app, { corsOrigin: "http://localhost:3000" });

    await withDeadline("Initialising the e2e Nest application", config.adminTimeoutMs, () =>
      app!.init(),
    );
  });

  afterAll(async () => {
    if (!app) return;
    await withDeadline("Closing the e2e Nest application", config.adminTimeoutMs, () =>
      app!.close(),
    );
    app = undefined;
  });

  return handle;
}
