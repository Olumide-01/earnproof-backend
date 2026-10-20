import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import {
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerRequest,
  ThrottlerStorage,
} from "@nestjs/throttler";
import { Request } from "express";
import { SessionIdentity, SessionService } from "../../auth/session.service";
import {
  THROTTLE_COST_KEY,
  ThrottleCostResolver,
} from "../rate-limit/throttle-cost.decorator";

const RATE_LIMIT_SESSION_CACHE = Symbol("rateLimitSessionCache");

type RateLimitRequest = Request & {
  [RATE_LIMIT_SESSION_CACHE]?: Promise<SessionIdentity | null>;
};

/**
 * Role-aware global throttling.
 *
 * The stock throttler resolves fixed named limits at startup. This guard keeps
 * those configured limits as the base tier, then multiplies the active limit
 * when the bearer token maps to a live persisted session. Missing, malformed,
 * expired, revoked, or temporarily unresolved tokens fall back to the
 * anonymous IP bucket and are never rejected here; route-level AuthGuard owns
 * authentication enforcement.
 */
@Injectable()
export class RoleAwareThrottlerGuard extends ThrottlerGuard {
  private readonly authenticatedMultiplier: number;

  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    configService: ConfigService,
    private readonly sessionService: SessionService,
  ) {
    super(options, storageService, reflector);
    this.authenticatedMultiplier = configService.get<number>(
      "rateLimit.authenticatedMultiplier",
      1,
    );
  }

  private authenticatedSession(
    request: RateLimitRequest,
  ): Promise<SessionIdentity | null> {
    const cached = request[RATE_LIMIT_SESSION_CACHE];
    if (cached) return cached;

    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return Promise.resolve(null);
    }

    const lookup = this.sessionService.tryIdentify(
      header.slice("Bearer ".length),
    );
    request[RATE_LIMIT_SESSION_CACHE] = lookup;
    return lookup;
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as RateLimitRequest;
    const session = await this.authenticatedSession(request);
    return session ? `user:${session.userId}` : `ip:${request.ip}`;
  }

  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const request = requestProps.context
      .switchToHttp()
      .getRequest<RateLimitRequest>();
    const isAuthenticated = Boolean(await this.authenticatedSession(request));

    const limit =
      isAuthenticated && this.authenticatedMultiplier > 1
        ? Math.floor(requestProps.limit * this.authenticatedMultiplier)
        : requestProps.limit;

    // A batch route declares a per-request cost (its item count) via
    // @ThrottleCost. Charge the bucket that cost so a batch of N is throttled
    // as N single verifications, not as one call. Pre-charge cost-1 hits
    // against the same key, then let the base guard apply the final hit and
    // decide — so the 429, the Retry-After, and the X-RateLimit headers all
    // reflect the true consumption with no logic duplicated here.
    const cost = this.resolveCost(request, requestProps);
    if (cost > 1) {
      const throttlerName = requestProps.throttler.name ?? "default";
      const tracker = await requestProps.getTracker(
        request,
        requestProps.context,
      );
      const key = requestProps.generateKey(
        requestProps.context,
        tracker,
        throttlerName,
      );
      for (let i = 0; i < cost - 1; i += 1) {
        await this.storageService.increment(
          key,
          requestProps.ttl,
          limit,
          requestProps.blockDuration,
          throttlerName,
        );
      }
    }

    return super.handleRequest({ ...requestProps, limit });
  }

  /**
   * The throttle cost of a request: 1 for an ordinary route, or the value the
   * route's @ThrottleCost resolver derives from the (already validated, already
   * bounded) request body. Clamped to at least 1 and never allowed to be a
   * non-finite number, so a resolver bug cannot make a request free or infinite.
   */
  private resolveCost(
    request: RateLimitRequest,
    requestProps: ThrottlerRequest,
  ): number {
    const resolver = this.reflector.getAllAndOverride<
      ThrottleCostResolver | undefined
    >(THROTTLE_COST_KEY, [
      requestProps.context.getHandler(),
      requestProps.context.getClass(),
    ]);
    if (!resolver) return 1;

    const raw = resolver(request);
    if (!Number.isFinite(raw)) return 1;
    return Math.max(1, Math.floor(raw));
  }
}
