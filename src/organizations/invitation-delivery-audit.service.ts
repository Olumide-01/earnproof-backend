import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';

/**
 * InvitationDeliveryAuditService logs all invitation delivery control changes
 * to InvitationDeliveryAuditEvent for audit trail and compliance.
 *
 * Logs include:
 * - Suppression additions/removals
 * - Limit resets
 * - Outcome recordings
 * - Override creations/revocations
 *
 * All recipient emails are hashed (cannot be reversed).
 * Actor IDs are recorded (never raw PII).
 * Metadata is bounded JSON (prevents unbounded growth).
 */
@Injectable()
export class InvitationDeliveryAuditService {
  private readonly logger = new Logger(InvitationDeliveryAuditService.name);

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Hashes an email address for audit logging (same as service hashes).
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
   * Logs a suppression-related change (ADD_SUPPRESSION, REMOVE_SUPPRESSION).
   *
   * @param organizationId - Organization ID
   * @param action - ADD_SUPPRESSION or REMOVE_SUPPRESSION
   * @param email - Recipient email
   * @param metadata - Optional: { reason, expiresAt, suppressionReason, etc. }
   * @param actorId - Optional: User ID performing the action (defaults to SYSTEM)
   */
  async logSuppressionChange(
    organizationId: string,
    action: string,
    email: string,
    metadata?: Record<string, any>,
    actorId: string = 'SYSTEM',
  ) {
    try {
      const organizationSecret = this.deriveOrganizationSecret(organizationId);
      const emailHash = this.hashEmail(email, organizationId, organizationSecret);

      await this.prisma.invitationDeliveryAuditEvent.create({
        data: {
          organizationId,
          action,
          recipientEmailHash: emailHash,
          actorId,
          metadata: this.boundJSON(metadata),
          occurredAt: new Date(),
        },
      });

      this.logger.debug(
        `Audited: org=${organizationId}, action=${action}, actor=${actorId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to log suppression change for org=${organizationId}: ${error.message}`,
      );
      // Don't throw; audit failure should not block the operation.
    }
  }

  /**
   * Logs a limit reset action (RESET_LIMITS).
   *
   * @param organizationId - Organization ID
   * @param action - RESET_LIMITS
   * @param email - Recipient email
   * @param actorId - Optional: User ID performing the action
   */
  async logLimitChange(
    organizationId: string,
    action: string,
    email: string,
    actorId: string = 'SYSTEM',
  ) {
    try {
      const organizationSecret = this.deriveOrganizationSecret(organizationId);
      const emailHash = this.hashEmail(email, organizationId, organizationSecret);

      await this.prisma.invitationDeliveryAuditEvent.create({
        data: {
          organizationId,
          action,
          recipientEmailHash: emailHash,
          actorId,
          metadata: { type: 'limit_reset' },
          occurredAt: new Date(),
        },
      });

      this.logger.debug(
        `Audited: org=${organizationId}, action=${action}, actor=${actorId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to log limit change for org=${organizationId}: ${error.message}`,
      );
    }
  }

  /**
   * Logs an outcome recording action (RECORD_OUTCOME).
   *
   * @param organizationId - Organization ID
   * @param action - RECORD_OUTCOME
   * @param email - Recipient email
   * @param metadata - Optional: { outcome, statusCode, failureReason }
   * @param actorId - Optional: User ID performing the action
   */
  async logOutcomeChange(
    organizationId: string,
    action: string,
    email: string,
    metadata?: Record<string, any>,
    actorId: string = 'SYSTEM',
  ) {
    try {
      const organizationSecret = this.deriveOrganizationSecret(organizationId);
      const emailHash = email ? this.hashEmail(email, organizationId, organizationSecret) : undefined;

      await this.prisma.invitationDeliveryAuditEvent.create({
        data: {
          organizationId,
          action,
          recipientEmailHash: emailHash,
          actorId,
          metadata: this.boundJSON(metadata),
          occurredAt: new Date(),
        },
      });

      this.logger.debug(
        `Audited: org=${organizationId}, action=${action}, actor=${actorId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to log outcome change for org=${organizationId}: ${error.message}`,
      );
    }
  }

