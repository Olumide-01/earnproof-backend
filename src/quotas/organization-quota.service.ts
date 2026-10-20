import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, ResourceStatus } from "@prisma/client";
import { METRIC_NAMES } from "../common/observability/metrics.catalog";
import { MetricsRegistry } from "../common/observability/metrics.registry";
import { PrismaService } from "../database/prisma.service";
import {
  ConcurrentQuota,
  DEFAULT_QUOTA_LIMITS,
  QUOTA_WINDOWS,
  QuotaExceededException,
  QuotaKind,
  QuotaLimits,
  WindowedQuota,
  windowStart,
} from "./quota.types";

/** A Prisma client or interactive-transaction client. */
type Db = Prisma.TransactionClient;

/**
 * Per-organization operational quotas (#160).
 *
 * Enforcement is atomic at the mutation boundary and always runs inside the
 * caller's transaction, so a rejection leaves no partial change and a
 * concurrent burst cannot overshoot a limit:
 *
 * - Concurrent quotas take `SELECT … FOR UPDATE` on the organization row,
 *   then count and insert under that lock. Every quota-checked creation for
 *   the organization serializes behind it.
 * - Windowed quotas use one `INSERT … ON CONFLICT DO UPDATE … WHERE count <
 *   limit RETURNING`. The row lock taken by the upsert serializes concurrent
 *   increments; an empty result means the limit was already reached.
 */
@Injectable()
export class OrganizationQuotaService {
  private readonly limits: QuotaLimits;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly metrics: MetricsRegistry,
  ) {
    const get = (key: string, fallback: number) =>
      configService.get<number>(`quotas.${key}`) ?? fallback;
    this.limits = {
      api_keys: get("maxActiveApiKeys", DEFAULT_QUOTA_LIMITS.api_keys),
      webhooks: get("maxWebhooks", DEFAULT_QUOTA_LIMITS.webhooks),
      proof_requests: get(
        "proofRequestsPerDay",
        DEFAULT_QUOTA_LIMITS.proof_requests,
      ),
      sync_frequency: get("syncsPerHour", DEFAULT_QUOTA_LIMITS.sync_frequency),
    };
  }

  limitFor(quota: QuotaKind): number {
    return this.limits[quota];
  }

  /**
   * Assert there is room for one more resource. Must be called inside the
   * transaction that performs the creation; the lock is held until commit.
   */
  async assertCapacity(
    tx: Db,
    organizationId: string,
    quota: ConcurrentQuota,
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;

    const used = await this.countConcurrent(tx, organizationId, quota);
    const limit = this.limits[quota];
    if (used >= limit) {
      this.reject(quota, limit, null);
    }
  }

  /** Consume one unit of a windowed quota, or reject. */
  async consume(
    tx: Db,
    organizationId: string,
    quota: WindowedQuota,
    now = new Date(),
  ): Promise<void> {
    const limit = this.limits[quota];
    const start = windowStart(quota, now);

    const rows = await tx.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "OrganizationQuotaUsage" ("organizationId", "quota", "windowStart", "count", "updatedAt")
      VALUES (${organizationId}, ${quota}, ${start}, 1, NOW())
      ON CONFLICT ("organizationId", "quota", "windowStart")
      DO UPDATE SET "count" = "OrganizationQuotaUsage"."count" + 1, "updatedAt" = NOW()
      WHERE "OrganizationQuotaUsage"."count" < ${limit}
      RETURNING "count"`;

    if (rows.length === 0) {
      this.reject(
        quota,
        limit,
        new Date(start.getTime() + QUOTA_WINDOWS[quota].ms),
      );
    }
  }

  /**
   * Consume a windowed quota on behalf of the organization a user acts for.
   * Users outside any active organization are not subject to organization
   * quotas; see docs/quotas.md.
   */
  async consumeForUser(
    tx: Db,
    userId: string,
    quota: WindowedQuota,
    now = new Date(),
  ): Promise<string | null> {
    const organizationId = await this.resolveOrganizationForUser(tx, userId);
    if (!organizationId) return null;
    await this.consume(tx, organizationId, quota, now);
    return organizationId;
  }

  /**
   * The organization a user's operations are charged to: the oldest ACTIVE
   * organization they administer. Deterministic, matching the webhook
   * module's organization resolution.
   */
  async resolveOrganizationForUser(
    db: Db,
    userId: string,
  ): Promise<string | null> {
    const org = await db.organization.findFirst({
      where: { createdById: userId, status: ResourceStatus.ACTIVE },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    return org?.id ?? null;
  }

  /** Non-sensitive usage report with reset context. Counts only. */
  async getUsage(organizationId: string, now = new Date()) {
    const [apiKeys, webhooks, windowed] = await Promise.all([
      this.countConcurrent(this.prisma, organizationId, "api_keys", now),
      this.countConcurrent(this.prisma, organizationId, "webhooks", now),
      this.prisma.organizationQuotaUsage.findMany({
        where: {
          organizationId,
          OR: (["proof_requests", "sync_frequency"] as const).map((quota) => ({
            quota,
            windowStart: windowStart(quota, now),
          })),
        },
        select: { quota: true, count: true },
      }),
    ]);

    const concurrent = (quota: ConcurrentQuota, used: number) => ({
      quota,
      type: "concurrent" as const,
      limit: this.limits[quota],
      used,
      remaining: Math.max(0, this.limits[quota] - used),
      window: null,
      windowStart: null,
      resetsAt: null,
    });
    const rate = (quota: WindowedQuota) => {
      const used = windowed.find((w) => w.quota === quota)?.count ?? 0;
      const start = windowStart(quota, now);
      return {
        quota,
        type: "windowed" as const,
        limit: this.limits[quota],
        used,
        remaining: Math.max(0, this.limits[quota] - used),
        window: QUOTA_WINDOWS[quota].iso,
        windowStart: start.toISOString(),
        resetsAt: new Date(start.getTime() + QUOTA_WINDOWS[quota].ms).toISOString(),
      };
    };

    return {
      organizationId,
      generatedAt: now.toISOString(),
      quotas: [
        concurrent("api_keys", apiKeys),
        concurrent("webhooks", webhooks),
        rate("proof_requests"),
        rate("sync_frequency"),
      ],
    };
  }

  private countConcurrent(
    db: Db,
    organizationId: string,
    quota: ConcurrentQuota,
    now = new Date(),
  ): Promise<number> {
    if (quota === "api_keys") {
      // Matches what the API key guard accepts: active and not expired.
      return db.apiKey.count({
        where: {
          organizationId,
          status: ResourceStatus.ACTIVE,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      });
    }
    // Disabled endpoints still count: re-enabling one must not exceed the cap.
    return db.webhook.count({
      where: { organizationId, status: { not: ResourceStatus.DELETED } },
    });
  }

  private reject(quota: QuotaKind, limit: number, resetsAt: Date | null): never {
    this.metrics.increment(METRIC_NAMES.quotaRejectionsTotal, { quota });
    throw new QuotaExceededException(quota, limit, resetsAt);
  }
}
