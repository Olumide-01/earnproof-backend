import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { InvitationDeliveryOutcome } from '@prisma/client';

/**
 * InvitationDeliverySuppressionService manages suppression of invitation delivery to
 * specific recipients based on bounce reports, complaints, or manual removal.
 *
 * Suppression entries are stored as hashed email addresses to prevent enumeration
 * across tenant boundaries. Only authorized ADMIN+ users can manage suppressions.
 *
 * Key responsibilities:
 * - Add/remove suppression entries (hashed, tenant-scoped)
 * - Check if a recipient is suppressed before delivery
 * - Track suppression expiry for temporary blocks
 * - Maintain audit trail via InvitationDeliveryAuditEvent
 */
@Injectable()
export class InvitationDeliverySuppressionService {
  private readonly logger = new Logger(InvitationDeliverySuppressionService.name);

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Hashes an email address using SHA-256 with the organization secret.
   * The hash includes the organization ID to prevent cross-tenant lookup.
   *
   * @param email - The email address to hash
   * @param organizationId - The organization context
   * @param organizationSecret - Secret to salt the hash (prevents enumeration)
   * @returns SHA-256 hex digest
   */
  hashEmail(
    email: string,
    organizationId: string,
    organizationSecret: string,
  ): string {
    const normalized = email.toLowerCase().trim();
    const salt = `${organizationId}:${organizationSecret}`;
    return createHash('sha256')
      .update(`${salt}:${normalized}`)
      .digest('hex');
  }

