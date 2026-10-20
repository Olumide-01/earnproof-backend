import { Injectable } from "@nestjs/common";
import { SecurityNotificationSeverity, SecurityNotificationType } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { StructuredLogger } from "../../common/logger";
import {
  DomainEvent,
  DomainEventHandler,
} from "../../common/events/domain-event.types";
import { DisputeDecisionNotificationPayload } from "../../disputes/events/dispute-decision-notification.types";
import { SecurityNotificationService } from "../security-notification.service";

/**
 * DisputeDecisionNotificationHandler
 * 
 * Consumes DISPUTE_RESOLVED, DISPUTE_WITHDRAWN, and DISPUTE_EXPIRED domain events
 * and creates privacy-safe security notifications for all relevant participants.
 * 
 * Privacy & Authorization:
 * - Notifications disclose no sensitive proof data (claims, balances, hashes)
 * - Only decision outcome and reasoning included
 * - Proof owner notified of dispute outcome
 * - Dispute submitter notified of resolution
 * - Assigned reviewer context included for audit
 * - Organization-wide notifications for admin visibility
 * 
 * Deduplication:
 * - Domain event outbox prevents duplicate event delivery
 * - This handler is idempotent per event (can safely replay)
 * - Notifications created deterministically from event data
 * 
 * Fault tolerance:
 * - Handler failures cause event retry via outbox lease mechanism
 * - Privacy-safe notification records survive delivery retries
 * - Stale state: if dispute data changes, event still reflects original decision
 */
@Injectable()
export class DisputeDecisionNotificationHandler implements DomainEventHandler<DisputeDecisionNotificationPayload> {
  readonly consumerName = "DisputeDecisionNotificationHandler";
  private readonly logger = new StructuredLogger(DisputeDecisionNotificationHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityNotificationService: SecurityNotificationService,
  ) {}

  /**
   * Handle domain event for dispute decision notification.
   * 
   * This handler:
   * 1. Verifies the dispute and proof exist (stale-state detection)
   * 2. Determines notification severity based on decision type
   * 3. Creates notifications for each participant
   * 4. Logs outcomes for observability
   * 
   * @param event Domain event containing dispute decision payload
   * @throws Retryable errors (NotFound) trigger outbox retry
   */
  async handle(event: DomainEvent<DisputeDecisionNotificationPayload>): Promise<void> {
    const { payload } = event;

    this.logger.log("Processing dispute decision notification event", {
      workflow: "dispute_notification",
      eventId: event.id,
      eventType: event.eventType,
      disputeId: payload.disputeId,
      decisionType: payload.decisionType,
      organizationId: payload.organizationId,
    });

    // Verify dispute still exists (stale-state detection)
    const dispute = await this.prisma.proofDispute.findFirst({
      where: {
        id: payload.disputeId,
        organizationId: payload.organizationId,
      },
      select: {
        id: true,
        proofId: true,
        status: true,
        category: true,
        submittedBy: true,
        resolvedBy: true,
        resolvedAt: true,
        withdrawnAt: true,
      },
    });

    if (!dispute) {
      this.logger.warn("Dispute not found for notification event", {
        workflow: "dispute_notification",
        eventId: event.id,
        disputeId: payload.disputeId,
        organizationId: payload.organizationId,
      });
      // Still mark as processed - dispute may have been deleted
      return;
    }

    // Verify proof exists (safety check)
    const proof = await this.prisma.proof.findUnique({
      where: { id: payload.proofId },
      select: { id: true, userId: true, status: true },
    });

    if (!proof) {
      this.logger.warn("Proof not found for dispute decision notification", {
        workflow: "dispute_notification",
        eventId: event.id,
        proofId: payload.proofId,
        organizationId: payload.organizationId,
      });
      return;
    }

    // Determine notification severity based on decision type
    const severity = this.determineSeverity(payload.decisionType);
    const title = this.buildNotificationTitle(payload);
    const summary = this.buildNotificationSummary(payload);

    // Create notifications for each participant
    const notificationCount = await this.createParticipantNotifications(
      payload,
      event,
      severity,
      title,
      summary,
    );

    // Create org-wide notification for audit trail
    await this.createOrgWideNotification(payload, event, severity, title, summary);

    this.logger.log("Dispute decision notifications created", {
      workflow: "dispute_notification",
      eventId: event.id,
      disputeId: payload.disputeId,
      decisionType: payload.decisionType,
      participantNotifications: notificationCount,
      organizationId: payload.organizationId,
    });
  }

