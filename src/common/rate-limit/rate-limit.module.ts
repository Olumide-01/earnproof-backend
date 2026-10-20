import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "../../auth/auth.module";
import { ApiKeysModule } from "../../api-keys/api-keys.module";
import { RoleAwareThrottlerGuard } from "../guards/rate-limit.guard";

/**
 * Global API rate limiting (#112).
 *
 * Three named throttlers, all env-configurable (configuration.ts's
 * `rateLimit`), matched against a request in the order they're declared —
 * `@nestjs/throttler` checks every throttler for a request and applies the
 * TIGHTEST one that has an explicit `@Throttle()` override, falling back to
 * whichever throttlers a route doesn't override:
 *
 *   - "default"      — the global ceiling for anything not overridden below.
 *   - "strict"        — expensive operations (proof creation, payment sync).
 *                        Applied via `@Throttle({ strict: {} })` on those
 *                        two routes specifically (see proofs.controller.ts /
 *                        payments.controller.ts).
 *   - "verification"  — the public proof-verification lookup. Applied via
 *                        `@Throttle({ verification: {} })` on that one route.
 *
 * `RoleAwareThrottlerGuard` (not the stock `ThrottlerGuard`) is registered
 * as the global guard so every route gets rate limiting by default — a new
 * controller doesn't have to remember to add it. Health checks are exempt
 * via `@SkipThrottle()` directly on `HealthController` rather than a
 * blanket path exclusion here, so the exemption is visible right next to
 * the route it applies to.
 *
 * API Key Quota Integration:
 * The quota guard works alongside this rate limiting system:
 * - Global rate limits apply to all requests (IP-based for anonymous, user-based for session auth)
 * - API key quotas apply per-scope limits on top of global limits
 * - Both must pass for a request to proceed
 */
@Module({
  imports: [
    ConfigModule,
    AuthModule,
    ApiKeysModule, // Import for quota integration
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: "default",
            ttl: config.get<number>("rateLimit.defaultTtlMs", 60_000),
            limit: config.get<number>("rateLimit.defaultLimit", 100),
          },
          {
            name: "strict",
            ttl: config.get<number>("rateLimit.strictTtlMs", 60_000),
            limit: config.get<number>("rateLimit.strictLimit", 10),
          },
          {
            name: "verification",
            ttl: config.get<number>("rateLimit.verificationTtlMs", 60_000),
            limit: config.get<number>("rateLimit.verificationLimit", 30),
          },
        ],
        // Emits X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset
        // on every response so a well-behaved client can back off before it
        // ever gets a 429 — Retry-After on the 429 itself is also added by
        // the base ThrottlerGuard (see rate-limit.guard.ts) whenever this is
        // true, with no extra code needed on our end.
        setHeaders: true,
      }),
    }),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: RoleAwareThrottlerGuard,
    },
  ],
})
export class RateLimitModule {}
