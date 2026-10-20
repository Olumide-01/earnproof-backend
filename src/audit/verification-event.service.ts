import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { VerificationOutcome } from "@prisma/client";
import { createHmac } from "crypto";
import { StructuredLogger } from "../common/logger";
import { Clock, SystemClock } from "../common/time/clock";
import { PrismaService } from "../database/prisma.service";
import type { RetentionImpactReport } from "../jobs/retention/retention-report";

/**
 * Version of the expired-event cleanup rule: delete where `retainUntil < now`.
 *
 * Fixed rather than derived, because the rule has no tunable input — the
 * retention duration is baked into each row's `retainUntil` at write time.
 * Bump it if the selection predicate below ever changes.
 */
export const VERIFICATION_EVENT_CLEANUP_POLICY_VERSION =
  "verification-events-retain-until-v1";

/** Report category for the expired-event cleanup. */
export const VERIFICATION_EVENT_CLEANUP_CATEGORY = "verification_events_expired";

/** Options for {@link VerificationEventService.cleanupExpiredEvents}. */
export interface ExpiredEventCleanupOptions {
  /** Count what would be deleted, writing nothing. */
  dryRun?: boolean;
  /** Evaluation instant; defaults to the injected clock. */
  now?: Date;
}

/**
 * Privacy-safe verification event recording.
 *
 * This service records verification outcomes for aggregate analytics while
 * maintaining strict privacy guarantees:
 *
 * NEVER stored:
 * - Raw IP addresses
 * - User agents
 * - Submitted credentials
 * - Wallet addresses
 * - Proof secrets or raw verification inputs
 *
 * Privacy via metadata hashing:
 * - Only non-identifying metadata (requestId, timestamp) is hashed
 * - Salt rotation every 30 days reduces long-term linkability
 * - Metadata hash is deterministic per salt version (for analytics)
 * - Different salt versions produce different hashes for same metadata
 *
 * Fail-open strategy:
 * - If event recording fails, verification continues unblocked
 * - Errors are logged but never thrown
 * - Ensures verification availability over audit completeness
 */
