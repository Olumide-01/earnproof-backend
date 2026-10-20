import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, SessionRiskSeverity, SessionRiskType } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { StructuredLogger } from "../common/logger";
import { ListReauthHistoryDto, ListRiskEventsDto } from "./dto/session-risk.dto";

const DEFAULT_RETENTION_DAYS = 90;

export interface RecordRiskEventInput {
  sessionId?: string;
  riskType: SessionRiskType;
  severity?: SessionRiskSeverity;
  signals?: Record<string, unknown>;
  retentionDays?: number;
}

export interface SanitizedRiskEvent {
  id: string;
  userId: string;
  sessionId: string | null;
  riskType: SessionRiskType;
  severity: SessionRiskSeverity;
  signals: Record<string, unknown>;
  resolvedAt: string | null;
  createdAt: string;
}

export interface ReauthHistoryItem {
  id: string;
  action: string;
  resourceId: string;
  network: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

@Injectable()
export class SessionRiskService {
  private readonly logger = new StructuredLogger(SessionRiskService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a session risk event with privacy-safe bounded signals.
   * Strips raw IPs, signatures, and device hashes.
   */
  async recordRiskEvent(
    userId: string,
    input: RecordRiskEventInput,
  ): Promise<SanitizedRiskEvent> {
    const sanitizedSignals = this.sanitizeSignals(input.signals ?? {});
    const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const retainUntil = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

    const severity = input.severity ?? this.defaultSeverityForType(input.riskType);

    const created = await this.prisma.sessionRiskEvent.create({
      data: {
        userId,
        sessionId: input.sessionId ?? null,
        riskType: input.riskType,
        severity,
        signals: sanitizedSignals as Prisma.InputJsonValue,
        retainUntil,
      },
    });

    this.logger.warn("Session risk event recorded", {
      workflow: "session_risk",
      outcome: "recorded",
      userId,
      riskType: input.riskType,
      severity,
    });

    return this.toSanitized(created);
  }

  /**
   * List risk events for the authenticated user with cursor-based pagination.
   */
  async listRiskEvents(
    userId: string,
    query: ListRiskEventsDto = {},
  ): Promise<{ data: SanitizedRiskEvent[]; nextCursor?: string }> {
    const limit = query.limit ?? 20;

    const where: Prisma.SessionRiskEventWhereInput = {
      userId,
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.riskType ? { riskType: query.riskType } : {}),
    };

    const events = await this.prisma.sessionRiskEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = events.length > limit;
    const page = hasMore ? events.slice(0, limit) : events;
    const nextCursor = hasMore ? page[page.length - 1].id : undefined;

    return {
      data: page.map((e) => this.toSanitized(e)),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /**
   * Revoke sessions related to a flagged risk event.
   * If the event is linked to a specific session, revokes that session.
   * If the event is CRITICAL or has no single sessionId, revokes all other active sessions.
   */
  async revokeRelatedSessions(
    userId: string,
    riskEventId: string,
  ): Promise<{ revokedCount: number; affectedSessionId?: string }> {
    const event = await this.prisma.sessionRiskEvent.findUnique({
      where: { id: riskEventId },
    });

    if (!event) {
      throw new NotFoundException("Risk event not found");
    }

    if (event.userId !== userId) {
      throw new ForbiddenException("Risk event does not belong to user");
    }

    const now = new Date();
    let revokedCount = 0;
    let affectedSessionId: string | undefined;

    if (event.sessionId) {
      const res = await this.prisma.authSession.updateMany({
        where: {
          id: event.sessionId,
          userId,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
          revocationReason: `RISK_EVENT_${event.riskType}`,
        },
      });
      revokedCount = res.count;
      affectedSessionId = event.sessionId;
    } else {
      // General anomaly: revoke all active sessions for this user
      const res = await this.prisma.authSession.updateMany({
        where: {
          userId,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
          revocationReason: `RISK_EVENT_${event.riskType}_ALL`,
        },
      });
      revokedCount = res.count;
    }

    // Mark event as resolved
    await this.prisma.sessionRiskEvent.update({
      where: { id: riskEventId },
      data: { resolvedAt: now },
    });

    this.logger.log("Related sessions revoked for risk event", {
      workflow: "session_risk",
      outcome: "revoked",
      userId,
      riskEventId,
      revokedCount,
    });

    return { revokedCount, ...(affectedSessionId ? { affectedSessionId } : {}) };
  }

  /**
   * Get user-scoped recent-auth assertions history without raw tokens or signatures.
   */
  async getReauthenticationHistory(
    userId: string,
    query: ListReauthHistoryDto = {},
  ): Promise<{ data: ReauthHistoryItem[]; nextCursor?: string }> {
    const limit = query.limit ?? 20;

    const assertions = await this.prisma.recentAuthAssertion.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        action: true,
        resourceId: true,
        network: true,
        createdAt: true,
        expiresAt: true,
        usedAt: true,
      },
    });

    const hasMore = assertions.length > limit;
    const page = hasMore ? assertions.slice(0, limit) : assertions;
    const nextCursor = hasMore ? page[page.length - 1].id : undefined;

    return {
      data: page.map((a) => ({
        id: a.id,
        action: a.action,
        resourceId: a.resourceId,
        network: a.network,
        createdAt: a.createdAt.toISOString(),
        expiresAt: a.expiresAt.toISOString(),
        usedAt: a.usedAt ? a.usedAt.toISOString() : null,
      })),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /**
   * Sanitize risk signals to prevent storing raw IP addresses, signatures, or device hashes.
   */
  private sanitizeSignals(signals: Record<string, unknown>): Record<string, unknown> {
    const forbiddenKeys = [
      "ip",
      "ipaddress",
      "remoteaddress",
      "fingerprint",
      "devicefingerprint",
      "signature",
      "token",
      "tokenhash",
      "authorization",
      "secret",
    ];

    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(signals)) {
      const lower = key.toLowerCase();
      if (forbiddenKeys.some((f) => lower.includes(f))) {
        continue;
      }
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        sanitized[key] = this.sanitizeSignals(val as Record<string, unknown>);
      } else {
        sanitized[key] = val;
      }
    }
    return sanitized;
  }

  private defaultSeverityForType(type: SessionRiskType): SessionRiskSeverity {
    switch (type) {
      case SessionRiskType.REPLAY_SUSPECTED:
      case SessionRiskType.CONCURRENT_GEO_ANOMALY:
        return SessionRiskSeverity.CRITICAL;
      case SessionRiskType.WALLET_MISMATCH:
      case SessionRiskType.ROTATION_ANOMALY:
        return SessionRiskSeverity.HIGH;
      case SessionRiskType.ORIGIN_ANOMALY:
        return SessionRiskSeverity.MEDIUM;
      case SessionRiskType.UNRECOGNIZED_DEVICE:
      default:
        return SessionRiskSeverity.LOW;
    }
  }

  private toSanitized(event: {
    id: string;
    userId: string;
    sessionId: string | null;
    riskType: SessionRiskType;
    severity: SessionRiskSeverity;
    signals: Prisma.JsonValue;
    resolvedAt: Date | null;
    createdAt: Date;
  }): SanitizedRiskEvent {
    return {
      id: event.id,
      userId: event.userId,
      sessionId: event.sessionId,
      riskType: event.riskType,
      severity: event.severity,
      signals: (event.signals as Record<string, unknown>) ?? {},
      resolvedAt: event.resolvedAt ? event.resolvedAt.toISOString() : null,
      createdAt: event.createdAt.toISOString(),
    };
  }
}
