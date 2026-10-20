import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiKeyScope } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

/**
 * API Key Quota Configuration and Enforcement Service
 * 
 * Manages per-API-key, per-scope quota configuration and provides
 * quota checking logic for the enhanced throttler guard.
 * 
 * Design decisions:
 * - Quota states: null = unlimited, 0 = disabled, positive = finite limit
 * - Rolling window quotas with configurable window sizes
 * - Organization and key isolation enforced at query level
 * - Integrates with existing Redis-based rate limiting infrastructure
 */
@Injectable()
export class ApiKeyQuotaService {
  private readonly logger = new Logger(ApiKeyQuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Get quota configuration for an API key and scope.
   * Returns the configured quota limit and window, with fallbacks.
   */
  async getQuotaConfig(
    apiKeyId: string,
    scope: ApiKeyScope,
  ): Promise<{
    quotaLimit: number | null; // null = unlimited, 0 = disabled, positive = limit
    windowSeconds: number;
    isUnlimited: boolean;
    isDisabled: boolean;
  }> {
    try {
      const quota = await this.prisma.apiKeyQuota.findUnique({
        where: {
          apiKeyId_scope: {
            apiKeyId,
            scope,
          },
        },
        select: {
          quotaLimit: true,
          windowSeconds: true,
        },
      });

      if (!quota) {
        // No specific quota configured - use default unlimited
        const defaultWindow = this.configService.get<number>(
          "rateLimit.quotaWindowSeconds",
          3600,
        );
        return {
          quotaLimit: null,
          windowSeconds: defaultWindow,
          isUnlimited: true,
          isDisabled: false,
        };
      }

      return {
        quotaLimit: quota.quotaLimit,
        windowSeconds: quota.windowSeconds,
        isUnlimited: quota.quotaLimit === null,
        isDisabled: quota.quotaLimit === 0,
      };
    } catch (error) {
      this.logger.warn(`Failed to get quota config for key ${apiKeyId}, scope ${scope}:`, error);
      // Fail-safe: return unlimited on error
      return {
        quotaLimit: null,
        windowSeconds: 3600,
        isUnlimited: true,
        isDisabled: false,
      };
    }
  }

  /**
   * Set quota configuration for an API key and scope.
   * Used by API key management endpoints.
   */
  async setQuotaConfig(
    apiKeyId: string,
    scope: ApiKeyScope,
    quotaLimit: number | null,
    windowSeconds = 3600,
  ): Promise<void> {
    try {
      await this.prisma.apiKeyQuota.upsert({
        where: {
          apiKeyId_scope: {
            apiKeyId,
            scope,
          },
        },
        create: {
          apiKeyId,
          scope,
          quotaLimit,
          windowSeconds,
        },
        update: {
          quotaLimit,
          windowSeconds,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(`Failed to set quota config for key ${apiKeyId}, scope ${scope}:`, error);
      throw error;
    }
  }

  /**
   * Get all quota configurations for an API key.
   * Used by API key details endpoints.
   */
  async getKeyQuotas(apiKeyId: string) {
    return this.prisma.apiKeyQuota.findMany({
      where: { apiKeyId },
      select: {
        scope: true,
        quotaLimit: true,
        windowSeconds: true,
        updatedAt: true,
      },
      orderBy: { scope: "asc" },
    });
  }

  /**
   * Remove all quota configurations for an API key.
   * Called when an API key is deleted.
   */
  async deleteKeyQuotas(apiKeyId: string): Promise<void> {
    try {
      await this.prisma.apiKeyQuota.deleteMany({
        where: { apiKeyId },
      });
    } catch (error) {
      this.logger.warn(`Failed to delete quotas for key ${apiKeyId}:`, error);
      // Non-critical operation - don't throw
    }
  }

  /**
   * Generate Redis key for quota tracking.
   * Format: quota:key:{keyId}:scope:{scope}:window:{windowStart}
   */
  generateQuotaKey(
    apiKeyId: string,
    scope: ApiKeyScope,
    windowSeconds: number,
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
    return `quota:key:${apiKeyId}:scope:${scope}:window:${windowStart}`;
  }

  /**
   * Calculate when the current quota window resets.
   */
  getWindowResetTime(windowSeconds: number): Date {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
    const windowEnd = windowStart + windowSeconds;
    return new Date(windowEnd * 1000);
  }
}