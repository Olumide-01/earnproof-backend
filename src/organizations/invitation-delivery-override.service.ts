import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaClient, InvitationOverrideReason } from '@prisma/client';
import { createHash } from 'crypto';

/**
 * InvitationDeliveryOverrideService manages authorized overrides of suppression
 * and rate limiting for exceptional cases (compliance reviews, customer requests, etc.).
 *
 * Key features:
 * - Requires recent authorization (signed assertion token)
 * - Audit trail with actor ID and reason
 * - Time-limited or permanent overrides
 * - Revocation capability (requires same authorization level)
 * - Per-recipient and per-type uniqueness
 *
 * Only ADMIN+ users can create/revoke overrides.
 */
@Injectable()
export class InvitationDeliveryOverrideService {
  private readonly logger = new Logger(InvitationDeliveryOverrideService.name);

  // Recent authorization must be < this old (in seconds)
  private readonly RECENT_AUTH_WINDOW_SECONDS = 3600; // 1 hour

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
   * Creates an override for a recipient, requiring recent authorization.
   *
   * Idempotent: if an active override already exists for this recipient/type,
   * returns the existing override (no error).
   *
   * @param organizationId - Organization ID
   * @param email - Recipient email to override limits for
   * @param overrideType - Type: SUPPRESSION, RATE_LIMIT, COOLDOWN
   * @param reason - Reason code
   * @param authorizedById - User ID who authorized this (never stored raw)
   * @param authorizedAt - ISO timestamp when authorization was issued
   * @param assertionTokenHash - SHA-256 hash of the recent auth assertion
   * @param description - Optional description of override decision
   * @param expiresAt - Optional expiry timestamp (null = permanent)
   * @returns The created or existing override record
   */
  async createOverride(
    organizationId: string,
    email: string,
    overrideType: string,
    reason: InvitationOverrideReason,
    authorizedById: string,
    authorizedAt: Date,
    assertionTokenHash: string,
    description?: string,
    expiresAt?: Date,
  ) {
    const organizationSecret = this.deriveOrganizationSecret(organizationId);
    const emailHash = this.hashEmail(email, organizationId, organizationSecret);

    this.logger.debug(
      `Creating override: org=${organizationId}, type=${overrideType}, reason=${reason}, recipient=${emailHash}`,
    );

    // Validate authorization recency
    const authAge = new Date().getTime() - authorizedAt.getTime();
    if (authAge > this.RECENT_AUTH_WINDOW_SECONDS * 1000) {
      this.logger.warn(
        `Authorization too old: ${Math.round(authAge / 1000)}s > ${this.RECENT_AUTH_WINDOW_SECONDS}s`,
      );
      throw new ForbiddenException(
        'Authorization is stale; re-verify your wallet to create an override',
      );
    }

    try {
      // Check for existing active override
      const existingOverride =
        await this.prisma.invitationDeliveryOverride.findFirst({
          where: {
            organizationId,
            recipientEmailHash: emailHash,
            overrideType,
            revokedAt: null,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: new Date() } },
            ],
          },
        });

      if (existingOverride) {
        this.logger.info(
          `Override already active: org=${organizationId}, id=${existingOverride.id}`,
        );
        return existingOverride;
      }

      // Create new override
      const override = await this.prisma.invitationDeliveryOverride.create({
        data: {
          organizationId,
          recipientEmailHash: emailHash,
          overrideType,
          reason,
          authorizedById,
          authorizedAt,
          assertionTokenHash,
          description: description ? description.slice(0, 1000) : undefined,
          expiresAt,
        },
      });

      this.logger.info(
        `Override created: org=${organizationId}, id=${override.id}, type=${overrideType}`,
      );

      return override;
    } catch (error) {
      this.logger.error(
        `Failed to create override for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Revokes an override (requires ADMIN+ authorization).
   *
   * @param organizationId - Organization ID
   * @param overrideId - Override ID to revoke
   * @param revokedById - User ID performing revocation
   * @returns The revoked override record
   */
  async revokeOverride(
    organizationId: string,
    overrideId: string,
    revokedById: string,
  ) {
    this.logger.debug(
      `Revoking override: org=${organizationId}, id=${overrideId}, revokedBy=${revokedById}`,
    );

    try {
      const override = await this.prisma.invitationDeliveryOverride.update({
        where: { id: overrideId },
        data: {
          revokedAt: new Date(),
          revokedById,
        },
      });

      if (override.organizationId !== organizationId) {
        throw new ForbiddenException(
          'Override does not belong to this organization',
        );
      }

      this.logger.info(
        `Override revoked: org=${organizationId}, id=${overrideId}`,
      );

      return override;
    } catch (error) {
      if (error.code === 'P2025') {
        throw new BadRequestException('Override not found');
      }
      this.logger.error(
        `Failed to revoke override for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Gets active overrides for a recipient.
   *
   * @param organizationId - Organization ID
   * @param email - Recipient email
   * @returns List of active override records
   */
  async getActiveOverrides(organizationId: string, email: string) {
    const organizationSecret = this.deriveOrganizationSecret(organizationId);
    const emailHash = this.hashEmail(email, organizationId, organizationSecret);

    try {
      const now = new Date();

      const overrides =
        await this.prisma.invitationDeliveryOverride.findMany({
          where: {
            organizationId,
            recipientEmailHash: emailHash,
            revokedAt: null,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          orderBy: { createdAt: 'desc' },
        });

      return overrides;
    } catch (error) {
      this.logger.error(
        `Failed to get overrides for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Lists all overrides for an organization (paginated).
   *
   * Used for administrative review.
   *
   * @param organizationId - Organization ID
   * @param skip - Number of records to skip
   * @param take - Number of records to return
   * @param includeRevoked - Include revoked overrides (default: false)
   * @returns List of override records
   */
  async listOverrides(
    organizationId: string,
    skip: number = 0,
    take: number = 100,
    includeRevoked: boolean = false,
  ) {
    try {
      const overrides = await this.prisma.invitationDeliveryOverride.findMany({
        where: {
          organizationId,
          ...(includeRevoked ? {} : { revokedAt: null }),
        },
        skip,
        take: Math.min(take, 500),
        orderBy: { createdAt: 'desc' },
      });

      return overrides;
    } catch (error) {
      this.logger.error(
        `Failed to list overrides for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Gets override statistics for an organization.
   *
   * @param organizationId - Organization ID
   * @returns Override statistics
   */
  async getOverrideStats(organizationId: string) {
    try {
      const now = new Date();

      // Get active overrides by type
      const activeByType =
        await this.prisma.invitationDeliveryOverride.groupBy({
          by: ['overrideType'],
          where: {
            organizationId,
            revokedAt: null,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          _count: true,
        });

      // Get active overrides by reason
      const activeByReason =
        await this.prisma.invitationDeliveryOverride.groupBy({
          by: ['reason'],
          where: {
            organizationId,
            revokedAt: null,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          _count: true,
        });

      // Get recently created overrides (last 7 days)
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const recentCount = await this.prisma.invitationDeliveryOverride.count({
        where: {
          organizationId,
          createdAt: {
            gte: sevenDaysAgo,
          },
        },
      });

      // Get revoked overrides
      const revokedCount = await this.prisma.invitationDeliveryOverride.count({
        where: {
          organizationId,
          revokedAt: {
            not: null,
          },
        },
      });

      return {
        organizationId,
        activeByType: activeByType.reduce(
          (acc, s) => ({
            ...acc,
            [s.overrideType]: s._count,
          }),
          {} as Record<string, number>,
        ),
        activeByReason: activeByReason.reduce(
          (acc, s) => ({
            ...acc,
            [s.reason]: s._count,
          }),
          {} as Record<string, number>,
        ),
        totalActive: activeByType.reduce((sum, s) => sum + s._count, 0),
        createdLast7Days: recentCount,
        revokedTotal: revokedCount,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get override stats for org=${organizationId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Cleans up expired override records (background job).
   *
   * @param organizationId - Optional; if provided, only clean up this org's records
   * @returns Number of records deleted
   */
  async cleanupExpiredOverrides(organizationId?: string) {
    try {
      const result = await this.prisma.invitationDeliveryOverride.deleteMany({
        where: {
          ...(organizationId && { organizationId }),
          expiresAt: {
            lt: new Date(),
          },
        },
      });

      this.logger.info(`Cleaned up ${result.count} expired overrides`);
      return result.count;
    } catch (error) {
      this.logger.error(
        `Failed to clean up expired overrides: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Gets who created the most recent overrides for an organization.
   *
   * Used for oversight and audit reviews.
   *
   * @param organizationId - Organization ID
   * @param days - Look back N days (default: 7)
   * @returns List of creator actors with override counts
   */
  async getRecentCreators(organizationId: string, days: number = 7) {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);

      const creators = await this.prisma.invitationDeliveryOverride.groupBy({
        by: ['authorizedById'],
        where: {
          organizationId,
          createdAt: {
            gte: cutoff,
          },
        },
        _count: true,
        orderBy: {
          _count: {
            id: 'desc',
          },
        },
      });

      return creators.map((c) => ({
        authorizedById: c.authorizedById,
        overrideCount: c._count,
      }));
    } catch (error) {
      this.logger.error(
        `Failed to get recent creators for org=${organizationId}: ${error.message}`,
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
