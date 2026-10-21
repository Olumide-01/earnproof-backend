import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiKeyScope } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../common/redis/redis.service";

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
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly configService?: ConfigService,
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
        const defaultWindow = this.configService?.get<number>(
          "rateLimit.quotaWindowSeconds",
          3600,
        ) ?? 3600;
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

  async createQuota(
    organizationId: string,
    apiKeyId: string,
    data: { scope: string; quotaLimit: number; quotaWindow: number },
  ) {
    if (data.quotaLimit <= 0 || data.quotaLimit > 1_000_000) {
      throw new BadRequestException("Quota limit out of bounds");
    }
    if (data.quotaWindow < 60 || data.quotaWindow > 86400) {
      throw new BadRequestException("Quota window out of bounds");
    }
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id: apiKeyId },
    });
    if (!apiKey) {
      throw new NotFoundException("API key not found");
    }
    if (apiKey.status !== "ACTIVE") {
      throw new BadRequestException("API key is not active");
    }
    const scopes: string[] = (apiKey as any).scopes ?? [];
    if (!scopes.includes(data.scope)) {
      throw new BadRequestException("Scope not granted to API key");
    }

    return (this.prisma as any).apiKeyQuota.create({
      data: {
        apiKeyId,
        organizationId,
        scope: data.scope,
        quotaLimit: data.quotaLimit,
        quotaWindow: data.quotaWindow,
      },
    });
  }

  async checkQuota(apiKeyId: string, scope: string) {
    const quota = await (this.prisma as any).apiKeyQuota.findUnique({
      where: {
        apiKeyId_scope: { apiKeyId, scope },
      },
    });

    if (!quota) {
      return {
        isAllowed: true,
        currentUsage: 0,
        quotaLimit: null,
        remainingQuota: null,
      };
    }

    const key = `quota:${apiKeyId}:${scope}`;
    let rawUsage: string | null = null;
    try {
      rawUsage = (await this.redis?.get(key)) ?? null;
    } catch {
      rawUsage = null;
    }
    const currentUsage = rawUsage ? parseInt(rawUsage, 10) : 0;
    const remainingQuota = quota.quotaLimit - currentUsage;
    const isAllowed = currentUsage < quota.quotaLimit;

    return {
      isAllowed,
      currentUsage,
      quotaLimit: quota.quotaLimit,
      remainingQuota,
      quotaWindow: quota.quotaWindow ?? 3600,
    };
  }

  async incrementUsage(apiKeyId: string, scope: string) {
    const quota = await (this.prisma as any).apiKeyQuota.findUnique({
      where: {
        apiKeyId_scope: { apiKeyId, scope },
      },
    });

    if (!quota) {
      return { newUsage: 0 };
    }

    const key = `quota:${apiKeyId}:${scope}`;
    try {
      const newUsage = (await this.redis?.incr(key)) ?? 0;
      if (newUsage === 1) {
        await this.redis?.expire(key, quota.quotaWindow ?? 3600);
      }
      return { newUsage };
    } catch {
      return { newUsage: 0 };
    }
  }

  async getQuotas(organizationId: string, apiKeyId: string) {
    return (this.prisma as any).apiKeyQuota.findMany({
      where: { organizationId, apiKeyId },
    });
  }

  async updateQuota(
    organizationId: string,
    quotaId: string,
    data: { quotaLimit?: number; quotaWindow?: number },
  ) {
    const existing = await (this.prisma as any).apiKeyQuota.findUnique({
      where: { id: quotaId, organizationId },
    });
    if (!existing) {
      throw new NotFoundException("Quota not found");
    }

    const updated = await (this.prisma as any).apiKeyQuota.update({
      where: { id: quotaId, organizationId },
      data,
    });

    await this.redis?.del(`quota:${existing.apiKeyId}:${existing.scope}`);
    return updated;
  }

  async deleteQuota(organizationId: string, quotaId: string) {
    const existing = await (this.prisma as any).apiKeyQuota.findUnique({
      where: { id: quotaId, organizationId },
    });
    if (!existing) {
      throw new NotFoundException("Quota not found");
    }

    await (this.prisma as any).apiKeyQuota.delete({
      where: { id: quotaId, organizationId },
    });

    await this.redis?.del(`quota:${existing.apiKeyId}:${existing.scope}`);
  }
}