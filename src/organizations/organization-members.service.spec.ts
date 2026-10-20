import { Test, TestingModule } from "@nestjs/testing";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { OrganizationMembersService } from "./organization-members.service";
import { PrismaService } from "../database/prisma.service";
import { SessionService } from "../auth/session.service";
import { ResourceStatus, OrganizationMemberRole } from "@prisma/client";

describe("OrganizationMembersService", () => {
  let service: OrganizationMembersService;
  let prisma: PrismaService;
  let sessions: SessionService;

  const mockUser = {
    id: "user-1",
    walletAddress: "GXXXXXX1",
    role: "WORKER" as const,
    sessionId: "session-1",
  };

  const mockAdmin = {
    id: "admin-1",
    walletAddress: "GXXXXXX2",
    role: "ADMIN" as const,
    sessionId: "session-2",
  };

  const mockOrgId = "org-1";
  const mockTargetUserId = "user-2";

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationMembersService,
        {
          provide: PrismaService,
          useValue: {
            organizationMember: {
              create: jest.fn(),
              findUnique: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
            user: {
              findUnique: jest.fn(),
            },
            authSession: {
              findMany: jest.fn(),
              update: jest.fn(),
            },
            organization: {
              findUnique: jest.fn(),
            },
            auditLog: {
              create: jest.fn(),
            },
          },
        },
        {
          provide: SessionService,
          useValue: {
            invalidateSession: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<OrganizationMembersService>(
      OrganizationMembersService,
    );
    prisma = module.get<PrismaService>(PrismaService);
    sessions = module.get<SessionService>(SessionService);
  });

  describe("assignMember", () => {
    it("should assign a member with specified role", async () => {
      const input = { userId: mockTargetUserId, role: "MEMBER" as OrganizationMemberRole };
      const createdMember = {
        id: "member-1",
        organizationId: mockOrgId,
        userId: mockTargetUserId,
        role: "MEMBER",
        status: ResourceStatus.ACTIVE,
        joinedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { walletAddress: "GXXXXXX3" },
      };

      jest
        .spyOn(service as any, "ensureCanManageOrganization")
        .mockResolvedValue(undefined);
      jest
        .spyOn(prisma.user, "findUnique")
        .mockResolvedValue({ id: mockTargetUserId } as any);
      jest
        .spyOn(prisma.organizationMember, "findUnique")
        .mockResolvedValue(null);
      jest
        .spyOn(prisma.organizationMember, "create")
        .mockResolvedValue(createdMember as any);
      jest
        .spyOn(prisma.auditLog, "create")
        .mockResolvedValue({} as any);

      const result = await service.assignMember(mockUser, mockOrgId, input);

      expect(result.userId).toBe(mockTargetUserId);
      expect(result.role).toBe("MEMBER");
      expect(prisma.organizationMember.create).toHaveBeenCalled();
    });

    it("should throw ConflictException if user is already a member", async () => {
      const input = { userId: mockTargetUserId, role: "MEMBER" as OrganizationMemberRole };

      jest
        .spyOn(service as any, "ensureCanManageOrganization")
        .mockResolvedValue(undefined);
      jest
        .spyOn(prisma.user, "findUnique")
        .mockResolvedValue({ id: mockTargetUserId } as any);
      jest.spyOn(prisma.organizationMember, "findUnique").mockResolvedValue({
        id: "member-1",
        userId: mockTargetUserId,
      } as any);

      await expect(
        service.assignMember(mockUser, mockOrgId, input),
      ).rejects.toThrow(ConflictException);
    });

    it("should throw NotFoundException if target user does not exist", async () => {
      const input = { userId: "nonexistent", role: "MEMBER" as OrganizationMemberRole };

      jest
        .spyOn(service as any, "ensureCanManageOrganization")
        .mockResolvedValue(undefined);
      jest.spyOn(prisma.user, "findUnique").mockResolvedValue(null);

      await expect(
        service.assignMember(mockUser, mockOrgId, input),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("updateMemberRole", () => {
    it("should update member role successfully", async () => {
      const memberId = "member-1";
      const input = { role: "ADMIN" as OrganizationMemberRole };
      const existingMember = {
        id: memberId,
        organizationId: mockOrgId,
        userId: mockTargetUserId,
        role: "MEMBER",
        user: { walletAddress: "GXXXXXX3" },
      };
      const updatedMember = {
        ...existingMember,
        role: "ADMIN",
        updatedAt: new Date(),
      };

      jest
        .spyOn(service as any, "ensureIsOrganizationOwner")
        .mockResolvedValue(undefined);
      jest
        .spyOn(prisma.organizationMember, "findUnique")
        .mockResolvedValue(existingMember as any);
      jest
        .spyOn(prisma.organizationMember, "update")
        .mockResolvedValue(updatedMember as any);
      jest
        .spyOn(prisma.authSession, "findMany")
        .mockResolvedValue([]);
      jest
        .spyOn(prisma.auditLog, "create")
        .mockResolvedValue({} as any);

      const result = await service.updateMemberRole(
        mockAdmin,
        mockOrgId,
        memberId,
        input,
      );

      expect(result.role).toBe("ADMIN");
      expect(prisma.organizationMember.update).toHaveBeenCalled();
    });

    it("should prevent demoting the final owner", async () => {
      const memberId = "member-1";
      const input = { role: "ADMIN" as OrganizationMemberRole };
      const ownerMember = {
        id: memberId,
        organizationId: mockOrgId,
        userId: mockTargetUserId,
        role: "OWNER",
        user: { walletAddress: "GXXXXXX3" },
      };

      jest
        .spyOn(service as any, "ensureIsOrganizationOwner")
        .mockResolvedValue(undefined);
      jest
        .spyOn(prisma.organizationMember, "findUnique")
        .mockResolvedValue(ownerMember as any);
      jest
        .spyOn(prisma.organizationMember, "count")
        .mockResolvedValue(1); // Only one owner

      await expect(
        service.updateMemberRole(mockAdmin, mockOrgId, memberId, input),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should invalidate user sessions on role change", async () => {
      const memberId = "member-1";
      const input = { role: "ADMIN" as OrganizationMemberRole };
      const existingMember = {
        id: memberId,
        organizationId: mockOrgId,
        userId: mockTargetUserId,
        role: "MEMBER",
        user: { walletAddress: "GXXXXXX3" },
      };
      const updatedMember = {
        ...existingMember,
        role: "ADMIN",
      };

      jest
        .spyOn(service as any, "ensureIsOrganizationOwner")
        .mockResolvedValue(undefined);
      jest
        .spyOn(prisma.organizationMember, "findUnique")
        .mockResolvedValue(existingMember as any);
      jest
        .spyOn(prisma.organizationMember, "update")
        .mockResolvedValue(updatedMember as any);
      jest.spyOn(prisma.authSession, "findMany").mockResolvedValue([
        {
          id: "session-1",
          userId: mockTargetUserId,
          tokenHash: "hash1",
          createdAt: new Date(),
          expiresAt: new Date(),
          lastUsedAt: null,
          revokedAt: null,
          rotatedToId: null,
          rotatedFrom: null,
        },
      ] as any);
      jest
        .spyOn(prisma.authSession, "update")
        .mockResolvedValue({} as any);
      jest
        .spyOn(prisma.auditLog, "create")
        .mockResolvedValue({} as any);

      await service.updateMemberRole(mockAdmin, mockOrgId, memberId, input);

      expect(prisma.authSession.update).toHaveBeenCalled();
    });
  });

  describe("removeMember", () => {
    it("should remove member successfully", async () => {
      const memberId = "member-1";
      const member = {
        id: memberId,
        organizationId: mockOrgId,
        userId: mockTargetUserId,
        role: "MEMBER",
      };

      jest
        .spyOn(service as any, "ensureIsOrganizationOwner")
        .mockResolvedValue(undefined);
      jest
        .spyOn(prisma.organizationMember, "findUnique")
        .mockResolvedValue(member as any);
      jest
        .spyOn(prisma.organizationMember, "delete")
        .mockResolvedValue(member as any);
      jest
        .spyOn(prisma.authSession, "findMany")
        .mockResolvedValue([]);
      jest
        .spyOn(prisma.auditLog, "create")
        .mockResolvedValue({} as any);

      await service.removeMember(mockAdmin, mockOrgId, memberId);

      expect(prisma.organizationMember.delete).toHaveBeenCalledWith({
        where: { id: memberId },
      });
    });

    it("should prevent removing the final owner", async () => {
      const memberId = "member-1";
      const ownerMember = {
        id: memberId,
        organizationId: mockOrgId,
        userId: mockTargetUserId,
        role: "OWNER",
      };

      jest
        .spyOn(service as any, "ensureIsOrganizationOwner")
        .mockResolvedValue(undefined);
      jest
        .spyOn(prisma.organizationMember, "findUnique")
        .mockResolvedValue(ownerMember as any);
      jest
        .spyOn(prisma.organizationMember, "count")
        .mockResolvedValue(1); // Only one owner

      await expect(
        service.removeMember(mockAdmin, mockOrgId, memberId),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should throw NotFoundException if member not found", async () => {
      jest
        .spyOn(service as any, "ensureIsOrganizationOwner")
        .mockResolvedValue(undefined);
      jest
        .spyOn(prisma.organizationMember, "findUnique")
        .mockResolvedValue(null);

      await expect(
        service.removeMember(mockAdmin, mockOrgId, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getMemberRole", () => {
    it("should return member role if exists", async () => {
      const member = {
        id: "member-1",
        organizationId: mockOrgId,
        userId: mockUser.id,
        role: "ADMIN" as OrganizationMemberRole,
      };

      jest
        .spyOn(prisma.organizationMember, "findUnique")
        .mockResolvedValue(member as any);

      const result = await service.getMemberRole(mockUser.id, mockOrgId);

      expect(result).toBe("ADMIN");
    });

    it("should return null if member does not exist", async () => {
      jest
        .spyOn(prisma.organizationMember, "findUnique")
        .mockResolvedValue(null);

      const result = await service.getMemberRole(mockUser.id, mockOrgId);

      expect(result).toBeNull();
    });
  });

  describe("canManageOrganization", () => {
    it("should allow global admins", async () => {
      const result = await service.canManageOrganization(mockAdmin, mockOrgId);
      expect(result).toBe(true);
    });

    it("should allow organization owners", async () => {
      jest.spyOn(service, "getMemberRole").mockResolvedValue("OWNER");

      const result = await service.canManageOrganization(mockUser, mockOrgId);
      expect(result).toBe(true);
    });

    it("should allow organization admins", async () => {
      jest.spyOn(service, "getMemberRole").mockResolvedValue("ADMIN");

      const result = await service.canManageOrganization(mockUser, mockOrgId);
      expect(result).toBe(true);
    });

    it("should deny members and viewers", async () => {
      jest.spyOn(service, "getMemberRole").mockResolvedValue("MEMBER");

      const result = await service.canManageOrganization(mockUser, mockOrgId);
      expect(result).toBe(false);
    });
  });

  describe("canViewOrganization", () => {
    it("should allow global admins", async () => {
      const result = await service.canViewOrganization(mockAdmin, mockOrgId);
      expect(result).toBe(true);
    });

    it("should allow organization members", async () => {
      jest.spyOn(service, "getMemberRole").mockResolvedValue("MEMBER");

      const result = await service.canViewOrganization(mockUser, mockOrgId);
      expect(result).toBe(true);
    });

    it("should allow organization creators", async () => {
      jest
        .spyOn(prisma.organization, "findUnique")
        .mockResolvedValue({ id: mockOrgId, createdById: mockUser.id } as any);

      const result = await service.canViewOrganization(mockUser, mockOrgId);
      expect(result).toBe(true);
    });

    it("should deny non-members", async () => {
      jest
        .spyOn(prisma.organization, "findUnique")
        .mockResolvedValue({ id: mockOrgId, createdById: "other-user" } as any);
      jest.spyOn(service, "getMemberRole").mockResolvedValue(null);

      const result = await service.canViewOrganization(mockUser, mockOrgId);
      expect(result).toBe(false);
    });
  });

  describe("listMembers", () => {
    it("should list organization members with pagination", async () => {
      const members = [
        {
          id: "member-1",
          userId: "user-1",
          role: "OWNER",
          status: ResourceStatus.ACTIVE,
          user: { walletAddress: "GXXXXXX1" },
        },
      ];

      jest
        .spyOn(service as any, "ensureCanViewOrganization")
        .mockResolvedValue(undefined);
      jest
        .spyOn(prisma.organizationMember, "findMany")
        .mockResolvedValue(members as any);
      jest.spyOn(prisma.organizationMember, "count").mockResolvedValue(1);

      const result = await service.listMembers(mockUser, mockOrgId, {});

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
    });

    it("should filter members by role", async () => {
      jest
        .spyOn(service as any, "ensureCanViewOrganization")
        .mockResolvedValue(undefined);
      jest
        .spyOn(prisma.organizationMember, "findMany")
        .mockResolvedValue([]);
      jest.spyOn(prisma.organizationMember, "count").mockResolvedValue(0);

      await service.listMembers(mockUser, mockOrgId, { role: "OWNER" });

      expect(prisma.organizationMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: "OWNER" }),
        }),
      );
    });
  });
});