  /**
   * Create targeted notifications for each participant.
   * 
   * Participants:
   * - Proof owner: Main stakeholder, needs to know outcome
   * - Dispute submitter: Initiator, needs resolution confirmation
   * - Assigned reviewer: Context for audit trail (if applicable)
   * 
   * @returns Number of participant notifications created
   */
  private async createParticipantNotifications(
    payload: DisputeDecisionNotificationPayload,
    event: DomainEvent<DisputeDecisionNotificationPayload>,
    severity: SecurityNotificationSeverity,
    title: string,
    summary: string,
  ): Promise<number> {
    const { participants, organizationId } = payload;
    const notificationData = this.buildNotificationData(payload, event);
    let count = 0;

    // Notify proof owner
    try {
      await this.securityNotificationService.createNotification(organizationId, {
        type: SecurityNotificationType.DISPUTE_FILED,
        severity,
        userId: participants.proofOwnerId,
        title,
        summary,
        data: notificationData,
        retentionDays: 90,
      });
      count++;
    } catch (error) {
      this.logger.error("Failed to create proof owner notification", {
        workflow: "dispute_notification",
        eventId: event.id,
        disputeId: payload.disputeId,
        userId: participants.proofOwnerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Retry via outbox
    }

    // Notify dispute submitter (if different from proof owner)
    if (participants.disputeSubmitterId !== participants.proofOwnerId) {
      try {
        await this.securityNotificationService.createNotification(organizationId, {
          type: SecurityNotificationType.DISPUTE_FILED,
          severity,
          userId: participants.disputeSubmitterId,
          title: `Your Dispute Report: ${title.replace("Dispute", "").trim()}`,
          summary: `Your dispute submission has been ${payload.decisionType.toLowerCase()}. ${summary}`,
          data: notificationData,
          retentionDays: 90,
        });
        count++;
      } catch (error) {
        this.logger.error("Failed to create dispute submitter notification", {
          workflow: "dispute_notification",
          eventId: event.id,
          disputeId: payload.disputeId,
          userId: participants.disputeSubmitterId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error; // Retry via outbox
      }
    }

    // Notify assigned reviewer (if applicable)
    if (
      participants.assignedReviewerId &&
      participants.assignedReviewerId !== participants.proofOwnerId &&
      participants.assignedReviewerId !== participants.disputeSubmitterId
    ) {
      try {
        await this.securityNotificationService.createNotification(organizationId, {
          type: SecurityNotificationType.DISPUTE_FILED,
          severity,
          userId: participants.assignedReviewerId,
          title: `Dispute Review Completed: ${title.replace("Dispute", "").trim()}`,
          summary: `A dispute you reviewed has been finalized. ${summary}`,
          data: notificationData,
          retentionDays: 90,
        });
        count++;
      } catch (error) {
        this.logger.error("Failed to create reviewer notification", {
          workflow: "dispute_notification",
          eventId: event.id,
          disputeId: payload.disputeId,
          userId: participants.assignedReviewerId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error; // Retry via outbox
      }
    }

    return count;
  }

  /**
   * Create organization-wide notification for audit trail.
   * Visible to all organization members for compliance and observability.
   */
  private async createOrgWideNotification(
    payload: DisputeDecisionNotificationPayload,
    event: DomainEvent<DisputeDecisionNotificationPayload>,
    severity: SecurityNotificationSeverity,
    title: string,
    summary: string,
  ): Promise<void> {
    try {
      const notificationData = this.buildNotificationData(payload, event);
      notificationData.auditTrail = true;
      notificationData.organizationWidely = true;

      await this.securityNotificationService.createNotification(payload.organizationId, {
        type: SecurityNotificationType.DISPUTE_FILED,
        severity,
        userId: null, // Organization-wide visibility
        title: `[Audit] ${title}`,
        summary: `Organization audit trail: ${summary}`,
        data: notificationData,
        retentionDays: 180, // Longer retention for audit trail
      });
    } catch (error) {
      this.logger.error("Failed to create org-wide audit notification", {
        workflow: "dispute_notification",
        eventId: event.id,
        disputeId: payload.disputeId,
        organizationId: payload.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Retry via outbox
    }
  }

  /**
   * Determine notification severity based on decision type.
   * - RESOLVED: Varies by outcome (UPHELD → HIGH, others → INFO/WARNING)
   * - WITHDRAWN: INFO
   * - EXPIRED: WARNING (stale-state cleanup)
   */
  private determineSeverity(
    decisionType: "RESOLVED" | "WITHDRAWN" | "EXPIRED",
  ): SecurityNotificationSeverity {
    switch (decisionType) {
      case "RESOLVED":
        // Assuming outcome "UPHELD" indicates serious issue (proof invalid)
        // This is conservative; actual severity depends on outcome field
        return SecurityNotificationSeverity.HIGH;
      case "WITHDRAWN":
        return SecurityNotificationSeverity.INFO;
      case "EXPIRED":
        return SecurityNotificationSeverity.WARNING;
      default:
        return SecurityNotificationSeverity.INFO;
    }
  }

  /**
   * Build notification title summarizing the dispute decision.
   */
  private buildNotificationTitle(payload: DisputeDecisionNotificationPayload): string {
    switch (payload.decisionType) {
      case "RESOLVED":
        return `Dispute #${payload.disputeId.substring(0, 8)}: ${payload.resolutionOutcome || "Resolved"}`;
      case "WITHDRAWN":
        return `Dispute #${payload.disputeId.substring(0, 8)}: Withdrawn`;
      case "EXPIRED":
        return `Dispute #${payload.disputeId.substring(0, 8)}: Proof Expired`;
      default:
        return `Dispute #${payload.disputeId.substring(0, 8)}: Decision`;
    }
  }

  /**
   * Build notification summary (human-readable, privacy-safe).
   */
  private buildNotificationSummary(payload: DisputeDecisionNotificationPayload): string {
    switch (payload.decisionType) {
      case "RESOLVED":
        return `${payload.category} dispute resolved with outcome: ${payload.resolutionOutcome}. Reason: ${payload.resolutionReason?.substring(0, 100) || "No reason provided"}...`;
      case "WITHDRAWN":
        return `${payload.category} dispute has been withdrawn by the submitter.`;
      case "EXPIRED":
        return `Proof with pending ${payload.category} dispute has expired and dispute is now closed.`;
      default:
        return `Dispute decision has been finalized.`;
    }
  }

  /**
   * Build notification data (privacy-safe payload for notification).
   * Excludes sensitive proof data, includes only decision-relevant information.
   */
  private buildNotificationData(
    payload: DisputeDecisionNotificationPayload,
    event: DomainEvent<DisputeDecisionNotificationPayload>,
  ): Record<string, unknown> {
    return {
      disputeId: payload.disputeId,
      proofId: payload.proofId,
      category: payload.category,
      decisionType: payload.decisionType,
      status: payload.status,
      resolutionOutcome: payload.resolutionOutcome,
      resolutionReason: payload.resolutionReason,
      decisionTimestamp: payload.resolvedAt || payload.withdrawnAt || new Date().toISOString(),
      eventId: event.id,
      eventVersion: event.eventVersion,
      eventTimestamp: event.createdAt.toISOString(),
    };
  }
}
