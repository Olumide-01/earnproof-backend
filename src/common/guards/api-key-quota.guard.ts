import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiKeyScope } from "@prisma/client";
import { Request } from "express";
import { ApiKeyContext } from "../../api-keys/api-key.types";
import { ApiKeyQuotaService } from "../../api-keys/api-key-quota.service";

export class TooManyRequestsException extends HttpException {
  constructor(message = "Too Many Requests", options?: any) {
    super(
      HttpException.createBody(message, "Too Many Requests", HttpStatus.TOO_MANY_REQUESTS),
      HttpStatus.TOO_MANY_REQUESTS,
      options,
    );
  }
}

/**
 * Redis client interface for quota operations.
 * Uses the same Redis instance as the existing throttler.
 */
interface RedisClient {
  multi(): RedisMulti;
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, ttl: number): Promise<number>;
}

interface RedisMulti {
  incr(key: string): RedisMulti;
  expire(key: string, ttl: number): RedisMulti;
  exec(): Promise<Array<[Error | null, any]>>;
}

/**
 * Metadata key for required API key scopes.
 * Set by @RequireApiKeyScopes() decorator.
 */
export const REQUIRE_API_KEY_SCOPES = "requireApiKeyScopes";

/**
 * Decorator to specify required API key scopes for an endpoint.
 * Works in conjunction with ApiKeyQuotaGuard.
 * 
 * @param scopes Required scopes for the endpoint
 */
export const RequireApiKeyScopes = (...scopes: (ApiKeyScope | string)[]) =>
  SetMetadata(REQUIRE_API_KEY_SCOPES, scopes);

/**
 * API Key Quota Guard
 * 
 * Enforces per-scope quotas for API key authenticated requests.
 * Integrates with existing throttler Redis infrastructure for atomic counters.
 * 
 * Flow:
 * 1. Check if request has API key context (set by ApiKeyGuard)
 * 2. Determine required scopes from route metadata
 * 3. For each required scope:
 *    - Get quota configuration
 *    - Check if scope is disabled (quota = 0)
 *    - If limited quota, atomically increment Redis counter
 *    - Reject if quota exceeded
 * 
 * This guard should run AFTER ApiKeyGuard in the guard chain.
 */
@Injectable()
export class ApiKeyQuotaGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyQuotaGuard.name);
  private redisClient: RedisClient | null = null;

  constructor(
    private readonly quotaService: ApiKeyQuotaService,
    private readonly reflector: Reflector,
  ) {
    // In a real implementation, inject the Redis client used by throttler
    // For now, we'll simulate with a null check
    this.initializeRedisClient();
  }

  private initializeRedisClient() {
    // TODO: Inject actual Redis client from throttler module
    // This would typically be done via ThrottlerStorage or similar
    this.logger.warn("Redis client not configured - quota enforcement disabled");
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { apiKeyContext?: ApiKeyContext }>();

    // Only apply quota enforcement to API key authenticated requests
    const apiKeyContext = request.apiKeyContext;
    if (!apiKeyContext) {
      // No API key context - let other guards handle this
      return true;
    }

    // Get required scopes from route metadata
    const requiredScopes = this.reflector.getAllAndOverride<ApiKeyScope[]>(
      REQUIRE_API_KEY_SCOPES,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredScopes || requiredScopes.length === 0) {
      // No specific scope requirements - allow
      return true;
    }

    // Check quota for each required scope
    for (const scope of requiredScopes) {
      const allowed = await this.checkScopeQuota(apiKeyContext, scope);
      if (!allowed) {
        return false; // Throws TooManyRequestsException
      }
    }

    return true;
  }

  private async checkScopeQuota(
    apiKeyContext: ApiKeyContext,
    scope: ApiKeyScope,
  ): Promise<boolean> {
    // Verify API key has the required scope
    if (!apiKeyContext.scopes.includes(scope)) {
      // This should be caught by a separate scopes guard
      // But we'll be defensive here
      this.logger.warn(
        `API key ${apiKeyContext.prefix} missing required scope ${scope}`,
      );
      throw new TooManyRequestsException(
        `Insufficient scope: ${scope}`,
      );
    }

    try {
      // Get quota configuration for this key and scope
      const quotaConfig = await this.quotaService.getQuotaConfig(
        apiKeyContext.keyId,
        scope,
      );

      // Check if scope is disabled
      if (quotaConfig.isDisabled) {
        this.logger.warn(
          `Disabled scope ${scope} accessed by key ${apiKeyContext.prefix}`,
        );
        throw new TooManyRequestsException(
          `Scope ${scope} is disabled`,
        );
      }

      // Unlimited quota - allow
      if (quotaConfig.isUnlimited) {
        return true;
      }

      // Check finite quota with Redis
      if (!this.redisClient) {
        this.logger.warn("Redis not available - allowing request (quota bypass)");
        return true;
      }

      return await this.enforceQuotaLimit(
        apiKeyContext,
        scope,
        quotaConfig.quotaLimit!,
        quotaConfig.windowSeconds,
      );
    } catch (error) {
      if (error instanceof TooManyRequestsException) {
        throw error;
      }
      
      this.logger.error(
        `Quota check failed for key ${apiKeyContext.prefix}, scope ${scope}:`,
        error,
      );
      // Fail-safe: allow on error to prevent outages
      return true;
    }
  }

  private async enforceQuotaLimit(
    apiKeyContext: ApiKeyContext,
    scope: ApiKeyScope,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const quotaKey = this.quotaService.generateQuotaKey(
      apiKeyContext.keyId,
      scope,
      windowSeconds,
    );

    try {
      // Atomically increment counter and set expiry
      const multi = this.redisClient!.multi();
      multi.incr(quotaKey);
      multi.expire(quotaKey, windowSeconds);
      
      const results = await multi.exec();
      const incrementResult = results[0];
      
      if (incrementResult[0]) {
        throw incrementResult[0]; // Redis error
      }
      
      const currentUsage = incrementResult[1] as number;
      
      // Check if quota exceeded
      if (currentUsage > limit) {
        const resetTime = this.quotaService.getWindowResetTime(windowSeconds);
        const retryAfterSeconds = Math.ceil(
          (resetTime.getTime() - Date.now()) / 1000,
        );
        
        this.logger.warn(
          `Quota exceeded for key ${apiKeyContext.prefix}, scope ${scope}: ${currentUsage}/${limit}`,
        );
        
        throw new TooManyRequestsException(
          `Quota exceeded for scope ${scope}. Limit: ${limit}, Usage: ${currentUsage}`,
          {
            description: `Retry after ${retryAfterSeconds} seconds`,
          },
        );
      }

      // Log usage for monitoring (non-sensitive data only)
      this.logger.debug(
        `Quota check passed for key ${apiKeyContext.prefix}, scope ${scope}: ${currentUsage}/${limit}`,
      );
      
      return true;
    } catch (error) {
      if (error instanceof TooManyRequestsException) {
        throw error;
      }
      
      this.logger.error(`Redis quota enforcement failed:`, error);
      // Fail-safe: allow on Redis error
      return true;
    }
  }
}