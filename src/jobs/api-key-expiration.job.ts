import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ResourceStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { ApiKeyUsageService } from "../api-keys/api-key-usage.service";
import { ApiKeyService } from "../api-keys/api-key.service";
import { Clock } from "../common/time/clock";

/**
 * API Key Expiration Job
 *
 * Scheduled background job that sweeps and revokes expired API keys.
 *
 * Requirements & Acceptance Criteria:
 * 1. Database time semantics: Evaluation relies on database timestamp or injected Clock.
 * 2. Exact expiration boundary: Keys are revoked when dbNow >= expiresAt (lte: dbNow in query).
 * 3. Multi-worker safety: Uses conditional atomic updateMany (status: ACTIVE -> REVOKED).
 *    Only the worker that transitions the row emits an audit event and freezes usage summaries.
 * 4. Privacy: Audit events never include secrets, hashes, or key material.
 * 5. Idempotent & Reentrant: Safe to run concurrently or repeatedly across distributed instances.
 */
@Injectable()
export class ApiKeyExpirationJob {
  private readonly logger = new Logger(ApiKeyExpirationJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeyUsageService: ApiKeyUsageService,
    @Optional() private readonly apiKeyService?: ApiKeyService,
    @Optional() private readonly clock?: Clock,
  ) {}

  /**
   * Sweeps and revokes all active API keys whose expiration boundary has passed.
   *
   * @param now Optional override instant for testing and deterministic evaluation.
   * @returns Total number of keys transitioned to REVOKED in this run.
   */
  @Cron(process.env.API_KEY_EXPIRATION_CRON ?? CronExpression.EVERY_5_MINUTES)
  async sweep(now?: Date): Promise<number> {
    const dbNow = now ?? (await this.getEffectiveTime());

    // Find candidate keys whose expiration boundary has been reached or passed
    const expiredCandidates = await this.prisma.apiKey.findMany({
      where: {
        status: ResourceStatus.ACTIVE,
        expiresAt: { lte: dbNow },
      },
      select: {
        id: true,
        prefix: true,
        name: true,
        organizationId: true,
        expiresAt: true,
      },
    });

    if (expiredCandidates.length === 0) {
      return 0;
    }

    let revokedCount = 0;

    for (const key of expiredCandidates) {
      // Multi-worker safe: atomic conditional update transitions status ONLY if still ACTIVE
      const updateResult = await this.prisma.apiKey.updateMany({
        where: {
          id: key.id,
          status: ResourceStatus.ACTIVE,
        },
        data: {
          status: ResourceStatus.REVOKED,
          revokedAt: dbNow,
        },
      });

      // If count === 0, another concurrent worker already revoked this key
      if (updateResult.count === 0) {
        continue;
      }

      revokedCount++;

      // Invalidate memory cache so instances stop using the key immediately
      this.apiKeyService?.invalidateKeyCache(key.id);

      // Freeze usage summary snapshots
      try {
        await this.apiKeyUsageService.freezeOnRevocation(key.id);
      } catch (err) {
        this.logger.warn(
          `Failed to freeze usage summary for expired key ${key.id}: ${String(err)}`,
        );
      }

      // Emit audit event without logging any key material
      try {
        await this.prisma.auditLog.create({
          data: {
            actorType: "system",
            actorId: "api-key-expiration-job",
            action: "api_key.revoked",
            resourceType: "api_key",
            resourceId: key.id,
            metadata: {
              prefix: key.prefix,
              name: key.name,
              organizationId: key.organizationId,
              revokedAt: dbNow.toISOString(),
              expiresAt: key.expiresAt?.toISOString() ?? null,
              reason: "expired",
            },
          },
        });
      } catch (err) {
        this.logger.error(
          `Failed to emit audit event for expired key ${key.id}: ${String(err)}`,
        );
      }
    }

    if (revokedCount > 0) {
      this.logger.log(`Revoked ${revokedCount} expired API key(s)`);
    }

    return revokedCount;
  }

  private async getEffectiveTime(): Promise<Date> {
    if (this.clock) {
      return this.clock.now();
    }
    if (this.apiKeyService) {
      return this.apiKeyService.getDatabaseTime();
    }
    try {
      const rows = await this.prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT CURRENT_TIMESTAMP as now
      `;
      if (rows && rows.length > 0 && rows[0].now) {
        return new Date(rows[0].now);
      }
    } catch {
      // fallback
    }
    return new Date();
  }
}
