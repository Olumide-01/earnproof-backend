import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, ResourceStatus, UserRole } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { AccountStatusReason } from "../auth/account-status.policy";
import { UsersService } from "./users.service";

const ADMIN: AuthenticatedUser = {
  id: "user_admin",
  walletAddress: "GADMIN",
  walletHash: `sha256:${"a".repeat(64)}`,
  role: "ADMIN",
};
const TARGET_ID = "user_target";

function adminView(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    displayName: null,
    role: UserRole.WORKER,
    status: ResourceStatus.ACTIVE,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    lastLoginAt: null,
    ...overrides,
  };
}

/** A Prisma double whose `$transaction` runs the callback against `tx`. */
function makePrisma(current: { status?: ResourceStatus; role?: UserRole } | null) {
  const tx = {
    user: {
      findUnique: jest.fn().mockResolvedValue(
        current === null
          ? null
          : { status: ResourceStatus.ACTIVE, role: UserRole.WORKER, ...current },
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(async () => adminView()),
    },
    authSession: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    organization: { count: jest.fn().mockResolvedValue(0) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  return { prisma, tx, service: new UsersService(prisma as never) };
}

describe("UsersService", () => {
  describe("getProfile", () => {
    it("returns the caller's profile without the wallet hash", async () => {
      const { prisma, service } = makePrisma(null);
      prisma.user.findUnique.mockResolvedValue({ id: "user_1", walletAddress: "GSELF" });

      await expect(service.getProfile("user_1")).resolves.toEqual({
        id: "user_1",
        walletAddress: "GSELF",
      });

      const { where, select } = prisma.user.findUnique.mock.calls[0][0];
      expect(where).toEqual({ id: "user_1" });
      expect(select).not.toHaveProperty("walletHash");
      expect(select.walletAddress).toBe(true);
    });

    it("throws 404 when the account no longer exists", async () => {
      const { prisma, service } = makePrisma(null);
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getProfile("gone")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("updateProfile", () => {
    it("writes only displayName for the session's own user", async () => {
      const { prisma, service } = makePrisma(null);
      prisma.user.update.mockResolvedValue({ id: "user_1", displayName: "Ada" });

      await service.updateProfile("user_1", { displayName: "Ada" });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user_1" },
        data: { displayName: "Ada" },
        select: expect.not.objectContaining({ walletHash: true }),
      });
    });

    it("clears displayName when null is sent", async () => {
      const { prisma, service } = makePrisma(null);
      prisma.user.update.mockResolvedValue({ id: "user_1", displayName: null });

      await service.updateProfile("user_1", { displayName: null });

      expect(prisma.user.update.mock.calls[0][0].data).toEqual({ displayName: null });
    });

    it("is a read, not a write, when no field is supplied", async () => {
      const { prisma, service } = makePrisma(null);
      prisma.user.findUnique.mockResolvedValue({ id: "user_1" });

      await service.updateProfile("user_1", {});

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.findUnique).toHaveBeenCalled();
    });

    it("maps a vanished row to 404", async () => {
      const { prisma, service } = makePrisma(null);
      prisma.user.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("missing", {
          code: "P2025",
          clientVersion: "test",
        }),
      );

      await expect(
        service.updateProfile("gone", { displayName: "x" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("getUser", () => {
    it("selects neither wallet address nor wallet hash", async () => {
      const { prisma, service } = makePrisma(null);
      prisma.user.findUnique.mockResolvedValue(adminView());

      await service.getUser(TARGET_ID);

      const { select } = prisma.user.findUnique.mock.calls[0][0];
      expect(select).not.toHaveProperty("walletHash");
      expect(select).not.toHaveProperty("walletAddress");
    });

    it("throws 404 for an unknown id", async () => {
      const { prisma, service } = makePrisma(null);
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getUser("missing")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("changeStatus", () => {
    it.each([
      [ResourceStatus.ACTIVE, ResourceStatus.SUSPENDED, 3],
      [ResourceStatus.ACTIVE, ResourceStatus.REVOKED, 3],
      [ResourceStatus.SUSPENDED, ResourceStatus.REVOKED, 3],
      [ResourceStatus.PENDING, ResourceStatus.SUSPENDED, 3],
      [ResourceStatus.SUSPENDED, ResourceStatus.ACTIVE, 3],
      [ResourceStatus.PENDING, ResourceStatus.ACTIVE, 0],
    ])("%s -> %s commits the change and revokes %d sessions", async (from, to, revoked) => {
      const { tx, service } = makePrisma({ status: from });
      tx.user.findUniqueOrThrow.mockResolvedValue(adminView({ status: to }));

      const result = await service.changeStatus(ADMIN, TARGET_ID, { status: to });

      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: { id: TARGET_ID, status: from },
        data: { status: to },
      });
      expect(result).toMatchObject({ status: to, previousStatus: from, sessionsRevoked: revoked });
      if (revoked > 0) {
        expect(tx.authSession.updateMany).toHaveBeenCalledWith({
          where: { userId: TARGET_ID, revokedAt: null },
          data: { revokedAt: expect.any(Date) },
        });
      } else {
        expect(tx.authSession.updateMany).not.toHaveBeenCalled();
      }
    });

    it("audits actor, target, transition and reason without wallet material", async () => {
      const { tx, service } = makePrisma({ status: ResourceStatus.ACTIVE });

      await service.changeStatus(ADMIN, TARGET_ID, {
        status: ResourceStatus.SUSPENDED,
        reason: AccountStatusReason.SECURITY_INCIDENT,
      });

      const { data } = tx.auditLog.create.mock.calls[0][0];
      expect(data).toEqual({
        actorType: "user",
        actorId: ADMIN.id,
        action: "user.status_changed",
        resourceType: "user",
        resourceId: TARGET_ID,
        metadata: {
          previousStatus: ResourceStatus.ACTIVE,
          newStatus: ResourceStatus.SUSPENDED,
          reason: AccountStatusReason.SECURITY_INCIDENT,
          sessionsRevoked: 3,
        },
      });
      const serialised = JSON.stringify(data);
      expect(serialised).not.toContain("sha256:");
      expect(serialised).not.toContain(ADMIN.walletAddress);
    });

    it.each([
      [ResourceStatus.REVOKED, ResourceStatus.ACTIVE],
      [ResourceStatus.REVOKED, ResourceStatus.SUSPENDED],
      [ResourceStatus.DELETED, ResourceStatus.ACTIVE],
      [ResourceStatus.ACTIVE, ResourceStatus.ACTIVE],
      [ResourceStatus.SUSPENDED, ResourceStatus.SUSPENDED],
    ])("rejects %s -> %s with 409 and writes nothing", async (from, to) => {
      const { tx, service } = makePrisma({ status: from });

      await expect(
        service.changeStatus(ADMIN, TARGET_ID, { status: to }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.user.updateMany).not.toHaveBeenCalled();
      expect(tx.authSession.updateMany).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("forbids an administrator from changing their own status", async () => {
      const { prisma, service } = makePrisma({ status: ResourceStatus.ACTIVE });

      await expect(
        service.changeStatus(ADMIN, ADMIN.id, { status: ResourceStatus.SUSPENDED }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("returns 404 for an unknown account", async () => {
      const { tx, service } = makePrisma(null);

      await expect(
        service.changeStatus(ADMIN, "missing", { status: ResourceStatus.SUSPENDED }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("rejects a concurrent change that moved the status after it was read", async () => {
      const { tx, service } = makePrisma({ status: ResourceStatus.ACTIVE });
      tx.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.changeStatus(ADMIN, TARGET_ID, { status: ResourceStatus.SUSPENDED }),
      ).rejects.toThrow("changed concurrently");
      expect(tx.authSession.updateMany).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("fails the whole change when the audit write fails (fail-closed)", async () => {
      const { tx, service } = makePrisma({ status: ResourceStatus.ACTIVE });
      tx.auditLog.create.mockRejectedValue(new Error("audit store unavailable"));

      await expect(
        service.changeStatus(ADMIN, TARGET_ID, { status: ResourceStatus.SUSPENDED }),
      ).rejects.toThrow("audit store unavailable");
    });
  });

  describe("changeRole", () => {
    it("changes the role conditionally on the role and status that were read", async () => {
      const { tx, service } = makePrisma({ role: UserRole.WORKER });
      tx.user.findUniqueOrThrow.mockResolvedValue(adminView({ role: UserRole.DEVELOPER }));

      const result = await service.changeRole(ADMIN, TARGET_ID, { role: UserRole.DEVELOPER });

      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: { id: TARGET_ID, role: UserRole.WORKER, status: ResourceStatus.ACTIVE },
        data: { role: UserRole.DEVELOPER },
      });
      expect(result).toMatchObject({ role: UserRole.DEVELOPER, previousRole: UserRole.WORKER });
      expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: "user.role_changed",
        resourceType: "user",
        resourceId: TARGET_ID,
        actorId: ADMIN.id,
        metadata: { previousRole: UserRole.WORKER, newRole: UserRole.DEVELOPER },
      });
    });

    it("does not revoke sessions: the guard reads the role live", async () => {
      const { tx, service } = makePrisma({ role: UserRole.DEVELOPER });

      await service.changeRole(ADMIN, TARGET_ID, { role: UserRole.ISSUER });

      expect(tx.authSession.updateMany).not.toHaveBeenCalled();
    });

    it("refuses to demote an owner of a live organization to WORKER", async () => {
      const { tx, service } = makePrisma({ role: UserRole.ADMIN });
      tx.organization.count.mockResolvedValue(2);

      await expect(
        service.changeRole(ADMIN, TARGET_ID, { role: UserRole.WORKER }),
      ).rejects.toThrow("owns 2 live organization(s)");
      expect(tx.organization.count).toHaveBeenCalledWith({
        where: {
          createdById: TARGET_ID,
          status: { in: [ResourceStatus.ACTIVE, ResourceStatus.PENDING, ResourceStatus.SUSPENDED] },
        },
      });
      expect(tx.user.updateMany).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("allows demotion to WORKER once no live organization is owned", async () => {
      const { tx, service } = makePrisma({ role: UserRole.DEVELOPER });
      tx.organization.count.mockResolvedValue(0);

      await service.changeRole(ADMIN, TARGET_ID, { role: UserRole.WORKER });

      expect(tx.user.updateMany).toHaveBeenCalled();
    });

    it("skips the ownership check for roles that may own organizations", async () => {
      const { tx, service } = makePrisma({ role: UserRole.ADMIN });

      await service.changeRole(ADMIN, TARGET_ID, { role: UserRole.DEVELOPER });

      expect(tx.organization.count).not.toHaveBeenCalled();
    });

    it.each([ResourceStatus.SUSPENDED, ResourceStatus.REVOKED, ResourceStatus.PENDING])(
      "rejects a role change for a %s account",
      async (status) => {
        const { tx, service } = makePrisma({ status, role: UserRole.WORKER });

        await expect(
          service.changeRole(ADMIN, TARGET_ID, { role: UserRole.ADMIN }),
        ).rejects.toThrow("Role changes require an active account");
        expect(tx.user.updateMany).not.toHaveBeenCalled();
      },
    );

    it("rejects a no-op role change", async () => {
      const { tx, service } = makePrisma({ role: UserRole.ISSUER });

      await expect(
        service.changeRole(ADMIN, TARGET_ID, { role: UserRole.ISSUER }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("forbids an administrator from changing their own role", async () => {
      const { prisma, service } = makePrisma({ role: UserRole.ADMIN });

      await expect(
        service.changeRole(ADMIN, ADMIN.id, { role: UserRole.WORKER }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("returns 404 for an unknown account", async () => {
      const { service } = makePrisma(null);

      await expect(
        service.changeRole(ADMIN, "missing", { role: UserRole.ADMIN }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a concurrent change detected by the conditional write", async () => {
      const { tx, service } = makePrisma({ role: UserRole.WORKER });
      tx.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.changeRole(ADMIN, TARGET_ID, { role: UserRole.DEVELOPER }),
      ).rejects.toThrow("changed concurrently");
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
  });
});
