import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  ResourceStatus,
  SecurityNotificationSeverity,
  SecurityNotificationType,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { StructuredLogger } from "../common/logger";
import {
  AcknowledgeNotificationResponseDto,
  CreateSecurityNotificationDto,
  ListSecurityNotificationsDto,
  ResolutionLinkResponseDto,
  SecurityNotificationResponseDto,
  UnreadCountResponseDto,
} from "./dto/security-notification.dto";

const DEFAULT_NOTIFICATION_RETENTION_DAYS = 90;

@Injectable()
export class SecurityNotificationService {
  private readonly logger = new StructuredLogger(SecurityNotificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist a durable security notification record with sensitive data redacted.
   * Delivery failures never remove or alter this inbox record.
   */
  async createNotification(
    organizationId: string,
    dto: CreateSecurityNotificationDto,
  ): Promise<SecurityNotificationResponseDto> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, status: true },
    });

    if (!org || org.status !== ResourceStatus.ACTIVE) {
      throw new BadRequestException("Organization not found or not active");
    }

    const sanitizedData = this.redactSensitiveData(dto.data ?? {});
    const retentionDays = dto.retentionDays ?? DEFAULT_NOTIFICATION_RETENTION_DAYS;
    const retainUntil = new Date(
      Date.now() + retentionDays * 24 * 60 * 60 * 1000,
    );

    const record = await this.prisma.securityNotification.create({
      data: {
        organizationId,
        userId: dto.userId ?? null,
        type: dto.type,
        severity: dto.severity ?? SecurityNotificationSeverity.INFO,
        title: dto.title,
        summary: dto.summary,
        data: sanitizedData as Prisma.InputJsonValue,
        resolutionUrl: dto.resolutionUrl ?? null,
        retainUntil,
      },
    });

    this.logger.log("Security notification persisted in inbox", {
      workflow: "security_notification",
      outcome: "created",
      organizationId,
      notificationId: record.id,
      type: record.type,
      severity: record.severity,
    });

    return this.toResponseDto(record);
  }

  /**
   * List paginated notifications scoped to the organization and user visibility.
   */
  async listNotifications(
    organizationId: string,
    userId: string,
    query: ListSecurityNotificationsDto = {},
  ): Promise<{ data: SecurityNotificationResponseDto[]; nextCursor?: string }> {
    await this.assertMemberOfOrganization(organizationId, userId);

    const limit = query.limit ?? 20;

    const where: Prisma.SecurityNotificationWhereInput = {
      organizationId,
      // User visibility: tenant-wide (userId is null) OR explicitly assigned to this user
      OR: [{ userId: null }, { userId }],
      ...(query.unreadOnly ? { acknowledgedAt: null } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    const records = await this.prisma.securityNotification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = records.length > limit;
    const page = hasMore ? records.slice(0, limit) : records;
    const nextCursor = hasMore ? page[page.length - 1].id : undefined;

    return {
      data: page.map((r) => this.toResponseDto(r)),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /**
   * Get detail for a single notification with tenant and visibility checks.
   */
  async getNotification(
    organizationId: string,
    notificationId: string,
    userId: string,
  ): Promise<SecurityNotificationResponseDto> {
    await this.assertMemberOfOrganization(organizationId, userId);

    const record = await this.prisma.securityNotification.findUnique({
      where: { id: notificationId },
    });

    if (!record || record.organizationId !== organizationId) {
      throw new NotFoundException("Security notification not found");
    }

    if (record.userId !== null && record.userId !== userId) {
      throw new ForbiddenException("Notification not visible to this user");
    }

    return this.toResponseDto(record);
  }

  /**
   * Get unread count for organization visible to the user.
   */
  async getUnreadCount(
    organizationId: string,
    userId: string,
  ): Promise<UnreadCountResponseDto> {
    await this.assertMemberOfOrganization(organizationId, userId);

    const count = await this.prisma.securityNotification.count({
      where: {
        organizationId,
        acknowledgedAt: null,
        OR: [{ userId: null }, { userId }],
      },
    });

    return { organizationId, unreadCount: count };
  }

  /**
   * Acknowledge a notification idempotently.
   * Note: Acknowledgement does not resolve the underlying security incident.
   */
  async acknowledgeNotification(
    organizationId: string,
    notificationId: string,
    userId: string,
  ): Promise<AcknowledgeNotificationResponseDto> {
    await this.assertMemberOfOrganization(organizationId, userId);

    const record = await this.prisma.securityNotification.findUnique({
      where: { id: notificationId },
    });

    if (!record || record.organizationId !== organizationId) {
      throw new NotFoundException("Security notification not found");
    }

    if (record.userId !== null && record.userId !== userId) {
      throw new ForbiddenException("Notification not visible to this user");
    }

    // Idempotent: if already acknowledged, do not overwrite timestamp or user
    if (record.acknowledgedAt) {
      return {
        id: record.id,
        acknowledged: true,
        acknowledgedAt: record.acknowledgedAt.toISOString(),
        acknowledgedById: record.acknowledgedById ?? userId,
      };
    }

    const now = new Date();
    const updated = await this.prisma.securityNotification.update({
      where: { id: notificationId },
      data: {
        acknowledgedAt: now,
        acknowledgedById: userId,
      },
    });

    this.logger.log("Security notification acknowledged", {
      workflow: "security_notification",
      outcome: "acknowledged",
      organizationId,
      notificationId,
      userId,
    });

    return {
      id: updated.id,
      acknowledged: true,
      acknowledgedAt: updated.acknowledgedAt!.toISOString(),
      acknowledgedById: updated.acknowledgedById!,
    };
  }

  /**
   * Get safe resolution link for the notification.
   */
  async getResolutionLink(
    organizationId: string,
    notificationId: string,
    userId: string,
  ): Promise<ResolutionLinkResponseDto> {
    const notif = await this.getNotification(organizationId, notificationId, userId);
    return {
      id: notif.id,
      resolutionUrl: notif.resolutionUrl,
    };
  }

  /**
   * Redacts sensitive secrets, passwords, tokens, and authorization fields.
   */
  private redactSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
    const sensitiveTerms = [
      "secret",
      "token",
      "password",
      "privatekey",
      "signingkey",
      "authorization",
      "bearer",
    ];

    const redacted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(data)) {
      const lower = key.toLowerCase();
      if (sensitiveTerms.some((t) => lower.includes(t))) {
        redacted[key] = "[REDACTED]";
      } else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        redacted[key] = this.redactSensitiveData(val as Record<string, unknown>);
      } else {
        redacted[key] = val;
      }
    }
    return redacted;
  }

  private async assertMemberOfOrganization(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const member = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId,
        },
      },
    });

    if (!member) {
      throw new ForbiddenException(
        "User is not a member of the requested organization",
      );
    }
  }

  private toResponseDto(record: {
    id: string;
    organizationId: string;
    userId: string | null;
    type: SecurityNotificationType;
    severity: SecurityNotificationSeverity;
    title: string;
    summary: string;
    data: Prisma.JsonValue;
    acknowledgedAt: Date | null;
    acknowledgedById: string | null;
    resolutionUrl: string | null;
    createdAt: Date;
  }): SecurityNotificationResponseDto {
    return {
      id: record.id,
      organizationId: record.organizationId,
      userId: record.userId,
      type: record.type,
      severity: record.severity,
      title: record.title,
      summary: record.summary,
      data: (record.data as Record<string, unknown>) ?? {},
      acknowledged: record.acknowledgedAt !== null,
      acknowledgedAt: record.acknowledgedAt?.toISOString() ?? null,
      acknowledgedById: record.acknowledgedById,
      resolutionUrl: record.resolutionUrl,
      createdAt: record.createdAt.toISOString(),
    };
  }
}
