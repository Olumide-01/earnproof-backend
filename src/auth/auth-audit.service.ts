import { Injectable } from "@nestjs/common";
import { AuthEventType } from "@prisma/client";
import { createHash } from "crypto";
import { StructuredLogger } from "../common/logger";
import { PrismaService } from "../database/prisma.service";

/**
 * Privacy-safe authentication audit event recording.
 *
 * This service records authentication events for security monitoring and
 * abuse detection while maintaining strict privacy guarantees:
 *
 * NEVER stored:
 * - Raw IP addresses
 * - User agents or raw client metadata
 * - Challenge messages or signatures
 * - Wallet addresses (only SHA-256 hashes)
 *
 * Privacy via hashing:
 * - Wallet addresses are hashed with SHA-256
 * - Client metadata (if provided) is hashed with SHA-256
 * - Hashes are deterministic for rate limiting but not reversible
 *
 * Fail-open strategy:
 * - If audit recording fails, authentication continues unblocked
 * - Errors are logged but never thrown
 * - Ensures authentication availability over audit completeness
 */
@Injectable()
export class AuthAuditService {
  private readonly logger = new StructuredLogger(AuthAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record an authentication audit event.
   *
   * This is the primary entry point. It:
   * 1. Hashes sensitive identifiers (wallet address, client metadata)
   * 2. Writes to database
   * 3. Fails open: logs errors but never throws
   *
   * @param eventType - The type of auth event (CHALLENGE_CREATED, CHALLENGE_VERIFIED, etc.)
   * @param walletAddress - The wallet address (will be hashed)
   * @param options - Additional event context
   * @returns Promise that always resolves (never rejects)
   */
  async recordEvent(
    eventType: AuthEventType,
    walletAddress: string,
    options: {
      challengeId?: string;
      success: boolean;
      failureReason?: string;
      clientMetadata?: string;
    },
  ): Promise<void> {
    try {
      const walletHash = `sha256:${this.hashData(walletAddress)}`;
      const clientMetadataHash = options.clientMetadata
        ? `sha256:${this.hashData(options.clientMetadata)}`
        : undefined;

      await this.prisma.authAuditEvent.create({
        data: {
          eventType,
          walletHash,
          clientMetadataHash,
          challengeId: options.challengeId,
          success: options.success,
          failureReason: options.failureReason,
          createdAt: new Date(),
        },
      });
    } catch (error) {
      // Fail-open: log but do not throw
      this.logger.warn(
        `Failed to record auth audit event (${eventType}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Hash data using SHA-256.
   *
   * This produces a deterministic, non-reversible hash suitable for:
   * - Rate limiting (same input always produces same hash)
   * - Privacy protection (hash cannot be reversed to original value)
   *
   * @param data - The data to hash
   * @returns SHA-256 hash as hex string
   */
  private hashData(data: string): string {
    return createHash("sha256").update(data, "utf8").digest("hex");
  }

  /**
   * Get count of events for a wallet within a time window.
   *
   * Used for rate limiting. Returns only aggregated counts, never individual events.
   *
   * @param walletAddress - The wallet address (will be hashed)
   * @param eventType - The event type to count
   * @param windowMs - Time window in milliseconds
   * @returns Count of matching events
   */
  async getEventCount(
    walletAddress: string,
    eventType: AuthEventType,
    windowMs: number,
  ): Promise<number> {
    try {
      const walletHash = `sha256:${this.hashData(walletAddress)}`;
      const since = new Date(Date.now() - windowMs);

      const count = await this.prisma.authAuditEvent.count({
        where: {
          walletHash,
          eventType,
          createdAt: {
            gte: since,
          },
        },
      });

      return count;
    } catch (error) {
      this.logger.error(
        `Failed to get event count for wallet: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Return 0 on error to fail-open (don't block auth on audit failure)
      return 0;
    }
  }

  /**
   * Get count of events for client metadata within a time window.
   *
   * Used for rate limiting based on client fingerprint.
   *
   * @param clientMetadata - The client metadata (will be hashed)
   * @param eventType - The event type to count
   * @param windowMs - Time window in milliseconds
   * @returns Count of matching events
   */
  async getClientEventCount(
    clientMetadata: string,
    eventType: AuthEventType,
    windowMs: number,
  ): Promise<number> {
    try {
      const clientMetadataHash = `sha256:${this.hashData(clientMetadata)}`;
      const since = new Date(Date.now() - windowMs);

      const count = await this.prisma.authAuditEvent.count({
        where: {
          clientMetadataHash,
          eventType,
          createdAt: {
            gte: since,
          },
        },
      });

      return count;
    } catch (error) {
      this.logger.error(
        `Failed to get client event count: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Return 0 on error to fail-open
      return 0;
    }
  }

  /**
   * Delete all auth audit events older than the specified age.
   *
   * Supports automatic retention policy enforcement. Should be called:
   * - Via a cron job (e.g., daily at 2 AM)
   * - Or triggered manually for maintenance
   *
   * @param retentionDays - Number of days to retain events
   * @returns Number of records deleted
   */
  async cleanupOldEvents(retentionDays: number): Promise<number> {
    try {
      const cutoffDate = new Date(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000,
      );

      const result = await this.prisma.authAuditEvent.deleteMany({
        where: {
          createdAt: {
            lt: cutoffDate,
          },
        },
      });

      this.logger.log(
        `Auth audit cleanup: deleted ${result.count} records older than ${cutoffDate.toISOString()}`,
      );

      return result.count;
    } catch (error) {
      this.logger.error(
        `Auth audit cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }
}