@Injectable()
export class VerificationEventService {
  private readonly logger = new StructuredLogger(VerificationEventService.name);
  private readonly retentionDays: number;
  private readonly currentSaltVersion: number;
  private readonly salts: Map<number, string>;
  private readonly metadataBudgetPerProof: number;
  private readonly metadataBudgetWindowMs: number;
  private readonly budgetUsage = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    // Not provided by AuditModule; defaults to the system clock. Tests pass a
    // FixedClock (test/time/fixed-clock.ts) to pin the cleanup boundary.
    @Optional() private readonly clock: Clock = new SystemClock(),
  ) {
    this.retentionDays =
      configService.get<number>("verificationEventRetentionDays") || 90;
    this.metadataBudgetPerProof = configService.get<number>(
      "verificationMetadataBudgetPerProof",
      100,
    );
    this.metadataBudgetWindowMs = configService.get<number>(
      "verificationMetadataBudgetWindowMs",
      24 * 60 * 60 * 1000,
    );

    // Use explicitly configured salt version
    // Operators control rotation by incrementing VERIFICATION_HASH_SALT_VERSION env var
    const configuredVersion = configService.get<number>(
      "verificationHashSaltVersion",
    );
    this.currentSaltVersion =
      configuredVersion !== undefined ? configuredVersion : 0;

    // Load all available salts from environment
    // VERIFICATION_HASH_SALT_V0, VERIFICATION_HASH_SALT_V1, etc.
    this.salts = new Map();
    for (let i = 0; i < 100; i++) {
      const saltKey = `VERIFICATION_HASH_SALT_V${i}`;
      const salt = configService.get<string>(saltKey);
      if (salt) {
        this.salts.set(i, salt);
      } else {
        break; // Stop when we hit a missing version
      }
    }

    if (this.salts.size === 0) {
      this.logger.warn("No verification hash salts configured. Using default temporary salt.");
      // Fallback: create a temporary salt from env
      const fallbackSalt = configService.get<string>("credentialSigningSecret");
      if (fallbackSalt) {
        this.salts.set(0, fallbackSalt);
        this.logger.warn(
          "Using credentialSigningSecret as fallback salt V0; configure VERIFICATION_HASH_SALT_V* for production",
        );
      }
    }

    if (!this.salts.has(this.currentSaltVersion)) {
      this.logger.warn(
        `Configured salt version ${this.currentSaltVersion} is not available`,
      );
    }
  }

  /**
   * Record a verification outcome for aggregate analytics.
   *
   * This is the primary entry point. It:
   * 1. Hashes the provided metadata using current salt version
   * 2. Computes retainUntil based on retention configuration
   * 3. Writes to database
   * 4. Fails open: logs errors but never throws
   *
   * @param outcome - The verification result (VALID, EXPIRED, REVOKED, etc.)
   * @param proofId - The proof being verified
   * @param metadata - Metadata to hash (requestId, timestamp, outcome)
   * @param context - Optional access context. `shareTokenId` is the share
   *   token row id (never the raw token or its hash) when the verification
   *   arrived through a share link.
   * @returns Promise that always resolves (never rejects)
   */
  async recordEvent(
    outcome: VerificationOutcome,
    proofId: string,
    metadata: { requestId?: string; timestamp?: Date; outcome: string },
    context: { shareTokenId?: string } = {},
  ): Promise<void> {
    try {
      const saltVersion = this.currentSaltVersion;
      const metadataHash = this.hashMetadata(metadata, saltVersion);
      const retainUntil = new Date(
        Date.now() + this.retentionDays * 24 * 60 * 60 * 1000,
      );

      await this.prisma.verificationEventLog.create({
        data: {
          outcome,
          proofId,
          metadataHash,
          saltVersion,
          retainUntil,
          shareTokenId: context.shareTokenId ?? null,
          createdAt: new Date(),
        },
      });
    } catch (error) {
      // Fail-open: log but do not throw
      this.logger.warn(
        `Failed to record verification event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Consume one bounded metadata slot for a proof. The key is an HMAC held
   * only in memory, so this budget does not create another identifying store.
   */
  tryConsumePrivacyBudget(proofId: string, now = Date.now()): boolean {
    const budgetKey = this.hashBudgetKey(proofId);
    const usage = (this.budgetUsage.get(budgetKey) ?? []).filter(
      (timestamp) => timestamp + this.metadataBudgetWindowMs > now,
    );
    if (usage.length >= this.metadataBudgetPerProof) return false;
    usage.push(now);
    this.budgetUsage.set(budgetKey, usage);
    return true;
  }

  private hashBudgetKey(proofId: string): string {
    const salt = this.salts.get(this.currentSaltVersion) ?? "temporary";
    return createHmac("sha256", salt).update(proofId).digest("hex");
  }

  /**
   * Hash metadata using HMAC-SHA256 with versioned salt.
   *
   * Accepts only non-identifying fields:
   * - requestId: opaque request identifier (no PII)
   * - timestamp: when verification occurred
   * - outcome: the verification result
   *
   * NEVER include:
   * - IP addresses
   * - User agents
   * - Wallet addresses
   * - Proof secrets
   * - Credentials or sensitive data
   *
   * Salt rotation strategy:
   * - Salt version is explicitly configured via VERIFICATION_HASH_SALT_VERSION env var
   * - Operators control rotation by incrementing the version and configuring new salt
   * - Salts must be pre-configured as VERIFICATION_HASH_SALT_V0, VERIFICATION_HASH_SALT_V1, etc.
   * - Different versions produce different hashes for same metadata
   * - This reduces long-term linkability across rotations
   *
   * @param raw - The metadata to hash (only non-identifying fields)
   * @param saltVersion - The salt version to use
   * @returns HMAC-SHA256 hash as hex string
   */
  hashMetadata(
    raw: { requestId?: string; timestamp?: Date; outcome: string },
    saltVersion: number,
  ): string {
    const salt = this.salts.get(saltVersion);
    if (!salt) {
      throw new Error(`No salt configured for version ${saltVersion}`);
    }

    // Canonicalize: timestamp as ISO string, sorted fields
    const canonical = JSON.stringify({
      outcome: raw.outcome,
      requestId: raw.requestId || "unknown",
      timestamp: raw.timestamp?.toISOString() || new Date().toISOString(),
    });

    const hash = createHmac("sha256", salt)
      .update(canonical)
      .digest("hex");

    return hash;
  }

  /**
   * Delete all verification events where retainUntil has passed.
   *
   * Supports automatic retention policy enforcement. This should be called:
   * - Via a cron job (e.g., daily at 2 AM)
   * - Or triggered manually for maintenance
   *
   * With `dryRun`, counts the events that would be deleted and writes nothing.
   *
   * Returns count for auditability; logs all cleanup operations.
   *
   * @returns Number of records deleted (or, in a dry run, that would be)
   */
  async cleanupExpiredEvents(
    options: ExpiredEventCleanupOptions = {},
  ): Promise<number> {
    const report = await this.runExpiredEventsCleanup(options);
    return report.mode === "dry_run"
      ? report.totals.selected
      : report.totals.affected;
  }

  /**
   * The expired-event cleanup with its full impact report.
   */
  async runExpiredEventsCleanup(
    options: ExpiredEventCleanupOptions = {},
  ): Promise<RetentionImpactReport> {
    const dryRun = options.dryRun ?? false;
    const now = options.now ?? this.clock.now();
    const where = expiredEventsFilter(now);
    this.prunePrivacyBudget(now.getTime());

    let selected = 0;
    let affected = 0;
    let failed = false;

    try {
      if (dryRun) {
        selected = await this.prisma.verificationEventLog.count({ where });
        this.logger.log(
          `Verification event cleanup (dry run): ${selected} records eligible (timestamp: ${now.toISOString()})`,
        );
      } else {
        const result = await this.prisma.verificationEventLog.deleteMany({
          where,
        });
        selected = result.count;
        affected = result.count;
        this.logger.log(
          `Verification event cleanup: deleted ${result.count} records (timestamp: ${now.toISOString()})`,
        );
      }
    } catch (error) {
      failed = true;
      this.logger.error("Verification event cleanup failed", error);
    }

    return {
      mode: dryRun ? "dry_run" : "execute",
      policyVersion: VERIFICATION_EVENT_CLEANUP_POLICY_VERSION,
      evaluatedAt: now.toISOString(),
      categories: [
        {
          category: VERIFICATION_EVENT_CLEANUP_CATEGORY,
          cutoff: now.toISOString(),
          cutoffColumn: "retainUntil",
          selected,
          affected,
          truncated: false,
          failed,
          organizations:
            selected > 0 ? [{ organizationId: null, count: selected }] : [],
          otherOrganizations: { buckets: 0, count: 0 },
        },
      ],
      totals: { selected, affected },
    };
  }

  private prunePrivacyBudget(now: number): void {
    for (const [key, timestamps] of this.budgetUsage) {
      const active = timestamps.filter(
        (timestamp) => timestamp + this.metadataBudgetWindowMs > now,
      );
      if (active.length === 0) this.budgetUsage.delete(key);
      else this.budgetUsage.set(key, active);
    }
  }

  /**
   * Get aggregate statistics for a proof's verification outcomes.
   *
   * Returns counts per outcome type. Never includes:
   * - Verifier identity
   * - IP information
   * - Metadata
   * - Any PII
   *
   * This is safe to expose via API endpoints that verify ownership.
   *
   * @param proofId - The proof to analyze
   * @returns Object with counts per outcome: { VALID: n, EXPIRED: n, ... }
   */
  async getAggregateStats(
    proofId: string,
  ): Promise<Record<VerificationOutcome, number>> {
    try {
      const events = await this.prisma.verificationEventLog.findMany({
        where: {
          proofId,
        },
        select: {
          outcome: true,
        },
      });

      // Initialize all outcomes to 0
      const stats: Record<string, number> = {};
      for (const outcome of Object.values(VerificationOutcome)) {
        stats[outcome as string] = 0;
      }

      // Count each outcome
      for (const event of events) {
        stats[event.outcome]++;
      }

      return stats as Record<VerificationOutcome, number>;
    } catch (error) {
      this.logger.error("Failed to get verification stats", error);
      // Return empty stats on error
      const empty: Record<string, number> = {};
      for (const outcome of Object.values(VerificationOutcome)) {
        empty[outcome as string] = 0;
      }
      return empty as Record<VerificationOutcome, number>;
    }
  }

}

/**
 * Selection predicate shared by the dry run and the real cleanup.
 *
 * Strictly less-than: an event whose retainUntil equals `now` is kept.
 */
export function expiredEventsFilter(now: Date): {
  retainUntil: { lt: Date };
} {
  return { retainUntil: { lt: now } };
}
