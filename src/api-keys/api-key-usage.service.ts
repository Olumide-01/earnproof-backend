import { Injectable, Logger } from "@nestjs/common";
import { ApiKeyEndpointCategory, ApiKeyUsageOutcome } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

/**
 * Privacy-safe API key usage tracking.
 *
 * Records bounded metadata only: endpoint category (not path), outcome
 * (SUCCESS / FORBIDDEN / ERROR), and a per-minute-rounded timestamp.
 * Never persists IP addresses, request bodies, path parameters, or
 * user-agent strings.
 *
 * Concurrency safety:
 *   All increments use a single atomic SQL upsert (INSERT … ON CONFLICT DO
 *   UPDATE … SET requestCount = requestCount + 1). Concurrent requests for
 *   the same (keyId × category × outcome) bucket converge on one row with
 *   no lost updates and no need for advisory locks.
 *
 * Async / fail-open:
 *   Every public method catches and logs its own errors. Callers (the auth
 *   guard) MUST NOT await these calls so usage recording never delays
 *   request authorisation.
 */
@Injectable()
export class ApiKeyUsageService {
  private readonly logger = new Logger(ApiKeyUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Increment the usage summary bucket for (keyId × category × outcome).
   *
   * The caller should NOT await this — fire and forget so auth is not blocked.
   *
   * lastUsedAt is rounded down to the nearest minute (UTC) so individual
   * request timing cannot be inferred from the stored value.
   */
  async recordUsage(
    keyId: string,
    category: ApiKeyEndpointCategory,
    outcome: ApiKeyUsageOutcome,
  ): Promise<void> {
    try {
      const now = new Date();
      // Round down to the nearest minute to prevent per-request timing reconstruction.
      const lastUsedAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);

      // Atomic upsert: one round-trip, safe under high concurrency.
      // The WHERE clause guards frozen (revoked-key) rows from being updated.
      await this.prisma.$executeRaw`
        INSERT INTO "ApiKeyUsageSummary"
          ("id", "apiKeyId", "category", "outcome", "requestCount", "lastUsedAt", "createdAt", "updatedAt")
        VALUES
          (gen_random_uuid()::text, ${keyId}, ${category}::"ApiKeyEndpointCategory", ${outcome}::"ApiKeyUsageOutcome", 1, ${lastUsedAt}, NOW(), NOW())
        ON CONFLICT ("apiKeyId", "category", "outcome")
        DO UPDATE SET
          "requestCount" = "ApiKeyUsageSummary"."requestCount" + 1,
          "lastUsedAt"   = GREATEST("ApiKeyUsageSummary"."lastUsedAt", EXCLUDED."lastUsedAt"),
          "updatedAt"    = NOW()
        WHERE "ApiKeyUsageSummary"."revokedSummaryFrozenAt" IS NULL
      `;

      // Also keep ApiKey.lastUsedAt in sync for backward compatibility.
      await this.prisma.apiKey.update({
        where: { id: keyId },
        data: { lastUsedAt: now },
      });
    } catch (error) {
      // Fail-open: usage tracking must never block or break request handling.
      this.logger.warn(
        `Failed to record usage for key ${keyId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Freeze all usage summary rows for a revoked key so they become an
   * auditable final snapshot. Called by ApiKeyService.revokeKey().
   *
   * After this call, recordUsage() will no longer update those rows
   * (the WHERE clause in the upsert excludes non-null revokedSummaryFrozenAt).
   */
  async freezeOnRevocation(keyId: string): Promise<void> {
    try {
      const frozenAt = new Date();
      await this.prisma.apiKeyUsageSummary.updateMany({
        where: { apiKeyId: keyId, revokedSummaryFrozenAt: null },
        data: { revokedSummaryFrozenAt: frozenAt },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to freeze usage summaries for key ${keyId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Return all usage summary buckets for a key, ordered by category then outcome.
   * Safe to expose to organisation admins — no PII, no raw paths.
   */
  async getSummary(keyId: string) {
    return this.prisma.apiKeyUsageSummary.findMany({
      where: { apiKeyId: keyId },
      select: {
        category: true,
        outcome: true,
        requestCount: true,
        lastUsedAt: true,
        revokedSummaryFrozenAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ category: "asc" }, { outcome: "asc" }],
    });
  }

  /**
   * Derive an endpoint category from a request path.
   *
   * Deliberately coarse — only the top-level resource segment is used so that
   * no path parameter or query-string value is ever stored.
   */
  static categoryFromPath(path: string): ApiKeyEndpointCategory {
    const segment =
      path.replace(/^\/api\/v\d+\//, "").split("/")[0]?.split("?")[0] ?? "";

    switch (segment) {
      case "proofs":
        return ApiKeyEndpointCategory.PROOF;
      case "payments":
        return ApiKeyEndpointCategory.PAYMENT;
      case "credentials":
        return ApiKeyEndpointCategory.CREDENTIAL;
      case "organizations":
      case "issuers":
      case "trusted-sources":
        return ApiKeyEndpointCategory.ORGANIZATION;
      case "integrations":
        return ApiKeyEndpointCategory.AUTH_CONTEXT;
      default:
        return ApiKeyEndpointCategory.OTHER;
    }
  }
}
