import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  OrganizationInvitation,
  OrganizationInvitationStatus,
  OrganizationMemberRole,
  ResourceStatus,
} from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { sha256 } from "../common/crypto/hash";
import { FixedClock } from "../../test/time/fixed-clock";
import {
  DEFAULT_INVITATION_TTL_SECONDS,
  MAX_INVITATION_TTL_SECONDS,
  MIN_INVITATION_TTL_SECONDS,
  OrganizationInvitationsService,
} from "./organization-invitations.service";

describe("OrganizationInvitationsService", () => {
  let service: OrganizationInvitationsService;
  let prisma: any;
  let clock: FixedClock;

  const ORG_ID = "org_test_123";
  const OTHER_ORG_ID = "org_other_456";
  const WALLET_INVITER = "GBWM4FST7D2Q5YJ6F2R2L3D7Y4Y5W6E7R8T9Y0U1I2O3P4A5S6D7F8G9";
  const WALLET_INVITEE = "GA2C5RFPE6GCKMY3Z4BDTJNNCYDCPQDZJNO5ZPBG6R7CQBFE5QDKQ6Y7";
  const WALLET_ATTACKER = "GC3D6RGQE7HDLNZ4A5CEUKODZKO6AQEAKO7ARCG7S8DRCGFE6RELR7Z8";

  const adminUser: AuthenticatedUser = {
    id: "user_admin",
    walletAddress: WALLET_INVITER,
    walletHash: sha256(WALLET_INVITER),
    role: "WORKER",
  };

  const ownerUser: AuthenticatedUser = {
    id: "user_owner",
    walletAddress: WALLET_INVITER,
    walletHash: sha256(WALLET_INVITER),
    role: "WORKER",
  };

  const inviteeUser: AuthenticatedUser = {
    id: "user_invitee",
    walletAddress: WALLET_INVITEE,
    walletHash: sha256(WALLET_INVITEE),
    role: "WORKER",
  };

  const wrongWalletUser: AuthenticatedUser = {
    id: "user_attacker",
    walletAddress: WALLET_ATTACKER,
    walletHash: sha256(WALLET_ATTACKER),
    role: "WORKER",
  };

  beforeEach(() => {
    clock = new FixedClock("2026-10-22T10:00:00.000Z");

    prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          id: ORG_ID,
          name: "Test Org",
          archivedAt: null,
          deletedAt: null,
        }),
      },
      organizationMember: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.organizationId_userId) {
            const { userId, organizationId } = where.organizationId_userId;
            if (organizationId === ORG_ID && userId === "user_admin") {
              return Promise.resolve({
                id: "mem_admin",
                organizationId,
                userId,
                role: OrganizationMemberRole.ADMIN,
                status: ResourceStatus.ACTIVE,
              });
            }
            if (organizationId === ORG_ID && userId === "user_owner") {
              return Promise.resolve({
                id: "mem_owner",
                organizationId,
                userId,
                role: OrganizationMemberRole.OWNER,
                status: ResourceStatus.ACTIVE,
              });
            }
          }
          return Promise.resolve(null);
        }),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: "mem_new_123",
            ...data,
          }),
        ),
      },
      organizationInvitation: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: "inv_12345",
            createdAt: clock.now(),
            updatedAt: clock.now(),
            acceptedAt: null,
            acceptedById: null,
            declinedAt: null,
            declinedById: null,
            revokedAt: null,
            revokedById: null,
            ...data,
          }),
        ),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            organizationId: ORG_ID,
            role: OrganizationMemberRole.MEMBER,
            recipientWalletAddress: WALLET_INVITEE,
            recipientWalletHash: sha256(WALLET_INVITEE),
            secretHash: "some_hash",
            createdAt: clock.now(),
            updatedAt: clock.now(),
            ...data,
          }),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: "audit_1" }),
      },
      appendAuditLog: jest.fn().mockResolvedValue({ id: "audit_tx_1" }),
      $transaction: jest.fn().mockImplementation((callback) => callback(prisma)),
    };

    service = new OrganizationInvitationsService(prisma, clock);
  });

  describe("createInvitation", () => {
    it("successfully creates a single-use invitation with hashed secret and bounded expiry", async () => {
      const result = await service.createInvitation(adminUser, ORG_ID, {
        recipientWalletAddress: WALLET_INVITEE,
        role: OrganizationMemberRole.MEMBER,
      });

      expect(result.id).toBe("inv_12345");
      expect(result.token).toBeDefined();
      expect(result.token).toContain("inv_12345.");
      expect(result.role).toBe(OrganizationMemberRole.MEMBER);
      expect(result.recipientWalletAddress).toBe(WALLET_INVITEE);
      expect(result.recipientWalletHash).toBe(sha256(WALLET_INVITEE));
      expect(result.status).toBe(OrganizationInvitationStatus.PENDING);

      // Verify expiration is bounded by default 7 days
      const expectedExpiry = new Date(
        clock.now().getTime() + DEFAULT_INVITATION_TTL_SECONDS * 1000,
      );
      expect(result.expiresAt).toEqual(expectedExpiry);

      // Verify DB creation stored ONLY secretHash, not raw token
      expect(prisma.organizationInvitation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          role: OrganizationMemberRole.MEMBER,
          inviterId: adminUser.id,
          recipientWalletAddress: WALLET_INVITEE,
          recipientWalletHash: sha256(WALLET_INVITEE),
          secretHash: expect.any(String),
          status: OrganizationInvitationStatus.PENDING,
          expiresAt: expectedExpiry,
        }),
      });

      // Verify audit event was logged without raw secret
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "organization.invitation.created",
            resourceType: "OrganizationInvitation",
            resourceId: "inv_12345",
            metadata: expect.objectContaining({
              organizationId: ORG_ID,
              invitationId: "inv_12345",
              role: OrganizationMemberRole.MEMBER,
              recipientWalletHash: sha256(WALLET_INVITEE),
            }),
          }),
        }),
      );
    });

    it("revokes existing pending invitations for the same recipient wallet in the org", async () => {
      await service.createInvitation(adminUser, ORG_ID, {
        recipientWalletAddress: WALLET_INVITEE,
        role: OrganizationMemberRole.MEMBER,
      });

      expect(prisma.organizationInvitation.updateMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          recipientWalletAddress: WALLET_INVITEE,
          status: OrganizationInvitationStatus.PENDING,
        },
        data: {
          status: OrganizationInvitationStatus.REVOKED,
          revokedAt: clock.now(),
          revokedById: adminUser.id,
        },
      });
    });

    it("respects custom valid TTL", async () => {
      const customTtl = 86400; // 1 day
      const result = await service.createInvitation(adminUser, ORG_ID, {
        recipientWalletAddress: WALLET_INVITEE,
        role: OrganizationMemberRole.MEMBER,
        ttlSeconds: customTtl,
      });

      const expectedExpiry = new Date(clock.now().getTime() + customTtl * 1000);
      expect(result.expiresAt).toEqual(expectedExpiry);
    });

    it("rejects TTL below minimum bound (300 seconds)", async () => {
      await expect(
        service.createInvitation(adminUser, ORG_ID, {
          recipientWalletAddress: WALLET_INVITEE,
          role: OrganizationMemberRole.MEMBER,
          ttlSeconds: MIN_INVITATION_TTL_SECONDS - 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects TTL above maximum bound (30 days)", async () => {
      await expect(
        service.createInvitation(adminUser, ORG_ID, {
          recipientWalletAddress: WALLET_INVITEE,
          role: OrganizationMemberRole.MEMBER,
          ttlSeconds: MAX_INVITATION_TTL_SECONDS + 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects if recipient is already an active member of the organization", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: "user_existing" });
      prisma.organizationMember.findUnique.mockImplementation(({ where }) => {
        if (where.organizationId_userId) {
          const { userId } = where.organizationId_userId;
          if (userId === adminUser.id) {
            return Promise.resolve({
              id: "mem_admin",
              organizationId: ORG_ID,
              userId,
              role: OrganizationMemberRole.ADMIN,
              status: ResourceStatus.ACTIVE,
            });
          }
          if (userId === "user_existing") {
            return Promise.resolve({
              id: "mem_existing",
              organizationId: ORG_ID,
              userId,
              role: OrganizationMemberRole.MEMBER,
              status: ResourceStatus.ACTIVE,
            });
          }
        }
        return Promise.resolve(null);
      });

      await expect(
        service.createInvitation(adminUser, ORG_ID, {
          recipientWalletAddress: WALLET_INVITEE,
          role: OrganizationMemberRole.MEMBER,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("refuses ADMIN caller attempting to invite OWNER role (privilege elevation)", async () => {
      await expect(
        service.createInvitation(adminUser, ORG_ID, {
          recipientWalletAddress: WALLET_INVITEE,
          role: OrganizationMemberRole.OWNER,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows OWNER caller to invite OWNER role", async () => {
      const result = await service.createInvitation(ownerUser, ORG_ID, {
        recipientWalletAddress: WALLET_INVITEE,
        role: OrganizationMemberRole.OWNER,
      });

      expect(result.role).toBe(OrganizationMemberRole.OWNER);
    });

    it("rejects when organization is archived", async () => {
      prisma.organization.findUnique.mockResolvedValueOnce({
        id: ORG_ID,
        archivedAt: new Date("2026-01-01"),
      });

      await expect(
        service.createInvitation(adminUser, ORG_ID, {
          recipientWalletAddress: WALLET_INVITEE,
          role: OrganizationMemberRole.MEMBER,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("inspectInvitation", () => {
    let rawToken: string;
    let savedInvitation: OrganizationInvitation;

    beforeEach(async () => {
      const created = await service.createInvitation(adminUser, ORG_ID, {
        recipientWalletAddress: WALLET_INVITEE,
        role: OrganizationMemberRole.MEMBER,
      });
      rawToken = created.token;
      const secret = rawToken.split(".")[1];

      savedInvitation = {
        id: created.id,
        organizationId: ORG_ID,
        role: OrganizationMemberRole.MEMBER,
        inviterId: adminUser.id,
        recipientWalletAddress: WALLET_INVITEE,
        recipientWalletHash: sha256(WALLET_INVITEE),
        secretHash: sha256(secret),
        status: OrganizationInvitationStatus.PENDING,
        expiresAt: created.expiresAt,
        acceptedAt: null,
        acceptedById: null,
        declinedAt: null,
        declinedById: null,
        revokedAt: null,
        revokedById: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      };

      prisma.organizationInvitation.findUnique.mockImplementation(({ where }) => {
        if (where.id === savedInvitation.id || where.secretHash === savedInvitation.secretHash) {
          return Promise.resolve({
            ...savedInvitation,
            organization: { name: "Test Org" },
          });
        }
        return Promise.resolve(null);
      });
    });

    it("inspects a valid invitation by token without exposing secret hashes", async () => {
      const details = await service.inspectInvitation(rawToken);

      expect(details.id).toBe(savedInvitation.id);
      expect(details.organizationId).toBe(ORG_ID);
      expect(details.organizationName).toBe("Test Org");
      expect(details.role).toBe(OrganizationMemberRole.MEMBER);
      expect(details.recipientWalletAddress).toBe(WALLET_INVITEE);
      expect(details.status).toBe(OrganizationInvitationStatus.PENDING);
      expect((details as any).secretHash).toBeUndefined();
      expect((details as any).token).toBeUndefined();
    });

    it("inspects a valid invitation by id", async () => {
      const details = await service.inspectInvitation(savedInvitation.id);
      expect(details.id).toBe(savedInvitation.id);
    });

    it("marks status as EXPIRED when inspected past expiresAt", async () => {
      clock.advanceMs(DEFAULT_INVITATION_TTL_SECONDS * 1000 + 1000);
      const details = await service.inspectInvitation(rawToken);

      expect(details.status).toBe(OrganizationInvitationStatus.EXPIRED);
    });

    it("fails closed on cross-tenant inspection", async () => {
      await expect(
        service.inspectInvitation(rawToken, OTHER_ORG_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException on invalid token", async () => {
      await expect(
        service.inspectInvitation("inv_invalid.secret_invalid"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("acceptInvitation", () => {
    let rawToken: string;
    let savedInvitation: OrganizationInvitation;

    beforeEach(async () => {
      const created = await service.createInvitation(adminUser, ORG_ID, {
        recipientWalletAddress: WALLET_INVITEE,
        role: OrganizationMemberRole.MEMBER,
      });
      rawToken = created.token;
      const secret = rawToken.split(".")[1];

      savedInvitation = {
        id: created.id,
        organizationId: ORG_ID,
        role: OrganizationMemberRole.MEMBER,
        inviterId: adminUser.id,
        recipientWalletAddress: WALLET_INVITEE,
        recipientWalletHash: sha256(WALLET_INVITEE),
        secretHash: sha256(secret),
        status: OrganizationInvitationStatus.PENDING,
        expiresAt: created.expiresAt,
        acceptedAt: null,
        acceptedById: null,
        declinedAt: null,
        declinedById: null,
        revokedAt: null,
        revokedById: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      };

      prisma.organizationInvitation.findUnique.mockImplementation(({ where }) => {
        if (where.id === savedInvitation.id || where.secretHash === savedInvitation.secretHash) {
          return Promise.resolve({
            ...savedInvitation,
            organization: { name: "Test Org" },
          });
        }
        return Promise.resolve(null);
      });
    });

    it("successfully accepts invitation, transitions status, and creates membership atomically", async () => {
      const result = await service.acceptInvitation(inviteeUser, {
        token: rawToken,
      });

      expect(result.invitation.status).toBe(OrganizationInvitationStatus.ACCEPTED);
      expect(result.invitation.acceptedAt).toBeDefined();
      expect(result.invitation.acceptedById).toBe(inviteeUser.id);
      expect(result.membership.role).toBe(OrganizationMemberRole.MEMBER);
      expect(result.membership.organizationId).toBe(ORG_ID);
      expect(result.membership.userId).toBe(inviteeUser.id);

      expect(prisma.organizationMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          userId: inviteeUser.id,
          role: OrganizationMemberRole.MEMBER,
          status: ResourceStatus.ACTIVE,
        }),
      });

      expect(prisma.appendAuditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          data: expect.objectContaining({
            action: "organization.invitation.accepted",
            resourceType: "OrganizationInvitation",
            resourceId: savedInvitation.id,
          }),
        }),
      );
    });

    it("fails closed on wrong-wallet acceptance", async () => {
      await expect(
        service.acceptInvitation(wrongWalletUser, { token: rawToken }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("fails closed on cross-tenant acceptance", async () => {
      await expect(
        service.acceptInvitation(inviteeUser, {
          token: rawToken,
          organizationId: OTHER_ORG_ID,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("fails closed on expired invitation acceptance", async () => {
      clock.advanceMs(DEFAULT_INVITATION_TTL_SECONDS * 1000 + 1000);

      await expect(
        service.acceptInvitation(inviteeUser, { token: rawToken }),
      ).rejects.toThrow(BadRequestException);
    });

    it("fails closed on revoked invitation acceptance", async () => {
      savedInvitation.status = OrganizationInvitationStatus.REVOKED;
      savedInvitation.revokedAt = clock.now();

      await expect(
        service.acceptInvitation(inviteeUser, { token: rawToken }),
      ).rejects.toThrow(ConflictException);
    });

    it("fails closed on replay acceptance (already accepted)", async () => {
      savedInvitation.status = OrganizationInvitationStatus.ACCEPTED;
      savedInvitation.acceptedAt = clock.now();

      await expect(
        service.acceptInvitation(inviteeUser, { token: rawToken }),
      ).rejects.toThrow(ConflictException);
    });

    it("fails closed if user is already a member", async () => {
      prisma.organizationMember.findUnique.mockResolvedValueOnce({
        id: "mem_existing",
        organizationId: ORG_ID,
        userId: inviteeUser.id,
        role: OrganizationMemberRole.MEMBER,
        status: ResourceStatus.ACTIVE,
      });

      await expect(
        service.acceptInvitation(inviteeUser, { token: rawToken }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("declineInvitation", () => {
    let rawToken: string;
    let savedInvitation: OrganizationInvitation;

    beforeEach(async () => {
      const created = await service.createInvitation(adminUser, ORG_ID, {
        recipientWalletAddress: WALLET_INVITEE,
        role: OrganizationMemberRole.MEMBER,
      });
      rawToken = created.token;
      const secret = rawToken.split(".")[1];

      savedInvitation = {
        id: created.id,
        organizationId: ORG_ID,
        role: OrganizationMemberRole.MEMBER,
        inviterId: adminUser.id,
        recipientWalletAddress: WALLET_INVITEE,
        recipientWalletHash: sha256(WALLET_INVITEE),
        secretHash: sha256(secret),
        status: OrganizationInvitationStatus.PENDING,
        expiresAt: created.expiresAt,
        acceptedAt: null,
        acceptedById: null,
        declinedAt: null,
        declinedById: null,
        revokedAt: null,
        revokedById: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      };

      prisma.organizationInvitation.findUnique.mockImplementation(({ where }) => {
        if (where.id === savedInvitation.id || where.secretHash === savedInvitation.secretHash) {
          return Promise.resolve({
            ...savedInvitation,
            organization: { name: "Test Org" },
          });
        }
        return Promise.resolve(null);
      });
    });

    it("successfully declines invitation and logs audit event", async () => {
      const result = await service.declineInvitation(inviteeUser, {
        token: rawToken,
      });

      expect(result.status).toBe(OrganizationInvitationStatus.DECLINED);
      expect(result.declinedAt).toBeDefined();
      expect(result.declinedById).toBe(inviteeUser.id);
      expect(prisma.appendAuditLog).toHaveBeenCalled();
    });

    it("fails closed on wrong-wallet decline", async () => {
      await expect(
        service.declineInvitation(wrongWalletUser, { token: rawToken }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("fails closed on cross-tenant decline", async () => {
      await expect(
        service.declineInvitation(inviteeUser, {
          token: rawToken,
          organizationId: OTHER_ORG_ID,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("revokeInvitation", () => {
    let savedInvitation: OrganizationInvitation;

    beforeEach(() => {
      savedInvitation = {
        id: "inv_to_revoke",
        organizationId: ORG_ID,
        role: OrganizationMemberRole.MEMBER,
        inviterId: adminUser.id,
        recipientWalletAddress: WALLET_INVITEE,
        recipientWalletHash: sha256(WALLET_INVITEE),
        secretHash: "some_hash",
        status: OrganizationInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 100000),
        acceptedAt: null,
        acceptedById: null,
        declinedAt: null,
        declinedById: null,
        revokedAt: null,
        revokedById: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      };

      prisma.organizationInvitation.findUnique.mockResolvedValue(savedInvitation);
    });

    it("successfully revokes pending invitation by organization admin", async () => {
      const result = await service.revokeInvitation(adminUser, ORG_ID, "inv_to_revoke");

      expect(result.status).toBe(OrganizationInvitationStatus.REVOKED);
      expect(prisma.organizationInvitation.update).toHaveBeenCalledWith({
        where: { id: "inv_to_revoke" },
        data: expect.objectContaining({
          status: OrganizationInvitationStatus.REVOKED,
          revokedById: adminUser.id,
        }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "organization.invitation.revoked",
          }),
        }),
      );
    });

    it("refuses revoking already accepted invitation", async () => {
      savedInvitation.status = OrganizationInvitationStatus.ACCEPTED;

      await expect(
        service.revokeInvitation(adminUser, ORG_ID, "inv_to_revoke"),
      ).rejects.toThrow(ConflictException);
    });

    it("is idempotent on already revoked invitation", async () => {
      savedInvitation.status = OrganizationInvitationStatus.REVOKED;

      const result = await service.revokeInvitation(adminUser, ORG_ID, "inv_to_revoke");
      expect(result.status).toBe(OrganizationInvitationStatus.REVOKED);
    });

    it("refuses unauthorized caller", async () => {
      await expect(
        service.revokeInvitation(wrongWalletUser, ORG_ID, "inv_to_revoke"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("listInvitations", () => {
    it("lists invitations with pagination and filtering", async () => {
      const mockInvitations = [
        {
          id: "inv_1",
          organizationId: ORG_ID,
          role: OrganizationMemberRole.MEMBER,
          inviterId: adminUser.id,
          recipientWalletAddress: WALLET_INVITEE,
          recipientWalletHash: sha256(WALLET_INVITEE),
          secretHash: "hash1",
          status: OrganizationInvitationStatus.PENDING,
          expiresAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      prisma.organizationInvitation.findMany.mockResolvedValue(mockInvitations);
      prisma.organizationInvitation.count.mockResolvedValue(1);

      const result = await service.listInvitations(adminUser, ORG_ID, {
        page: 1,
        limit: 10,
        status: OrganizationInvitationStatus.PENDING,
      });

      expect(result.total).toBe(1);
      expect(result.items.length).toBe(1);
      expect(result.items[0].id).toBe("inv_1");
      expect((result.items[0] as any).secretHash).toBeUndefined();
    });
  });

  describe("cleanupExpiredInvitations", () => {
    it("transitions pending invitations past expiry to EXPIRED", async () => {
      prisma.organizationInvitation.updateMany.mockResolvedValueOnce({ count: 5 });

      const result = await service.cleanupExpiredInvitations(ORG_ID);

      expect(result.reconciledCount).toBe(5);
      expect(prisma.organizationInvitation.updateMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          status: OrganizationInvitationStatus.PENDING,
          expiresAt: { lte: clock.now() },
        },
        data: {
          status: OrganizationInvitationStatus.EXPIRED,
        },
      });
    });

    it("reconciles across all organizations when organizationId is omitted", async () => {
      prisma.organizationInvitation.updateMany.mockResolvedValueOnce({ count: 12 });

      const result = await service.cleanupExpiredInvitations();

      expect(result.reconciledCount).toBe(12);
      expect(prisma.organizationInvitation.updateMany).toHaveBeenCalledWith({
        where: {
          status: OrganizationInvitationStatus.PENDING,
          expiresAt: { lte: clock.now() },
        },
        data: {
          status: OrganizationInvitationStatus.EXPIRED,
        },
      });
    });
  });
});
