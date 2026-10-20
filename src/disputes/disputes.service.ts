import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DisputeStatus, DisputeCategory } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { WebhookDeliveryService } from "../webhooks/webhook-delivery.service";
import { sha256 } from "../common/crypto/hash";
import { StructuredLogger } from "../common/logger";
import { DomainEventOutboxService } from "../common/events/domain-event-outbox.service";
import { DisputeDecisionNotificationPayload } from "./events/dispute-decision-notification.types";
import { SignedCursorService } from "../common/pagination/signed-cursor.service";
import { computeFilterIdFromDto } from "../common/pagination/filter-id";

export type CreateDisputeDto = {
  proofId: string;
  category: DisputeCategory;
  evidenceCommitment?: string;
  metadata?: Record<string, any>;
};

export type ListDisputesDto = {
  status?: DisputeStatus;
  category?: DisputeCategory;
  assignedTo?: string;
  limit?: number;
  cursor?: string;
};

export type AssignDisputeDto = {
  assignedTo: string;
};

export type ResolveDisputeDto = {
  resolutionOutcome: string;
  resolutionReason: string;
};

/**
 * ProofDisputesService
 * 
 * Manages the proof dispute lifecycle - a business/audit workflow separate
 * from cryptographic verification. Disputes do NOT change proof validity
 * but provide a review process for accuracy, fraud, technical issues, etc.
 * 
 * Key principles:
 * - Disputes are business workflow, not cryptographic verification
 * - Dispute resolution does not modify proof validity
 * - One active dispute per proof/category at a time
 * - Tenant isolation enforced at all levels
 * - Full audit trail with webhook events
 * - Bounded evidence commitments (no raw file storage)
 */
@Injectable()
export class DisputesService {
  private readonly logger = new StructuredLogger(DisputesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signedCursorService: SignedCursorService,
    private readonly webhookDeliveryService?: WebhookDeliveryService,
    private readonly domainEventOutbox?: DomainEventOutboxService,
  ) {}

  /**
   * Submit a new proof dispute.
   */
  async submitDispute(
    user: AuthenticatedUser,
    organizationId: string,
    input: CreateDisputeDto,
  ) {
    // Verify the user has access to this organization
    await this.verifyOrganizationAccess(user, organizationId);

    // Verify the proof exists and belongs to this organization
    const proof = await this.prisma.proof.findFirst({
      where: {
        id: input.proofId,
        user: {
          organizationMemberships: {
            some: {
              organizationId,
              status: "ACTIVE",
            },
          },
        },
      },
      select: {
        id: true,
        userId: true,
        user: {
          select: {
            organizationMemberships: {
              where: { organizationId },
              select: { organizationId: true },
            },
          },
        },
      },
    });

    if (!proof) {
      throw new NotFoundException("Proof not found or not accessible");
    }

    // Validate evidence commitment format if provided
    if (input.evidenceCommitment && !this.isValidCommitment(input.evidenceCommitment)) {
      throw new BadRequestException("Invalid evidence commitment format");
    }

    // Validate metadata size
    if (input.metadata && JSON.stringify(input.metadata).length > 10_000) {
      throw new BadRequestException("Metadata too large (max 10KB)");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Check for existing active dispute of same category
        const existingDispute = await tx.proofDispute.findFirst({
          where: {
            proofId: input.proofId,
            category: input.category,
            status: { in: [DisputeStatus.OPEN, DisputeStatus.ASSIGNED] },
          },
        });

        if (existingDispute) {
          throw new BadRequestException(
            `An active ${input.category} dispute already exists for this proof`
          );
        }

        // Create the dispute
        const dispute = await tx.proofDispute.create({
          data: {
            organizationId,
            proofId: input.proofId,
            category: input.category,
            status: DisputeStatus.OPEN,
            evidenceCommitment: input.evidenceCommitment,
            submittedBy: user.id,
            metadata: input.metadata,
          },
          include: {
            proof: {
              select: { id: true, proofType: true, userId: true },
            },
          },
        });

        // Create audit log
        await tx.auditLog.create({
          data: {
            actorType: "User",
            actorId: user.id,
            action: "DISPUTE_SUBMITTED",
            resourceType: "ProofDispute",
            resourceId: dispute.id,
            metadata: {
              proofId: input.proofId,
              category: input.category,
              organizationId,
            },
          },
        });

        // Emit DISPUTE_FILED domain event for notifications
        if (this.domainEventOutbox) {
          await this.domainEventOutbox.publish<DisputeDecisionNotificationPayload>(tx, {
            organizationId,
            eventType: "DISPUTE_FILED",
            aggregateType: "ProofDispute",
            aggregateId: dispute.id,
            payload: {
              disputeId: dispute.id,
              proofId: dispute.proofId,
              organizationId,
              category: dispute.category,
              decisionType: "FILED",
              status: dispute.status,
              participants: {
                proofOwnerId: dispute.proof.userId,
                disputeSubmitterId: user.id,
              },
            },
          });
        }

        return dispute;
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      // Check if it's a unique constraint violation (race condition)
      if (error instanceof Error && error.message.includes("proof_dispute_unique_active")) {
        throw new BadRequestException(
          `An active ${input.category} dispute already exists for this proof`
        );
      }
      
      throw error;
    }
  }

