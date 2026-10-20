import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  AccessReviewCampaignStatus,
  AccessReviewDecision,
  OrganizationMemberRole,
  ResourceStatus,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { OrganizationMembersService } from './organization-members.service';
import { AccessReviewService } from './access-review.service';

describe('AccessReviewService', () => {
  let service: AccessReviewService;
  let prismaService: jest.Mocked<PrismaService>;
  let membersService: jest.Mocked<OrganizationMembersService>;

  const mockUser = {
    id: 'user-1',
    walletAddress: 'GABC123',
    role: 'ADMIN' as const,
    status: 'ACTIVE' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockPrisma = {
      organization: {
        findUnique: jest.fn(),
      },
      accessReviewCampaign: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      accessReviewEntry: {
        create: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      organizationMember: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccessReviewService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: OrganizationMembersService,
          useValue: {
            canManageOrganization: jest.fn(),
            canViewOrganization: jest.fn(),
            removeMember: jest.fn(),
            updateMemberRole: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AccessReviewService>(AccessReviewService);
    prismaService = module.get(PrismaService);
    membersService = module.get(OrganizationMembersService);
  });

  describe('createReview', () => {
    it('should create access review campaign with member snapshot', async () => {
      const orgId = 'org-1';
      const input = {
        name: 'Q1 2025 Review',
        description: 'Quarterly access review',
      };

      const mockOrg = { revision: 5 };
      const mockMembers = [
        {
          id: 'member-1',
          role: OrganizationMemberRole.ADMIN,
          user: { walletAddress: 'GABC123' },
        },
        {
          id: 'member-2',
          role: OrganizationMemberRole.MEMBER,
          user: { walletAddress: 'GDEF456' },
        },
      ];

      const mockCampaign = {
        id: 'campaign-1',
        organizationId: orgId,
        createdById: mockUser.id,
        name: input.name,
        description: input.description,
        status: AccessReviewCampaignStatus.OPEN,
        snapshotVersion: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      membersService.canManageOrganization.mockResolvedValue(true);
      prismaService.organization.findUnique.mockResolvedValue(mockOrg as any);

      prismaService.$transaction.mockImplementation(async (callback) => {
        const txMock = {
          accessReviewCampaign: {
            create: jest.fn().mockResolvedValue(mockCampaign),
          },
          organizationMember: {
            findMany: jest.fn().mockResolvedValue(mockMembers),
          },
          accessReviewEntry: {
            create: jest.fn(),
          },
        };
        return callback(txMock);
      });

      prismaService.accessReviewCampaign.findUnique.mockResolvedValue({
        ...mockCampaign,
        entries: [],
        entryCount: 2,
        reviewedCount: 0,
        pendingCount: 2,
      } as any);

      const result = await service.createReview(mockUser, orgId, input);

      expect(result.name).toBe(input.name);
      expect(result.snapshotVersion).toBe(5);
      expect(result.status).toBe(AccessReviewCampaignStatus.OPEN);
      expect(prismaService.$transaction).toHaveBeenCalled();
    });

    it('should reject unauthorized user', async () => {
      const orgId = 'org-1';
      const input = { name: 'Test Review' };

      membersService.canManageOrganization.mockResolvedValue(false);

      await expect(service.createReview(mockUser, orgId, input)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('reviewEntry', () => {
    it('should record review decision', async () => {
      const orgId = 'org-1';
      const reviewId = 'review-1';
      const entryId = 'entry-1';
      const decision = {
        decision: AccessReviewDecision.CONFIRM,
        notes: 'Access confirmed',
      };

      const mockCampaign = {
        id: reviewId,
        organizationId: orgId,
        status: AccessReviewCampaignStatus.OPEN,
      };

      const mockEntry = {
        id: entryId,
        campaignId: reviewId,
        memberId: 'member-1',
        snapshotRole: OrganizationMemberRole.MEMBER,
        member: { id: 'member-1' },
      };

      const mockCurrentMember = {
        id: 'member-1',
        role: OrganizationMemberRole.MEMBER,
        status: ResourceStatus.ACTIVE,
      };

      membersService.canManageOrganization.mockResolvedValue(true);
      prismaService.accessReviewCampaign.findFirst.mockResolvedValue(mockCampaign as any);
      prismaService.accessReviewEntry.findFirst.mockResolvedValue(mockEntry as any);
      prismaService.organizationMember.findUnique.mockResolvedValue(mockCurrentMember as any);

      await service.reviewEntry(mockUser, orgId, reviewId, entryId, decision);

      expect(prismaService.accessReviewEntry.update).toHaveBeenCalledWith({
        where: { id: entryId },
        data: {
          decision: AccessReviewDecision.CONFIRM,
          recommendedRole: undefined,
          reviewedById: mockUser.id,
          reviewedAt: expect.any(Date),
          conflictDetected: false,
          notes: 'Access confirmed',
        },
      });
    });

    it('should detect membership conflicts', async () => {
      const orgId = 'org-1';
      const reviewId = 'review-1';
      const entryId = 'entry-1';
      const decision = { decision: AccessReviewDecision.CONFIRM };

      const mockEntry = {
        id: entryId,
        snapshotRole: OrganizationMemberRole.MEMBER,
        member: { id: 'member-1' },
      };

      // Member role changed since snapshot
      const mockCurrentMember = {
        id: 'member-1',
        role: OrganizationMemberRole.ADMIN, // Different from snapshot
        status: ResourceStatus.ACTIVE,
      };

      membersService.canManageOrganization.mockResolvedValue(true);
      prismaService.accessReviewCampaign.findFirst.mockResolvedValue({
        status: AccessReviewCampaignStatus.OPEN,
      } as any);
      prismaService.accessReviewEntry.findFirst.mockResolvedValue(mockEntry as any);
      prismaService.organizationMember.findUnique.mockResolvedValue(mockCurrentMember as any);

      await service.reviewEntry(mockUser, orgId, reviewId, entryId, decision);

      expect(prismaService.accessReviewEntry.update).toHaveBeenCalledWith({
        where: { id: entryId },
        data: expect.objectContaining({
          conflictDetected: true,
        }),
      });
    });

    it('should handle role change recommendation', async () => {
      const decision = {
        decision: AccessReviewDecision.ROLE_CHANGE,
        recommendedRole: OrganizationMemberRole.ADMIN,
        notes: 'Promote to admin',
      };

      membersService.canManageOrganization.mockResolvedValue(true);
      prismaService.accessReviewCampaign.findFirst.mockResolvedValue({
        status: AccessReviewCampaignStatus.OPEN,
      } as any);
      prismaService.accessReviewEntry.findFirst.mockResolvedValue({
        member: { id: 'member-1' },
        snapshotRole: OrganizationMemberRole.MEMBER,
      } as any);
      prismaService.organizationMember.findUnique.mockResolvedValue({
        role: OrganizationMemberRole.MEMBER,
        status: ResourceStatus.ACTIVE,
      } as any);

      await service.reviewEntry(mockUser, 'org-1', 'review-1', 'entry-1', decision);

      expect(prismaService.accessReviewEntry.update).toHaveBeenCalledWith({
        where: { id: 'entry-1' },
        data: expect.objectContaining({
          decision: AccessReviewDecision.ROLE_CHANGE,
          recommendedRole: OrganizationMemberRole.ADMIN,
        }),
      });
    });
  });

  describe('applyRecommendations', () => {
    it('should apply approved role changes and removals', async () => {
      const orgId = 'org-1';
      const reviewId = 'review-1';

      const mockEntries = [
        {
          id: 'entry-1',
          decision: AccessReviewDecision.ROLE_CHANGE,
          recommendedRole: OrganizationMemberRole.ADMIN,
          memberId: 'member-1',
          appliedAt: null,
          conflictDetected: false,
          member: { id: 'member-1' },
        },
        {
          id: 'entry-2',
          decision: AccessReviewDecision.REMOVE,
          memberId: 'member-2',
          appliedAt: null,
          conflictDetected: false,
          member: { id: 'member-2' },
        },
      ];

      membersService.canManageOrganization.mockResolvedValue(true);
      prismaService.accessReviewEntry.findMany.mockResolvedValue(mockEntries as any);
      membersService.updateMemberRole.mockResolvedValue({} as any);
      membersService.removeMember.mockResolvedValue();

      const result = await service.applyRecommendations(mockUser, orgId, reviewId);

      expect(result.applied).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);

      expect(membersService.updateMemberRole).toHaveBeenCalledWith(
        mockUser,
        orgId,
        'member-1',
        { role: OrganizationMemberRole.ADMIN },
      );
      expect(membersService.removeMember).toHaveBeenCalledWith(mockUser, orgId, 'member-2');

      expect(prismaService.accessReviewEntry.update).toHaveBeenCalledTimes(2);
    });

    it('should handle application failures gracefully', async () => {
      const mockEntries = [
        {
          id: 'entry-1',
          decision: AccessReviewDecision.REMOVE,
          memberId: 'member-1',
          appliedAt: null,
          conflictDetected: false,
          member: { id: 'member-1' },
        },
      ];

      membersService.canManageOrganization.mockResolvedValue(true);
      prismaService.accessReviewEntry.findMany.mockResolvedValue(mockEntries as any);
      membersService.removeMember.mockRejectedValue(new Error('Cannot remove final owner'));

      const result = await service.applyRecommendations(mockUser, 'org-1', 'review-1');

      expect(result.applied).toBe(0);
      expect(result.failed).toBe(1);
    });
  });
});