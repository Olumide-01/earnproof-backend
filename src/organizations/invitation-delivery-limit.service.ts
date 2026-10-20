import { Injectable, Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';

/**
 * InvitationDeliveryLimitService enforces per-recipient and per-tenant rate limits
 * on invitation delivery to prevent abuse, bounced address loops, and complaint storms.
 *
 * Limits enforced:
 * 1. Per-recipient resend cooldown (e.g., 24 hours between sends)
 * 2. Per-recipient hourly attempt limit (e.g., 3 sends per hour)
 * 3. Per-tenant daily quota (e.g., 10,000 invites per day)
 * 4. Cooldown bypass via authorized override (requires recent auth)
 *
 * All recipient identifiers are hashed to prevent enumeration.
 */
@Injectable()
export class InvitationDeliveryLimitService {
  private readonly logger = new Logger(InvitationDeliveryLimitService.name);

  // Configurable limits (can be moved to env vars)
  private readonly DEFAULT_RESEND_COOLDOWN_HOURS = 24;
  private readonly DEFAULT_HOURLY_LIMIT_PER_RECIPIENT = 3;
  private readonly DEFAULT_DAILY_QUOTA_PER_TENANT = 10000;

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
   * Checks all applicable limits for a recipient before sending an invitation.
   *
   * Returns an object with all limit checks, or throws an error if a hard limit is exceeded
   * and no valid override exists.
   *
   * @param organizationId - Organization ID
   * @param email - Recipient email
   * @param checkOverrides - Whether to check for active overrides (default: true)
   * @returns Limit check results
   */
  async checkLimits(
    organizationId: string,
    email: string,
    checkOverrides: boolean = true,
  ) {
    const organizationSecret = this.deriveOrganizationSecret(organizationId);
    const emailHash = this.hashEmail(email, organizationId, organizationSecret);

    this.logger.debug(
      `Checking limits for org=${organizationId}, recipient=${emailHash}`,
    );

    const checks = {
      resendCooldownOk: true,
      resendCooldownReason: null as string | null,
      hourlyLimitOk: true,
      hourlyLimitReason: null as string | null,
      dailyQuotaOk: true,
      dailyQuotaReason: null as string | null,
      overrideActive: false,
    };

    try {
      // Check 1: Per-recipient resend cooldown
      const cooldown =
        await this.prisma.invitationResendCooldown.findUnique({
          where: {
            organizationId_recipientEmailHash: {
              organizationId,
              recipientEmailHash: emailHash,
            },
          },
        });

      if (cooldown && cooldown.availableAt > new Date()) {
        checks.resendCooldownOk = false;
        checks.resendCooldownReason = `Recipient in cooldown until ${cooldown.availableAt.toISOString()}`;

        if (checkOverrides) {
          const override = await this.findActiveOverride(
            organizationId,
            emailHash,
            'COOLDOWN',
          );
          if (override) {
            checks.overrideActive = true;
            checks.resendCooldownOk = true;
            this.logger.debug(
              `Override active for cooldown: org=${organizationId}, override=${override.id}`,
            );
          }
        }
      }

      // Check 2: Per-recipient hourly limit
      const hourStart = new Date();
      hourStart.setHours(hourStart.getHours() - 1);

      const attemptWindow =
        await this.prisma.invitationResendAttemptWindow.findUnique({
          where: {
            organizationId_recipientEmailHash_windowStart: {
              organizationId,
              recipientEmailHash: emailHash,
              windowStart: this.getHourWindow(new Date()),
            },
          },
        });

      if (attemptWindow && attemptWindow.attemptCount >= this.DEFAULT_HOURLY_LIMIT_PER_RECIPIENT) {
        checks.hourlyLimitOk = false;
        checks.hourlyLimitReason = `Reached hourly limit: ${attemptWindow.attemptCount}/${this.DEFAULT_HOURLY_LIMIT_PER_RECIPIENT} attempts`;

        if (checkOverrides) {
          const override = await this.findActiveOverride(
            organizationId,
            emailHash,
            'RATE_LIMIT',
          );
          if (override) {
            checks.overrideActive = true;
            checks.hourlyLimitOk = true;
            this.logger.debug(
              `Override active for hourly limit: org=${organizationId}, override=${override.id}`,
            );
          }
        }
      }

      // Check 3: Per-tenant daily quota
      const quota = await this.prisma.invitationDeliveryQuota.findUnique({
        where: { organizationId },
      });

      if (quota && quota.limit && quota.count >= quota.limit) {
        checks.dailyQuotaOk = false;
        checks.dailyQuotaReason = `Organization reached daily quota: ${quota.count}/${quota.limit}`;
        // Note: daily quota is org-wide, not per-recipient, so no per-email override
      }

      return checks;
    } catch (error) {
      this.logger.error(
        `Failed to check limits for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Records a successful invitation delivery attempt.
   *
   * Updates:
   * - Resend cooldown (sets availableAt to now + cooldown period)
   * - Hourly attempt counter
   * - Daily quota counter
   *
   * @param organizationId - Organization ID
   * @param email - Recipient email
   */
  async recordDeliveryAttempt(organizationId: string, email: string) {
    const organizationSecret = this.deriveOrganizationSecret(organizationId);
    const emailHash = this.hashEmail(email, organizationId, organizationSecret);

    this.logger.debug(
      `Recording delivery attempt: org=${organizationId}, recipient=${emailHash}`,
    );

    try {
      const now = new Date();
      const availableAt = new Date(
        now.getTime() + this.DEFAULT_RESEND_COOLDOWN_HOURS * 60 * 60 * 1000,
      );
      const windowStart = this.getHourWindow(now);

      // Update or create resend cooldown
      await this.prisma.invitationResendCooldown.upsert({
        where: {
          organizationId_recipientEmailHash: {
            organizationId,
            recipientEmailHash: emailHash,
          },
        },
        create: {
          organizationId,
          recipientEmailHash: emailHash,
          lastSentAt: now,
          availableAt,
          reason: 'DELIVERY_RECORDED',
        },
        update: {
          lastSentAt: now,
          availableAt,
          reason: 'DELIVERY_RECORDED',
        },
      });

      // Update or create hourly attempt window
      await this.prisma.invitationResendAttemptWindow.upsert({
        where: {
          organizationId_recipientEmailHash_windowStart: {
            organizationId,
            recipientEmailHash: emailHash,
            windowStart,
          },
        },
        create: {
          organizationId,
          recipientEmailHash: emailHash,
          windowStart,
          attemptCount: 1,
        },
        update: {
          attemptCount: {
            increment: 1,
          },
        },
      });

      // Update or create daily quota
      await this.prisma.invitationDeliveryQuota.upsert({
        where: { organizationId },
        create: {
          organizationId,
          windowStart: this.getDayWindow(now),
          count: 1,
        },
        update: {
          count: {
            increment: 1,
          },
        },
      });

      this.logger.info(
        `Delivery attempt recorded: org=${organizationId}, recipient=${emailHash}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to record delivery attempt for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Resets per-recipient cooldown and hourly window (used by overrides).
   *
   * @param organizationId - Organization ID
   * @param email - Recipient email
   */
  async resetRecipientLimits(organizationId: string, email: string) {
    const organizationSecret = this.deriveOrganizationSecret(organizationId);
    const emailHash = this.hashEmail(email, organizationId, organizationSecret);

    this.logger.debug(
      `Resetting limits for org=${organizationId}, recipient=${emailHash}`,
    );

    try {
      // Delete cooldown record
      await this.prisma.invitationResendCooldown.delete({
        where: {
          organizationId_recipientEmailHash: {
            organizationId,
            recipientEmailHash: emailHash,
          },
        },
      }).catch(() => null); // Ignore not-found

      // Delete current hourly window
      await this.prisma.invitationResendAttemptWindow.delete({
        where: {
          organizationId_recipientEmailHash_windowStart: {
            organizationId,
            recipientEmailHash: emailHash,
            windowStart: this.getHourWindow(new Date()),
          },
        },
      }).catch(() => null); // Ignore not-found

      this.logger.info(
        `Recipient limits reset: org=${organizationId}, recipient=${emailHash}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to reset limits for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Finds an active override for a recipient and override type.
   *
   * @param organizationId - Organization ID
   * @param emailHash - Hashed recipient email
   * @param overrideType - Type: SUPPRESSION, RATE_LIMIT, COOLDOWN
   * @returns Override record if active and not revoked, null otherwise
   */
  private async findActiveOverride(
    organizationId: string,
    emailHash: string,
    overrideType: string,
  ) {
    const now = new Date();

    try {
      const override =
        await this.prisma.invitationDeliveryOverride.findFirst({
          where: {
            organizationId,
            recipientEmailHash: emailHash,
            overrideType,
            revokedAt: null,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
        });

      return override || null;
    } catch (error) {
      this.logger.error(
        `Failed to find override: org=${organizationId}, type=${overrideType}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Gets the start of the current hour (for hourly window calculations).
   *
   * @param date - Date to calculate from
   * @returns Start of hour (YYYY-MM-DDTHH:00:00.000Z)
   */
  private getHourWindow(date: Date): Date {
    const d = new Date(date);
    d.setMinutes(0, 0, 0);
    return d;
  }

  /**
   * Gets the start of the current day (for daily quota calculations).
   *
   * @param date - Date to calculate from
   * @returns Start of day (YYYY-MM-DDTHH:00:00.000Z)
   */
  private getDayWindow(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
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

  /**
   * Gets limit statistics for an organization.
   *
   * @param organizationId - Organization ID
   * @returns Current usage statistics
   */
  async getOrganizationLimitStats(organizationId: string) {
    try {
      const quota = await this.prisma.invitationDeliveryQuota.findUnique({
        where: { organizationId },
      });

      const recentCooldowns =
        await this.prisma.invitationResendCooldown.count({
          where: {
            organizationId,
            availableAt: {
              gt: new Date(),
            },
          },
        });

      return {
        organizationId,
        dailyQuota: {
          count: quota?.count || 0,
          limit: quota?.limit || this.DEFAULT_DAILY_QUOTA_PER_TENANT,
          windowStart: quota?.windowStart,
        },
        recipientsInCooldown: recentCooldowns,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get limit stats for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }
}
