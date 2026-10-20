import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { MembershipImportStatus, MembershipImportRowResult, OrganizationMemberRole, ResourceStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { JobExecutionService } from '../jobs/execution/job-execution.service';
import { OrganizationMembersService } from './organization-members.service';
import { MembershipImportService } from './membership-import.service';

describe('MembershipImportService', () => {
  let service: MembershipImportService;
  let prismaService: jest.Mocked<PrismaService>;
  let jobExecutions: jest.Mocked<JobExecutionService>;
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
      membershipImportJob: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      membershipImportResult: {
        create: jest.fn(),
        update: jest.fn(),
      },
      organizationMember: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MembershipImportService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: JobExecutionService,
          useValue: {
            track: jest.fn(),
          },
        },
        {
          provide: OrganizationMembersService,
          useValue: {
            canManageOrganization: jest.fn(),
            canViewOrganization: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<MembershipImportService>(MembershipImportService);
    prismaService = module.get(PrismaService);
    jobExecutions = module.get(JobExecutionService);
    membersService = module.get(OrganizationMembersService);
  });

  describe('createImport', () => {
    it('should create import job successfully', async () => {
      const orgId = 'org-1';
      const input = {
        version: '1.0',
        filename: 'members.csv',
        members: [
          { walletAddress: 'GABC123', role: OrganizationMemberRole.MEMBER },
          { walletAddress: 'GDEF456', role: OrganizationMemberRole.VIEWER },
        ],
      };

      membersService.canManageOrganization.mockResolvedValue(true);
      prismaService.membershipImportJob.create.mockResolvedValue({
        id: 'import-1',
        organizationId: orgId,
        createdById: mockUser.id,
        version: '1.0',
        filename: 'members.csv',
        rowCount: 2,
        status: MembershipImportStatus.PENDING,
        progress: 0,
        cancelledAt: null,
        completedAt: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.createImport(mockUser, orgId, input);

      expect(result.status).toBe(MembershipImportStatus.PENDING);
      expect(result.rowCount).toBe(2);
      expect(prismaService.membershipImportJob.create).toHaveBeenCalled();
      expect(prismaService.membershipImportResult.create).toHaveBeenCalledTimes(2);
    });

    it('should reject import with duplicates', async () => {
      const orgId = 'org-1';
      const input = {
        members: [
          { walletAddress: 'GABC123', role: OrganizationMemberRole.MEMBER },
          { walletAddress: 'GABC123', role: OrganizationMemberRole.VIEWER }, // Duplicate
        ],
      };

      membersService.canManageOrganization.mockResolvedValue(true);

      await expect(service.createImport(mockUser, orgId, input)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should reject import exceeding maximum size', async () => {
      const orgId = 'org-1';
      const members = Array.from({ length: 1001 }, (_, i) => ({
        walletAddress: `GABC${i}`,
        role: OrganizationMemberRole.MEMBER,
      }));

      membersService.canManageOrganization.mockResolvedValue(true);

      await expect(service.createImport(mockUser, orgId, { members })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should reject unauthorized user', async () => {
      const orgId = 'org-1';
      const input = {
        members: [{ walletAddress: 'GABC123', role: OrganizationMemberRole.MEMBER }],
      };

      membersService.canManageOrganization.mockResolvedValue(false);

      await expect(service.createImport(mockUser, orgId, input)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('cancelImport', () => {
    it('should cancel pending import', async () => {
      const orgId = 'org-1';
      const importId = 'import-1';

      membersService.canManageOrganization.mockResolvedValue(true);
      prismaService.membershipImportJob.findFirst.mockResolvedValue({
        id: importId,
        organizationId: orgId,
        status: MembershipImportStatus.PENDING,
      } as any);

      await service.cancelImport(mockUser, orgId, importId);

      expect(prismaService.membershipImportJob.update).toHaveBeenCalledWith({
        where: { id: importId },
        data: {
          status: MembershipImportStatus.CANCELLED,
          cancelledAt: expect.any(Date),
        },
      });
    });
  });

  describe('processImportRow', () => {
    it('should handle user not found', async () => {
      prismaService.user.findUnique.mockResolvedValue(null);

      const result = await (service as any).processImportRow('org-1', {
        walletAddress: 'GABC123',
        requestedRole: OrganizationMemberRole.MEMBER,
      });

      expect(result.result).toBe(MembershipImportRowResult.REJECTED);
      expect(result.reasonCode).toBe('USER_NOT_FOUND');
    });

    it('should handle existing member with same role', async () => {
      const userId = 'user-1';
      prismaService.user.findUnique.mockResolvedValue({ id: userId } as any);
      prismaService.organizationMember.findUnique.mockResolvedValue({
        id: 'member-1',
        organizationId: 'org-1',
        userId,
        role: OrganizationMemberRole.MEMBER,
      } as any);

      const result = await (service as any).processImportRow('org-1', {
        walletAddress: 'GABC123',
        requestedRole: OrganizationMemberRole.MEMBER,
      });

      expect(result.result).toBe(MembershipImportRowResult.NO_OP);
      expect(result.reasonCode).toBe('ALREADY_MEMBER_SAME_ROLE');
    });

    it('should add new member successfully', async () => {
      const userId = 'user-1';
      prismaService.user.findUnique.mockResolvedValue({ id: userId } as any);
      prismaService.organizationMember.findUnique.mockResolvedValue(null);
      prismaService.organizationMember.create.mockResolvedValue({} as any);

      const result = await (service as any).processImportRow('org-1', {
        walletAddress: 'GABC123',
        requestedRole: OrganizationMemberRole.MEMBER,
      });

      expect(result.result).toBe(MembershipImportRowResult.ACCEPTED);
      expect(result.reasonCode).toBe('MEMBER_ADDED');
      expect(prismaService.organizationMember.create).toHaveBeenCalledWith({
        data: {
          organizationId: 'org-1',
          userId,
          role: OrganizationMemberRole.MEMBER,
          status: ResourceStatus.ACTIVE,
          joinedAt: expect.any(Date),
        },
      });
    });
  });
});