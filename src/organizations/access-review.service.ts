import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AccessReviewCampaignStatus,
  AccessReviewDecision,
  OrganizationMemberRole,
  ResourceStatus,
} from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { OrganizationMembersService } from "./organization-members.service";
import { CreateAccessReviewDto } from "./dto/create-access-review.dto";
import {
  AccessReviewCampaignDto,
  ListAccessReviewsDto,
} from "./dto/access-review-response.dto";
import { ReviewEntryDecisionDto } from "./dto/review-entry-decision.dto";

@Injectable()
export class AccessReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membersService: OrganizationMembersService,
  ) {}

  async createReview(
    user: AuthenticatedUser,
    organizationId: string,
    input: CreateAccessReviewDto,
  ): Promise<AccessReviewCampaignDto> {
    // Verify user has permission to manage this organization
    const canManage = await this.membersService.canManageOrganization(user, organizationId);
    if (!canManage) {
      throw new ForbiddenException(
        "You do not have permission to create access reviews for this organization",
      );
    }

    // Get current organization revision for snapshot versioning
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { revision: true },
    });

    if (!organization) {
      throw new NotFoundException("Organization not found");
    }

    // Create the review campaign and snapshot entries in a transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Create the campaign
      const campaign = await tx.accessReviewCampaign.create({
        data: {
          organizationId,
          createdById: user.id,
          name: input.name,
          description: input.description,
          status: AccessReviewCampaignStatus.OPEN,
          snapshotVersion: organization.revision,
        },
      });

      // Get current active members for snapshot
      const members = await tx.organizationMember.findMany({
        where: {
          organizationId,
          status: ResourceStatus.ACTIVE,
        },
        include: {
          user: {
            select: { walletAddress: true },
          },
        },
      });

      // Create review entries for each member
      await Promise.all(
        members.map((member) =>
          tx.accessReviewEntry.create({
            data: {
              campaignId: campaign.id,
              memberId: member.id,
              snapshotRole: member.role,
            },
          }),
        ),
      );

      return campaign;
    });

    // Log audit event
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action: "CREATE",
        resourceType: "AccessReviewCampaign",
        resourceId: result.id,
        metadata: {
          organizationId,
          name: input.name,
          snapshotVersion: result.snapshotVersion,
        },
      },
    });

    return this.toCampaignDto(await this.getCampaignWithStats(result.id));
  }

  async getReview(
    user: AuthenticatedUser,
    organizationId: string,
    reviewId: string,
    includeEntries = false,
  ): Promise<AccessReviewCampaignDto> {
    const canView = await this.membersService.canViewOrganization(user, organizationId);
    if (!canView) {
      throw new NotFoundException("Organization not found");
    }

    const campaign = await this.prisma.accessReviewCampaign.findFirst({
      where: {
        id: reviewId,
        organizationId,
      },
      include: {
        entries: includeEntries
          ? {
              include: {
                member: {
                  include: {
                    user: {
                      select: { walletAddress: true },
                    },
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            }
          : false,
      },
    });

    if (!campaign) {
      throw new NotFoundException("Access review campaign not found");
    }

    return this.toCampaignDto(campaign);
  }

  async listReviews(
    user: AuthenticatedUser,
    organizationId: string,
    query: ListAccessReviewsDto,
  ): Promise<{
    items: AccessReviewCampaignDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const canView = await this.membersService.canViewOrganization(user, organizationId);
    if (!canView) {
      throw new NotFoundException("Organization not found");
    }

    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: any = { organizationId };
    if (query.status) {
      where.status = query.status;
    }

    const [campaigns, total] = await Promise.all([
      this.prisma.accessReviewCampaign.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.accessReviewCampaign.count({ where }),
    ]);

    // Get stats for each campaign
    const campaignsWithStats = await Promise.all(
      campaigns.map((campaign) => this.getCampaignWithStats(campaign.id)),
    );

    return {
      items: campaignsWithStats.map((campaign) => this.toCampaignDto(campaign)),
      total,
      page,
      limit,
    };
  }

  async reviewEntry(
    user: AuthenticatedUser,
    organizationId: string,
    reviewId: string,
    entryId: string,
    decision: ReviewEntryDecisionDto,
  ): Promise<void> {
    const canManage = await this.membersService.canManageOrganization(user, organizationId);
    if (!canManage) {
      throw new ForbiddenException(
        "You do not have permission to review entries for this organization",
      );
    }

    // Get the campaign and entry
    const campaign = await this.prisma.accessReviewCampaign.findFirst({
      where: {
        id: reviewId,
        organizationId,
        status: AccessReviewCampaignStatus.OPEN,
      },
    });

    if (!campaign) {
      throw new NotFoundException("Active access review campaign not found");
    }

    const entry = await this.prisma.accessReviewEntry.findFirst({
      where: {
        id: entryId,
        campaignId: reviewId,
      },
      include: {
        member: true,
      },
    });

    if (!entry) {
      throw new NotFoundException("Review entry not found");
    }

    // Check for conflicts (membership changed since snapshot)
    const currentMember = await this.prisma.organizationMember.findUnique({
      where: { id: entry.memberId },
    });

    const conflictDetected = !currentMember || 
      currentMember.role !== entry.snapshotRole ||
      currentMember.status !== ResourceStatus.ACTIVE;

    // Update the entry
    await this.prisma.accessReviewEntry.update({
      where: { id: entryId },
      data: {
        decision: decision.decision,
        recommendedRole: decision.recommendedRole,
        reviewedById: user.id,
        reviewedAt: new Date(),
        conflictDetected,
        notes: decision.notes,
      },
    });

    // Log audit event
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action: "REVIEW",
        resourceType: "AccessReviewEntry",
        resourceId: entryId,
        metadata: {
          organizationId,
          campaignId: reviewId,
          memberId: entry.memberId,
          decision: decision.decision,
          recommendedRole: decision.recommendedRole,
          conflictDetected,
        },
      },
    });
  }

  async applyRecommendations(
    user: AuthenticatedUser,
    organizationId: string,
    reviewId: string,
  ): Promise<{ applied: number; skipped: number; failed: number }> {
    const canManage = await this.membersService.canManageOrganization(user, organizationId);
    if (!canManage) {
      throw new ForbiddenException(
        "You do not have permission to apply recommendations for this organization",
      );
    }

    // Get approved entries that haven't been applied yet
    const entries = await this.prisma.accessReviewEntry.findMany({
      where: {
        campaignId: reviewId,
        decision: { in: [AccessReviewDecision.ROLE_CHANGE, AccessReviewDecision.REMOVE] },
        appliedAt: null,
        conflictDetected: false,
      },
      include: {
        member: true,
      },
    });

    let applied = 0;
    let skipped = 0;
    let failed = 0;

    for (const entry of entries) {
      try {
        if (entry.decision === AccessReviewDecision.REMOVE) {
          // Use existing member service to remove member
          await this.membersService.removeMember(user, organizationId, entry.memberId);
          applied++;
        } else if (entry.decision === AccessReviewDecision.ROLE_CHANGE && entry.recommendedRole) {
          // Use existing member service to update role
          await this.membersService.updateMemberRole(user, organizationId, entry.memberId, {
            role: entry.recommendedRole,
          });
          applied++;
        } else {
          skipped++;
          continue;
        }

        // Mark as applied
        await this.prisma.accessReviewEntry.update({
          where: { id: entry.id },
          data: { appliedAt: new Date() },
        });
      } catch (error) {
        failed++;
        // Log the failure but continue with other entries
        console.error(`Failed to apply review entry ${entry.id}:`, error);
      }
    }

    // Log audit event
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action: "APPLY_RECOMMENDATIONS",
        resourceType: "AccessReviewCampaign",
        resourceId: reviewId,
        metadata: {
          organizationId,
          applied,
          skipped,
          failed,
        },
      },
    });

    return { applied, skipped, failed };
  }

  async completeReview(
    user: AuthenticatedUser,
    organizationId: string,
    reviewId: string,
  ): Promise<void> {
    const canManage = await this.membersService.canManageOrganization(user, organizationId);
    if (!canManage) {
      throw new ForbiddenException(
        "You do not have permission to complete reviews for this organization",
      );
    }

    const campaign = await this.prisma.accessReviewCampaign.findFirst({
      where: {
        id: reviewId,
        organizationId,
        status: AccessReviewCampaignStatus.OPEN,
      },
    });

    if (!campaign) {
      throw new NotFoundException("Active access review campaign not found");
    }

    await this.prisma.accessReviewCampaign.update({
      where: { id: reviewId },
      data: {
        status: AccessReviewCampaignStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    // Log audit event
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action: "COMPLETE",
        resourceType: "AccessReviewCampaign",
        resourceId: reviewId,
        metadata: {
          organizationId,
        },
      },
    });
  }

  async cancelReview(
    user: AuthenticatedUser,
    organizationId: string,
    reviewId: string,
  ): Promise<void> {
    const canManage = await this.membersService.canManageOrganization(user, organizationId);
    if (!canManage) {
      throw new ForbiddenException(
        "You do not have permission to cancel reviews for this organization",
      );
    }

    const campaign = await this.prisma.accessReviewCampaign.findFirst({
      where: {
        id: reviewId,
        organizationId,
        status: AccessReviewCampaignStatus.OPEN,
      },
    });

    if (!campaign) {
      throw new NotFoundException("Active access review campaign not found");
    }

    await this.prisma.accessReviewCampaign.update({
      where: { id: reviewId },
      data: {
        status: AccessReviewCampaignStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });

    // Log audit event
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action: "CANCEL",
        resourceType: "AccessReviewCampaign",
        resourceId: reviewId,
        metadata: {
          organizationId,
        },
      },
    });
  }

  private async getCampaignWithStats(campaignId: string) {
    const campaign = await this.prisma.accessReviewCampaign.findUnique({
      where: { id: campaignId },
      include: {
        entries: {
          include: {
            member: {
              include: {
                user: {
                  select: { walletAddress: true },
                },
              },
            },
          },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }

    const entryCount = campaign.entries.length;
    const reviewedCount = campaign.entries.filter((e) => e.reviewedAt !== null).length;
    const pendingCount = entryCount - reviewedCount;

    return {
      ...campaign,
      entryCount,
      reviewedCount,
      pendingCount,
    };
  }

  private toCampaignDto(campaign: any): AccessReviewCampaignDto {
    return {
      id: campaign.id,
      organizationId: campaign.organizationId,
      createdById: campaign.createdById,
      name: campaign.name,
      description: campaign.description,
      status: campaign.status,
      snapshotVersion: campaign.snapshotVersion,
      completedAt: campaign.completedAt,
      cancelledAt: campaign.cancelledAt,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      entryCount: campaign.entryCount,
      pendingCount: campaign.pendingCount,
      reviewedCount: campaign.reviewedCount,
      entries: campaign.entries?.map((entry: any) => ({
        id: entry.id,
        campaignId: entry.campaignId,
        memberId: entry.memberId,
        memberWalletAddress: entry.member?.user?.walletAddress,
        snapshotRole: entry.snapshotRole,
        decision: entry.decision,
        recommendedRole: entry.recommendedRole,
        reviewedById: entry.reviewedById,
        reviewedAt: entry.reviewedAt,
        appliedAt: entry.appliedAt,
        conflictDetected: entry.conflictDetected,
        notes: entry.notes,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })),
    };
  }
}