  /**
   * Logs an override-related change (CREATE_OVERRIDE, REVOKE_OVERRIDE).
   *
   * @param organizationId - Organization ID
   * @param action - CREATE_OVERRIDE or REVOKE_OVERRIDE
   * @param email - Recipient email
   * @param metadata - Optional: { overrideType, reason, overrideId }
   * @param actorId - Optional: User ID performing the action
   */
  async logOverrideChange(
    organizationId: string,
    action: string,
    email: string,
    metadata?: Record<string, any>,
    actorId: string = 'SYSTEM',
  ) {
    try {
      const organizationSecret = this.deriveOrganizationSecret(organizationId);
      const emailHash = email ? this.hashEmail(email, organizationId, organizationSecret) : undefined;

      await this.prisma.invitationDeliveryAuditEvent.create({
        data: {
          organizationId,
          action,
          recipientEmailHash: emailHash,
          actorId,
          overrideReason: metadata?.reason ? String(metadata.reason).slice(0, 200) : undefined,
          metadata: this.boundJSON(metadata),
          occurredAt: new Date(),
        },
      });

      this.logger.debug(
        `Audited: org=${organizationId}, action=${action}, actor=${actorId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to log override change for org=${organizationId}: ${error.message}`,
      );
    }
  }

  /**
   * Gets audit events for an organization.
   *
   * @param organizationId - Organization ID
   * @param limit - Number of events to return (default: 100, max: 500)
   * @returns List of audit events
   */
  async getAuditEvents(organizationId: string, limit: number = 100) {
    try {
      const events = await this.prisma.invitationDeliveryAuditEvent.findMany({
        where: { organizationId },
        orderBy: { occurredAt: 'desc' },
        take: Math.min(limit, 500),
      });

      return events;
    } catch (error) {
      this.logger.error(
        `Failed to get audit events for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Gets audit events for a specific actor.
   *
   * @param organizationId - Organization ID
   * @param actorId - Actor ID to filter
   * @param limit - Number of events to return
   * @returns List of audit events
   */
  async getActorAuditEvents(
    organizationId: string,
    actorId: string,
    limit: number = 100,
  ) {
    try {
      const events = await this.prisma.invitationDeliveryAuditEvent.findMany({
        where: {
          organizationId,
          actorId,
        },
        orderBy: { occurredAt: 'desc' },
        take: Math.min(limit, 500),
      });

      return events;
    } catch (error) {
      this.logger.error(
        `Failed to get actor audit events for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Gets summary of audit events by action.
   *
   * @param organizationId - Organization ID
   * @param hoursBack - Number of hours to look back (default: 24)
   * @returns Summary of events by action
   */
  async getAuditSummary(organizationId: string, hoursBack: number = 24) {
    try {
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - hoursBack);

      const events = await this.prisma.invitationDeliveryAuditEvent.groupBy({
        by: ['action'],
        where: {
          organizationId,
          occurredAt: {
            gte: cutoff,
          },
        },
        _count: true,
      });

      return {
        organizationId,
        period: {
          hoursBack,
          startTime: cutoff,
          endTime: new Date(),
        },
        byAction: events.reduce(
          (acc, e) => ({
            ...acc,
            [e.action]: e._count,
          }),
          {} as Record<string, number>,
        ),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get audit summary for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Bounds JSON metadata to prevent unbounded growth.
   * Truncates large objects and converts to string if needed.
   *
   * @param metadata - Metadata object
   * @returns Bounded JSON object
   */
  private boundJSON(metadata?: Record<string, any>): Record<string, any> | undefined {
    if (!metadata) return undefined;

    const bounded = {};
    let keyCount = 0;

    for (const [key, value] of Object.entries(metadata)) {
      if (keyCount >= 20) break; // Max 20 keys

      let boundedValue: any = value;

      if (typeof value === 'string') {
        boundedValue = value.slice(0, 500); // Max 500 chars per string
      } else if (typeof value === 'object') {
        boundedValue = JSON.stringify(value).slice(0, 500);
      }

      bounded[key] = boundedValue;
      keyCount++;
    }

    return bounded;
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