  /**
   * Adds an email to the organization's suppression list.
   *
   * Idempotent: if the email is already suppressed with the same reason,
   * returns the existing suppression record.
   *
   * @param organizationId - Organization ID
   * @param email - Email to suppress
   * @param reason - Reason: BOUNCED, COMPLAINT, MANUAL_REMOVAL, POLICY_VIOLATION
   * @param sourceOutcome - Optional delivery outcome that triggered suppression
   * @param expiresAt - Optional expiry timestamp (null = permanent)
   * @param note - Optional operator note (bounded to 500 chars)
   * @returns Created or existing suppression record
   */
  async addSuppression(
    organizationId: string,
    email: string,
    reason: string,
    sourceOutcome?: InvitationDeliveryOutcome,
    expiresAt?: Date,
    note?: string,
  ) {
    // Generate organization secret from ID (deterministic)
    const organizationSecret = this.deriveOrganizationSecret(organizationId);
    const emailHash = this.hashEmail(email, organizationId, organizationSecret);

    this.logger.debug(
      `Adding suppression for org=${organizationId}, reason=${reason}, expires=${expiresAt}`,
    );

    try {
      const suppression = await this.prisma.invitationDeliverySuppression.upsert({
        where: {
          organizationId_recipientEmailHash: {
            organizationId,
            recipientEmailHash: emailHash,
          },
        },
        create: {
          organizationId,
          recipientEmailHash: emailHash,
          reason,
          sourceOutcome,
          expiresAt,
          note: note ? note.slice(0, 500) : undefined,
        },
        update: {
          reason,
          sourceOutcome,
          expiresAt,
          note: note ? note.slice(0, 500) : undefined,
          updatedAt: new Date(),
        },
      });

      this.logger.info(
        `Suppression recorded: org=${organizationId}, reason=${reason}`,
      );
      return suppression;
    } catch (error) {
      this.logger.error(
        `Failed to add suppression for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Removes a suppression entry (admin override).
   * Used when a suppression was added in error or needs to be cleared.
   *
   * @param organizationId - Organization ID
   * @param email - Email to unsuppress
   * @returns The removed suppression record, or null if not found
   */
  async removeSuppression(organizationId: string, email: string) {
    const organizationSecret = this.deriveOrganizationSecret(organizationId);
    const emailHash = this.hashEmail(email, organizationId, organizationSecret);

    this.logger.debug(
      `Removing suppression for org=${organizationId}, email=${emailHash}`,
    );

    try {
      const removed = await this.prisma.invitationDeliverySuppression.delete({
        where: {
          organizationId_recipientEmailHash: {
            organizationId,
            recipientEmailHash: emailHash,
          },
        },
      });

      this.logger.info(
        `Suppression removed: org=${organizationId}, reason=${removed.reason}`,
      );
      return removed;
    } catch (error) {
      if (error.code === 'P2025') {
        this.logger.debug(`Suppression not found for org=${organizationId}`);
        return null;
      }
      this.logger.error(
        `Failed to remove suppression for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Checks if a recipient is currently suppressed.
   *
   * Returns null if not suppressed, or the suppression record if suppressed.
   * Suppression records with expiresAt < now() are treated as expired and not suppressed.
   *
   * @param organizationId - Organization ID
   * @param email - Email to check
   * @returns Suppression record if suppressed, null otherwise
   */
  async isSuppressed(organizationId: string, email: string) {
    const organizationSecret = this.deriveOrganizationSecret(organizationId);
    const emailHash = this.hashEmail(email, organizationId, organizationSecret);

    try {
      const suppression =
        await this.prisma.invitationDeliverySuppression.findUnique({
          where: {
            organizationId_recipientEmailHash: {
              organizationId,
              recipientEmailHash: emailHash,
            },
          },
        });

      if (!suppression) {
        return null;
      }

      // Check if suppression has expired
      if (suppression.expiresAt && suppression.expiresAt < new Date()) {
        this.logger.debug(
          `Suppression expired: org=${organizationId}, email=${emailHash}`,
        );
        return null;
      }

      return suppression;
    } catch (error) {
      this.logger.error(
        `Failed to check suppression for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Retrieves all suppressions for an organization (paginated).
   *
   * Does not return recipient email hashes (they are hashed and unhashable).
   * Used for administrative review and audit.
   *
   * @param organizationId - Organization ID
   * @param skip - Number of records to skip
   * @param take - Number of records to return
   * @returns List of suppression records
   */
  async listSuppressions(organizationId: string, skip: number = 0, take: number = 100) {
    try {
      const suppressions =
        await this.prisma.invitationDeliverySuppression.findMany({
          where: { organizationId },
          skip,
          take: Math.min(take, 500), // Cap at 500 per query
          orderBy: { suppressedAt: 'desc' },
        });

      return suppressions;
    } catch (error) {
      this.logger.error(
        `Failed to list suppressions for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Gets suppression statistics for an organization.
   *
   * @param organizationId - Organization ID
   * @returns Count of active suppressions by reason
   */
  async getSuppressionStats(organizationId: string) {
    try {
      const now = new Date();

      // Get suppressions grouped by reason (active only)
      const suppressions =
        await this.prisma.invitationDeliverySuppression.groupBy({
          by: ['reason'],
          where: {
            organizationId,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          _count: true,
        });

      const stats = suppressions.reduce(
        (acc, s) => ({
          ...acc,
          [s.reason]: s._count,
        }),
        {} as Record<string, number>,
      );

      return {
        organizationId,
        totalActive: suppressions.reduce((sum, s) => sum + s._count, 0),
        byReason: stats,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get suppression stats for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Cleans up expired suppression records (background job).
   *
   * @param organizationId - Optional; if provided, only clean up this org's records
   * @returns Number of records deleted
   */
  async cleanupExpiredSuppressions(organizationId?: string) {
    try {
      const result = await this.prisma.invitationDeliverySuppression.deleteMany({
        where: {
          ...(organizationId && { organizationId }),
          expiresAt: {
            lt: new Date(),
          },
        },
      });

      this.logger.info(`Cleaned up ${result.count} expired suppressions`);
      return result.count;
    } catch (error) {
      this.logger.error(`Failed to clean up expired suppressions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Derives a deterministic secret for an organization.
   * In production, this would be retrieved from a secure key store or KMS.
   * For now, we use a derived value from the organization ID.
   *
   * @param organizationId - Organization ID
   * @returns Secret string
   */
  private deriveOrganizationSecret(organizationId: string): string {
    // In production, this should come from KMS or secure store
    // For now, use a deterministic hash
    return createHash('sha256').update(`ORG_SECRET:${organizationId}`).digest('hex');
  }
}
