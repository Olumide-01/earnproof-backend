import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient, InvitationDeliveryOutcome } from '@prisma/client';
import { createHash } from 'crypto';

/**
 * InvitationDeliveryOutcomeService tracks delivery outcomes and manages
 * suppression triggered by delivery failures, bounces, or complaints.
 *
 * Responsibilities:
 * - Record delivery outcomes (SENT, BOUNCED, COMPLAINT, FAILED, etc.)
 * - Trigger suppression on BOUNCED or COMPLAINT outcomes
 * - Track outcome history for audit and analytics
 * - Clean up expired outcome records
 *
 * All outcome records include expiry dates for automatic cleanup per
 * data retention policies.
 */
@Injectable()
export class InvitationDeliveryOutcomeService {
  private readonly logger = new Logger(InvitationDeliveryOutcomeService.name);

  // How long to retain outcome records (in days)
  private readonly OUTCOME_RETENTION_DAYS = 90;

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Hashes an email address using SHA-256 with the organization secret.
   *
   * @param email - The email address to hash
   * @param organizationId - The organization context
   * @param organizationSecret - Secret to salt the hash
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
   * Records a delivery outcome and triggers automatic actions (like suppression).
   *
   * - Outcomes are stored with expiry dates for retention compliance
   * - BOUNCED and COMPLAINT outcomes trigger automatic suppression
   * - FAILED outcomes are tracked for analytics
   * - SENT outcomes confirm successful delivery
   *
   * @param organizationId - Organization ID
   * @param email - Recipient email
   * @param outcome - Delivery outcome
   * @param statusCode - Optional HTTP status code
   * @param failureReason - Optional bounded failure reason
   * @param attemptCount - Number of delivery attempts
   * @returns The created outcome record
   */
  async recordOutcome(
    organizationId: string,
    email: string,
    outcome: InvitationDeliveryOutcome,
    statusCode?: number,
    failureReason?: string,
    attemptCount: number = 1,
  ) {
    const organizationSecret = this.deriveOrganizationSecret(organizationId);
    const emailHash = this.hashEmail(email, organizationId, organizationSecret);

    this.logger.debug(
      `Recording outcome: org=${organizationId}, outcome=${outcome}, recipient=${emailHash}`,
    );

    try {
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + this.OUTCOME_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );

      // Record the outcome
      const outcomeRecord =
        await this.prisma.invitationDeliveryOutcomeRecord.create({
          data: {
            organizationId,
            recipientEmailHash: emailHash,
            outcome,
            statusCode,
            failureReason: failureReason ? failureReason.slice(0, 200) : undefined,
            attemptCount,
            expiresAt,
          },
        });

      // Handle automatic suppression for specific outcomes
      if (outcome === InvitationDeliveryOutcome.BOUNCED) {
        await this.triggerAutoSuppression(
          organizationId,
          email,
          'BOUNCED',
          outcome,
        );
      } else if (outcome === InvitationDeliveryOutcome.COMPLAINT) {
        await this.triggerAutoSuppression(
          organizationId,
          email,
          'COMPLAINT',
          outcome,
        );
      }

      this.logger.info(
        `Outcome recorded: org=${organizationId}, outcome=${outcome}, recipient=${emailHash}`,
      );

      return outcomeRecord;
    } catch (error) {
      this.logger.error(
        `Failed to record outcome for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Triggers automatic suppression based on a delivery outcome.
   *
   * Used for hard bounce (not suppressed) and complaint outcomes.
   * Permanent suppressions (no expiry).
   *
   * @param organizationId - Organization ID
   * @param email - Recipient email
   * @param reason - Suppression reason: BOUNCED, COMPLAINT
   * @param sourceOutcome - The delivery outcome that triggered this
   */
  private async triggerAutoSuppression(
    organizationId: string,
    email: string,
    reason: string,
    sourceOutcome: InvitationDeliveryOutcome,
  ) {
    const organizationSecret = this.deriveOrganizationSecret(organizationId);
    const emailHash = this.hashEmail(email, organizationId, organizationSecret);

    this.logger.info(
      `Auto-triggering suppression: org=${organizationId}, reason=${reason}, recipient=${emailHash}`,
    );

    try {
      await this.prisma.invitationDeliverySuppression.upsert({
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
          expiresAt: null, // Permanent
          note: `Auto-suppressed due to ${reason}`,
        },
        update: {
          reason,
          sourceOutcome,
          note: `Auto-suppressed due to ${reason}`,
          updatedAt: new Date(),
        },
      });

      this.logger.info(
        `Suppression auto-applied: org=${organizationId}, reason=${reason}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to auto-suppress recipient for org=${organizationId}: ${error.message}`,
      );
      // Don't throw; log only. This is a side effect and shouldn't block delivery recording.
    }
  }

  /**
   * Gets delivery outcome statistics for an organization.
   *
   * @param organizationId - Organization ID
   * @param hoursBack - Number of hours to look back (default: 24)
   * @returns Outcome statistics
   */
  async getOutcomeStats(organizationId: string, hoursBack: number = 24) {
    try {
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - hoursBack);

      const outcomes =
        await this.prisma.invitationDeliveryOutcomeRecord.groupBy({
          by: ['outcome'],
          where: {
            organizationId,
            attemptedAt: {
              gte: cutoff,
            },
          },
          _count: true,
        });

      const stats = outcomes.reduce(
        (acc, o) => ({
          ...acc,
          [o.outcome]: o._count,
        }),
        {} as Record<InvitationDeliveryOutcome, number>,
      );

      const total = outcomes.reduce((sum, o) => sum + o._count, 0);

      return {
        organizationId,
        period: {
          hoursBack,
          startTime: cutoff,
          endTime: new Date(),
        },
        total,
        byOutcome: stats,
        bounceRate: total > 0 ? ((stats.BOUNCED || 0) / total) * 100 : 0,
        complaintRate: total > 0 ? ((stats.COMPLAINT || 0) / total) * 100 : 0,
        failureRate: total > 0 ? ((stats.FAILED || 0) / total) * 100 : 0,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get outcome stats for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Gets recent outcomes for a specific recipient (for audit/review).
   *
   * @param organizationId - Organization ID
   * @param email - Recipient email
   * @param limit - Number of recent records to return
   * @returns List of outcome records
   */
  async getRecentOutcomes(
    organizationId: string,
    email: string,
    limit: number = 20,
  ) {
    const organizationSecret = this.deriveOrganizationSecret(organizationId);
    const emailHash = this.hashEmail(email, organizationId, organizationSecret);

    try {
      const outcomes =
        await this.prisma.invitationDeliveryOutcomeRecord.findMany({
          where: {
            organizationId,
            recipientEmailHash: emailHash,
          },
          orderBy: {
            attemptedAt: 'desc',
          },
          take: Math.min(limit, 100),
        });

      return outcomes;
    } catch (error) {
      this.logger.error(
        `Failed to get recent outcomes for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Cleans up expired outcome records (background job).
   *
   * Runs periodically (e.g., daily) to remove outcomes older than OUTCOME_RETENTION_DAYS.
   *
   * @param organizationId - Optional; if provided, only clean up this org's records
   * @returns Number of records deleted
   */
  async cleanupExpiredOutcomes(organizationId?: string) {
    try {
      const result = await this.prisma.invitationDeliveryOutcomeRecord.deleteMany({
        where: {
          ...(organizationId && { organizationId }),
          expiresAt: {
            lt: new Date(),
          },
        },
      });

      this.logger.info(`Cleaned up ${result.count} expired outcome records`);
      return result.count;
    } catch (error) {
      this.logger.error(
        `Failed to clean up expired outcomes: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Detects potential abuse patterns based on outcome history.
   *
   * Returns warnings if:
   * - Bounce rate > 10% in last 24 hours
   * - Complaint rate > 0.1% in last 24 hours
   * - Too many failed attempts
   *
   * @param organizationId - Organization ID
   * @returns List of warnings
   */
  async detectAbusePatterns(organizationId: string) {
    try {
      const stats = await this.getOutcomeStats(organizationId, 24);
      const warnings: string[] = [];

      if (stats.bounceRate > 10) {
        warnings.push(
          `High bounce rate detected: ${stats.bounceRate.toFixed(2)}% (threshold: 10%)`,
        );
      }

      if (stats.complaintRate > 0.1) {
        warnings.push(
          `Complaint rate detected: ${stats.complaintRate.toFixed(4)}% (threshold: 0.1%)`,
        );
      }

      if (stats.failureRate > 5) {
        warnings.push(
          `High failure rate detected: ${stats.failureRate.toFixed(2)}% (threshold: 5%)`,
        );
      }

      if (warnings.length > 0) {
        this.logger.warn(
          `Abuse patterns detected for org=${organizationId}: ${warnings.join('; ')}`,
        );
      }

      return {
        organizationId,
        warnings,
        stats,
      };
    } catch (error) {
      this.logger.error(
        `Failed to detect abuse patterns for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Derives a deterministic secret for an organization.
   *
   * @param organizationId - Organization ID
   * @returns Secret string
   */
  private deriveOrganizationSecret(organizationId: string): string {
    return createHash('sha256').update(`ORG_SECRET:${organizationId}`).digest('hex');
  }
}