  /**
   * List disputes with filtering and pagination using signed cursor tokens.
   * 
   * Cursor tokens are signed with:
   * - Tenant binding (organizationId) to prevent cross-tenant data leaks
   * - Filter binding to prevent using cursors across different filter sets
   * - Expiry (15 minutes) for time-bound validity
   * - HMAC-SHA256 signatures for tamper protection
   */
  async listDisputes(
    user: AuthenticatedUser,
    organizationId: string,
    query: ListDisputesDto,
  ) {
    // Verify organization access
    await this.verifyOrganizationAccess(user, organizationId);

    const limit = Math.min(query.limit ?? 20, 100);

    // Compute filter ID from query parameters (binds cursor to specific filters)
    const filterId = computeFilterIdFromDto(query, ["status", "category", "assignedTo"]);

    // Validate and decode cursor if provided
    let cursorId: string | undefined;
    if (query.cursor) {
      const verifyResult = this.signedCursorService.verify({
        token: query.cursor,
        tenantId: organizationId,
        filterId,
      });

      if (!verifyResult.ok) {
        // Return stable error messages for all validation failures
        const reason = verifyResult.reason;
        throw new BadRequestException(
          `Invalid pagination cursor: ${reason}. Please restart pagination.`
        );
      }

      cursorId = verifyResult.data.cursorId;
    }

    const where: any = {
      organizationId,
      ...(query.status && { status: query.status }),
      ...(query.category && { category: query.category }),
      ...(query.assignedTo && { assignedTo: query.assignedTo }),
    };

    const disputes = await this.prisma.proofDispute.findMany({
      where,
      include: {
        proof: {
          select: { id: true, proofType: true, status: true, createdAt: true },
        },
      },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    const hasMore = disputes.length > limit;
    const items = hasMore ? disputes.slice(0, limit) : disputes;

    // Sign the next cursor token if there are more items
    const nextCursor = hasMore
      ? this.signedCursorService.sign({
          cursorId: items[items.length - 1]?.id ?? "",
          tenantId: organizationId,
          filterId,
        })
      : null;

    return {
      items: items.map((dispute) => this.formatDisputeResponse(dispute)),
      pageInfo: {
        hasMore,
        nextCursor,
      },
    };
  }

  /**
   * Get a specific dispute.
   */
  async getDispute(
    user: AuthenticatedUser,
    organizationId: string,
    disputeId: string,
  ) {
    await this.verifyOrganizationAccess(user, organizationId);

    const dispute = await this.prisma.proofDispute.findFirst({
      where: { id: disputeId, organizationId },
      include: {
        proof: {
          select: { 
            id: true, 
            proofType: true, 
            status: true, 
            createdAt: true, 
            expiresAt: true,
          },
        },
      },
    });

    if (!dispute) {
      throw new NotFoundException("Dispute not found");
    }

    return this.formatDisputeResponse(dispute);
  }

  /**
   * Withdraw a dispute (only by submitter, only if OPEN).
   */
  async withdrawDispute(
    user: AuthenticatedUser,
    organizationId: string,
    disputeId: string,
  ) {
    await this.verifyOrganizationAccess(user, organizationId);

    const dispute = await this.prisma.proofDispute.findFirst({
      where: { id: disputeId, organizationId },
      select: { id: true, status: true, submittedBy: true, proofId: true },
    });

    if (!dispute) {
      throw new NotFoundException("Dispute not found");
    }

    if (dispute.submittedBy !== user.id) {
      throw new ForbiddenException("Only the dispute submitter can withdraw it");
    }

    if (dispute.status !== DisputeStatus.OPEN) {
      throw new BadRequestException("Only open disputes can be withdrawn");
    }

    return await this.prisma.$transaction(async (tx) => {
      const updated = await tx.proofDispute.update({
        where: { id: disputeId },
        data: {
          status: DisputeStatus.WITHDRAWN,
          withdrawnAt: new Date(),
        },
        include: {
          proof: {
            select: { userId: true },
          },
        },
      });

      // Create audit log
      await tx.auditLog.create({
        data: {
          actorType: "User",
          actorId: user.id,
          action: "DISPUTE_WITHDRAWN",
          resourceType: "ProofDispute",
          resourceId: disputeId,
          metadata: {
            proofId: dispute.proofId,
            organizationId,
          },
        },
      });

      // Emit DISPUTE_WITHDRAWN domain event for notifications
      if (this.domainEventOutbox) {
        await this.domainEventOutbox.publish<DisputeDecisionNotificationPayload>(tx, {
          organizationId,
          eventType: "DISPUTE_WITHDRAWN",
          aggregateType: "ProofDispute",
          aggregateId: updated.id,
          payload: {
            disputeId: updated.id,
            proofId: updated.proofId,
            organizationId,
            category: updated.category,
            decisionType: "WITHDRAWN",
            status: updated.status,
            withdrawnBy: user.id,
            withdrawnAt: updated.withdrawnAt?.toISOString(),
            participants: {
              proofOwnerId: updated.proof.userId,
              disputeSubmitterId: updated.submittedBy,
            },
          },
        });
      }

      this.emitWebhookEvent(organizationId, "dispute.withdrawn", {
        disputeId: updated.id,
        proofId: updated.proofId,
        category: updated.category,
        withdrawnBy: user.id,
        withdrawnAt: updated.withdrawnAt?.toISOString(),
      });

      return this.formatDisputeResponse(updated);
    });
  }

  /**
   * Assign a dispute to a reviewer (admin only).
   */
  async assignDispute(
    user: AuthenticatedUser,
    organizationId: string,
    disputeId: string,
    input: AssignDisputeDto,
  ) {
    await this.verifyOrganizationAccess(user, organizationId);
    
    // Only admins can assign disputes
    if (user.role !== "ADMIN") {
      throw new ForbiddenException("Only administrators can assign disputes");
    }

    const dispute = await this.prisma.proofDispute.findFirst({
      where: { id: disputeId, organizationId },
      select: { id: true, status: true, proofId: true, assignedTo: true },
    });

    if (!dispute) {
      throw new NotFoundException("Dispute not found");
    }

    if (dispute.status !== DisputeStatus.OPEN) {
      throw new BadRequestException("Only open disputes can be assigned");
    }

    // Verify the assignee has access to this organization
    const assignee = await this.prisma.organizationMember.findFirst({
      where: {
        userId: input.assignedTo,
        organizationId,
        status: "ACTIVE",
      },
      select: { userId: true },
    });

    if (!assignee) {
      throw new BadRequestException("Assignee does not have access to this organization");
    }

    return await this.prisma.$transaction(async (tx) => {
      const updated = await tx.proofDispute.update({
        where: { id: disputeId },
        data: {
          status: DisputeStatus.ASSIGNED,
          assignedTo: input.assignedTo,
          assignedAt: new Date(),
        },
        include: {
          proof: {
            select: { userId: true },
          },
        },
      });

      // Create audit log
      await tx.auditLog.create({
        data: {
          actorType: "User",
          actorId: user.id,
          action: "DISPUTE_ASSIGNED",
          resourceType: "ProofDispute",
          resourceId: disputeId,
          metadata: {
            proofId: dispute.proofId,
            assignedTo: input.assignedTo,
            organizationId,
          },
        },
      });

      // Emit DISPUTE_ASSIGNED domain event
      if (this.domainEventOutbox) {
        await this.domainEventOutbox.publish<DisputeDecisionNotificationPayload>(tx, {
          organizationId,
          eventType: "DISPUTE_ASSIGNED",
          aggregateType: "ProofDispute",
          aggregateId: updated.id,
          payload: {
            disputeId: updated.id,
            proofId: updated.proofId,
            organizationId,
            category: updated.category,
            decisionType: "ASSIGNED",
            status: updated.status,
            participants: {
              proofOwnerId: updated.proof.userId,
              disputeSubmitterId: updated.submittedBy,
              assignedReviewerId: input.assignedTo,
            },
          },
        });
      }

      this.emitWebhookEvent(organizationId, "dispute.assigned", {
        disputeId: updated.id,
        proofId: updated.proofId,
        category: updated.category,
        assignedTo: updated.assignedTo,
        assignedBy: user.id,
        assignedAt: updated.assignedAt?.toISOString(),
      });

      return this.formatDisputeResponse(updated);
    });
  }

  /**
   * Resolve a dispute (admin or assigned reviewer only).
   */
  async resolveDispute(
    user: AuthenticatedUser,
    organizationId: string,
    disputeId: string,
    input: ResolveDisputeDto,
  ) {
    await this.verifyOrganizationAccess(user, organizationId);

    const dispute = await this.prisma.proofDispute.findFirst({
      where: { id: disputeId, organizationId },
      select: { 
        id: true, 
        status: true, 
        proofId: true, 
        assignedTo: true,
        category: true,
      },
    });

    if (!dispute) {
      throw new NotFoundException("Dispute not found");
    }

    if (!dispute.status || (dispute.status !== DisputeStatus.OPEN && dispute.status !== DisputeStatus.ASSIGNED)) {
      throw new BadRequestException("Only open or assigned disputes can be resolved");
    }

    // Check authorization: admin or assigned reviewer
    const isAuthorized = user.role === "ADMIN" || 
      (dispute.assignedTo && dispute.assignedTo === user.id);
    
    if (!isAuthorized) {
      throw new ForbiddenException("Only administrators or assigned reviewers can resolve disputes");
    }

    // Validate resolution inputs
    if (!input.resolutionOutcome || input.resolutionOutcome.length > 100) {
      throw new BadRequestException("Resolution outcome required (max 100 characters)");
    }
    if (!input.resolutionReason || input.resolutionReason.length > 2000) {
      throw new BadRequestException("Resolution reason required (max 2000 characters)");
    }

    return await this.prisma.$transaction(async (tx) => {
      const updated = await tx.proofDispute.update({
        where: { id: disputeId },
        data: {
          status: DisputeStatus.RESOLVED,
          resolutionOutcome: input.resolutionOutcome,
          resolutionReason: input.resolutionReason,
          resolvedBy: user.id,
          resolvedAt: new Date(),
        },
        include: {
          proof: {
            select: { userId: true },
          },
        },
      });

      // Create audit log
      await tx.auditLog.create({
        data: {
          actorType: "User",
          actorId: user.id,
          action: "DISPUTE_RESOLVED",
          resourceType: "ProofDispute",
          resourceId: disputeId,
          metadata: {
            proofId: dispute.proofId,
            resolutionOutcome: input.resolutionOutcome,
            organizationId,
          },
        },
      });

      // Emit DISPUTE_RESOLVED domain event for notifications
      if (this.domainEventOutbox) {
        await this.domainEventOutbox.publish<DisputeDecisionNotificationPayload>(tx, {
          organizationId,
          eventType: "DISPUTE_RESOLVED",
          aggregateType: "ProofDispute",
          aggregateId: updated.id,
          payload: {
            disputeId: updated.id,
            proofId: updated.proofId,
            organizationId,
            category: updated.category,
            decisionType: "RESOLVED",
            status: updated.status,
            resolutionOutcome: updated.resolutionOutcome,
            resolutionReason: updated.resolutionReason,
            resolvedBy: user.id,
            resolvedAt: updated.resolvedAt?.toISOString(),
            participants: {
              proofOwnerId: updated.proof.userId,
              disputeSubmitterId: updated.submittedBy,
              assignedReviewerId: updated.assignedTo,
            },
          },
        });
      }

      this.emitWebhookEvent(organizationId, "dispute.resolved", {
        disputeId: updated.id,
        proofId: updated.proofId,
        category: updated.category,
        resolutionOutcome: updated.resolutionOutcome,
        resolvedBy: user.id,
        resolvedAt: updated.resolvedAt?.toISOString(),
      });

      return this.formatDisputeResponse(updated);
    });
  }

  /**
   * Get dispute statistics for organization.
   */
  async getDisputeStats(user: AuthenticatedUser, organizationId: string) {
    await this.verifyOrganizationAccess(user, organizationId);

    const stats = await this.prisma.proofDispute.groupBy({
      by: ["status", "category"],
      where: { organizationId },
      _count: true,
    });

    const result: Record<string, Record<string, number>> = {};
    
    for (const stat of stats) {
      if (!result[stat.status]) {
        result[stat.status] = {};
      }
      result[stat.status][stat.category] = stat._count;
    }

    return result;
  }

  // Private helper methods

  private async verifyOrganizationAccess(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<void> {
    if (user.role === "ADMIN") {
      // Admins have access to all organizations
      return;
    }

    const membership = await this.prisma.organizationMember.findFirst({
      where: {
        userId: user.id,
        organizationId,
        status: "ACTIVE",
      },
    });

    if (!membership) {
      throw new ForbiddenException("Access denied to this organization");
    }
  }

  private isValidCommitment(commitment: string): boolean {
    // Validate SHA-256 hash format: sha256:hexstring
    return /^sha256:[a-fA-F0-9]{64}$/.test(commitment);
  }

  private formatDisputeResponse(dispute: any) {
    return {
      id: dispute.id,
      proofId: dispute.proofId,
      category: dispute.category,
      status: dispute.status,
      evidenceCommitment: dispute.evidenceCommitment,
      submittedBy: dispute.submittedBy,
      assignedTo: dispute.assignedTo,
      resolutionOutcome: dispute.resolutionOutcome,
      resolutionReason: dispute.resolutionReason,
      resolvedBy: dispute.resolvedBy,
      submittedAt: dispute.submittedAt.toISOString(),
      assignedAt: dispute.assignedAt?.toISOString() ?? null,
      resolvedAt: dispute.resolvedAt?.toISOString() ?? null,
      withdrawnAt: dispute.withdrawnAt?.toISOString() ?? null,
      metadata: dispute.metadata,
      proof: dispute.proof ? {
        id: dispute.proof.id,
        type: dispute.proof.proofType,
        status: dispute.proof.status,
        createdAt: dispute.proof.createdAt?.toISOString(),
        expiresAt: dispute.proof.expiresAt?.toISOString(),
      } : undefined,
    };
  }

  private emitWebhookEvent(
    organizationId: string,
    eventType: string,
    data: Record<string, any>,
  ): void {
    (this.webhookDeliveryService as any)
      ?.enqueueForOrganization(organizationId, eventType as any, { event: eventType, data } as never)
      .catch((error: any) => {
        this.logger.warn("Failed to enqueue webhook event", {
          organizationId,
          eventType,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}