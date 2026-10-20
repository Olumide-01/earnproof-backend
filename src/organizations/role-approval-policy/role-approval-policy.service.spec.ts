import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { OrganizationMemberRole, OrganizationRoleApprovalPolicy } from "@prisma/client";
import { AuthenticatedUser } from "../../auth/auth.types";
import { PrismaService } from "../../database/prisma.service";
import { UpdateRoleApprovalPolicyDto } from "./dto/role-approval-policy.dto";
import { RoleApprovalPolicyService } from "./role-approval-policy.service";

const ORG = "org-1";

function user(id: string, role: "ADMIN" | "WORKER" = "WORKER"): AuthenticatedUser {
  return { id, role, walletAddress: `G-${id}`, walletHash: `h-${id}` } as AuthenticatedUser;
}

const platformAdmin = user("platform-admin", "ADMIN");
const owner = user("owner");
const orgAdmin = user("org-admin");
const member = user("member");
const viewer = user("viewer");
const outsider = user("outsider");
const suspended = user("suspended");

/**
 * In-memory stand-in for the slice of Prisma the service uses. The unique
 * (organizationId, version) index is enforced, so concurrent updates race the
 * same way they would against PostgreSQL.
 */
function fakePrisma(options: { archived?: boolean; deleted?: boolean; missing?: boolean } = {}) {
  const rows: OrganizationRoleApprovalPolicy[] = [];
  const auditLogs: Array<Record<string, unknown>> = [];
  const memberships: Record<string, { role: OrganizationMemberRole; status: string }> = {
    owner: { role: "OWNER", status: "ACTIVE" },
    "org-admin": { role: "ADMIN", status: "ACTIVE" },
    member: { role: "MEMBER", status: "ACTIVE" },
    viewer: { role: "VIEWER", status: "ACTIVE" },
    suspended: { role: "OWNER", status: "SUSPENDED" },
  };
  let nextId = 1;

  const policy = {
    findFirst: jest.fn(async ({ where }: { where: { organizationId: string; status: string } }) => {
      const active = rows
        .filter((row) => row.organizationId === where.organizationId && row.status === where.status)
        .sort((a, b) => b.version - a.version);
      return active[0] ? { ...active[0] } : null;
    }),
    findMany: jest.fn(
      async ({
        where,
        take,
      }: {
        where: { organizationId: string; version?: { lt: number } };
        take: number;
      }) =>
        rows
          .filter(
            (row) =>
              row.organizationId === where.organizationId &&
              (where.version === undefined || row.version < where.version.lt),
          )
          .sort((a, b) => b.version - a.version)
          .slice(0, take)
          .map((row) => ({ ...row })),
    ),
    updateMany: jest.fn(async ({ where, data }: { where: { id: string; status: string }; data: { status: "SUPERSEDED" } }) => {
      const row = rows.find((candidate) => candidate.id === where.id && candidate.status === where.status);
      if (!row) return { count: 0 };
      row.status = data.status;
      return { count: 1 };
    }),
    create: jest.fn(async ({ data }: { data: Omit<OrganizationRoleApprovalPolicy, "id" | "status" | "createdAt"> }) => {
      if (rows.some((row) => row.organizationId === data.organizationId && row.version === data.version)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row = {
        ...data,
        id: `policy-${nextId++}`,
        status: "ACTIVE",
        createdAt: new Date("2026-10-17T00:00:00.000Z"),
      } as OrganizationRoleApprovalPolicy;
      rows.push(row);
      return { ...row };
    }),
  };

  const prisma = {
    organization: {
      findUnique: jest.fn(async () =>
        options.missing
          ? null
          : {
              archivedAt: options.archived ? new Date() : null,
              deletedAt: options.deleted ? new Date() : null,
            },
      ),
    },
    organizationMember: {
      findUnique: jest.fn(
        async ({ where }: { where: { organizationId_userId: { userId: string } } }) =>
          memberships[where.organizationId_userId.userId] ?? null,
      ),
    },
    organizationRoleApprovalPolicy: policy,
    auditLog: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => auditLogs.push(data)) },
    // Transactions are not isolated here; atomicity of the supersede+create
    // pair is what the conditional updateMany and the unique index provide.
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ organizationRoleApprovalPolicy: policy }),
    ),
  };

  return { prisma, rows, auditLogs };
}

function build(options?: Parameters<typeof fakePrisma>[0]) {
  const fake = fakePrisma(options);
  const service = new RoleApprovalPolicyService(fake.prisma as unknown as PrismaService);
  return { service, ...fake };
}

function update(overrides: Partial<UpdateRoleApprovalPolicyDto> = {}): UpdateRoleApprovalPolicyDto {
  return {
    protectedRoles: ["OWNER", "ADMIN"],
    approverRoles: ["OWNER", "ADMIN"],
    requiredApprovals: 2,
    approvalExpiryMinutes: 120,
    ownerChangesRequireOwnerApproval: true,
    expectedVersion: 0,
    ...overrides,
  };
}

describe("RoleApprovalPolicyService", () => {
  describe("getActive", () => {
    it("reports the platform default as version 0 when nothing is stored", async () => {
      const { service } = build();

      await expect(service.getActive(viewer, ORG)).resolves.toMatchObject({
        version: 0,
        isDefault: true,
        protectedRoles: ["OWNER", "ADMIN"],
        requiredApprovals: 1,
        separationOfDuties: { selfApprovalProhibited: true },
      });
    });

    it("returns the stored active version after an update", async () => {
      const { service } = build();
      await service.update(owner, ORG, update());

      await expect(service.getActive(member, ORG)).resolves.toMatchObject({
        version: 1,
        isDefault: false,
        requiredApprovals: 2,
      });
    });
  });

  describe("authorization", () => {
    it("rejects a non-member for every operation", async () => {
      const { service } = build();

      await expect(service.getActive(outsider, ORG)).rejects.toThrow(ForbiddenException);
      await expect(service.history(outsider, ORG, {})).rejects.toThrow(ForbiddenException);
      await expect(service.preview(outsider, ORG, update())).rejects.toThrow(ForbiddenException);
      await expect(service.update(outsider, ORG, update())).rejects.toThrow(ForbiddenException);
    });

    it("treats a suspended membership as no membership", async () => {
      const { service } = build();
      await expect(service.getActive(suspended, ORG)).rejects.toThrow(ForbiddenException);
    });

    it("only lets an OWNER or platform ADMIN update", async () => {
      const { service, rows } = build();

      await expect(service.update(orgAdmin, ORG, update())).rejects.toThrow(ForbiddenException);
      await expect(service.update(member, ORG, update())).rejects.toThrow(ForbiddenException);
      expect(rows).toHaveLength(0);

      await expect(service.update(platformAdmin, ORG, update())).resolves.toMatchObject({ version: 1 });
    });

    it("lets an organization ADMIN preview but not a MEMBER", async () => {
      const { service } = build();

      await expect(service.preview(orgAdmin, ORG, update())).resolves.toMatchObject({ valid: true });
      await expect(service.preview(member, ORG, update())).rejects.toThrow(ForbiddenException);
    });

    it("reports a missing or deleted organization as not found", async () => {
      await expect(build({ missing: true }).service.getActive(platformAdmin, ORG)).rejects.toThrow(
        NotFoundException,
      );
      await expect(build({ deleted: true }).service.getActive(platformAdmin, ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("refuses updates while the organization is archived but still allows reads", async () => {
      const { service } = build({ archived: true });

      await expect(service.update(owner, ORG, update())).rejects.toThrow(ConflictException);
      await expect(service.getActive(owner, ORG)).resolves.toMatchObject({ version: 0 });
    });
  });

  describe("update", () => {
    it("creates version 1, then supersedes it with version 2", async () => {
      const { service, rows } = build();

      const first = await service.update(owner, ORG, update());
      const second = await service.update(owner, ORG, update({ requiredApprovals: 3, expectedVersion: 1 }));

      expect(first.version).toBe(1);
      expect(second).toMatchObject({ version: 2, supersedesId: first.supersedesId ?? "policy-1" });
      expect(rows.map((row) => [row.version, row.status])).toEqual([
        [1, "SUPERSEDED"],
        [2, "ACTIVE"],
      ]);
    });

    it("refuses a policy that weakens platform minimums and lists the violations", async () => {
      const { service, rows } = build();

      const error = await service
        .update(owner, ORG, update({ protectedRoles: ["OWNER"], requiredApprovals: 0 }))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        violations: [
          expect.objectContaining({ code: "PROTECTED_ROLES_BELOW_PLATFORM_MINIMUM" }),
          expect.objectContaining({ code: "REQUIRED_APPROVALS_OUT_OF_RANGE" }),
        ],
      });
      expect(rows).toHaveLength(0);
    });

    it("refuses an attempt to permit self-approval", async () => {
      const { service, rows } = build();

      await expect(
        service.update(owner, ORG, update({ selfApprovalProhibited: false })),
      ).rejects.toThrow(BadRequestException);
      expect(rows).toHaveLength(0);
    });

    it("rejects a stale expectedVersion with 409", async () => {
      const { service } = build();
      await service.update(owner, ORG, update());

      await expect(
        service.update(owner, ORG, update({ requiredApprovals: 3, expectedVersion: 0 })),
      ).rejects.toThrow(/expected version 0 but version 1 is active/);
    });

    it("rejects a replay of a successful update with 409", async () => {
      const { service, rows } = build();
      const dto = update();

      await service.update(owner, ORG, dto);
      await expect(service.update(owner, ORG, dto)).rejects.toThrow(ConflictException);
      expect(rows).toHaveLength(1);
    });

    it("rejects an update identical to the active version", async () => {
      const { service } = build();

      await expect(
        service.update(owner, ORG, {
          protectedRoles: ["OWNER", "ADMIN"],
          approverRoles: ["OWNER", "ADMIN"],
          requiredApprovals: 1,
          approvalExpiryMinutes: 1440,
          ownerChangesRequireOwnerApproval: true,
          expectedVersion: 0,
        }),
      ).rejects.toThrow(/identical/);
    });

    it("lets exactly one of two concurrent updates from the same base commit", async () => {
      const { service, rows } = build();

      const outcomes = await Promise.allSettled([
        service.update(owner, ORG, update({ requiredApprovals: 2 })),
        service.update(platformAdmin, ORG, update({ requiredApprovals: 3 })),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ConflictException);
      expect(rows.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
    });

    it("reports a lost supersede race as stale", async () => {
      const { service, prisma } = build();
      await service.update(owner, ORG, update());
      prisma.organizationRoleApprovalPolicy.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.update(owner, ORG, update({ requiredApprovals: 3, expectedVersion: 1 })),
      ).rejects.toThrow(/no longer active/);
    });

    it("propagates unexpected persistence errors unchanged", async () => {
      const { service, prisma } = build();
      prisma.organizationRoleApprovalPolicy.create.mockRejectedValueOnce(new Error("db down"));

      await expect(service.update(owner, ORG, update())).rejects.toThrow("db down");
    });

    it("audits the change with field names only", async () => {
      const { service, auditLogs } = build();
      await service.update(owner, ORG, update());

      expect(auditLogs).toEqual([
        expect.objectContaining({
          action: "organization.role_approval_policy.updated",
          organizationId: ORG,
          actorId: owner.id,
          metadata: {
            version: 1,
            previousVersion: 0,
            changedFields: ["requiredApprovals", "approvalExpiryMinutes"],
          },
        }),
      ]);
    });
  });

  describe("preview", () => {
    it("reports violations without saving or throwing", async () => {
      const { service, rows } = build();

      const result = await service.preview(owner, ORG, update({ approverRoles: ["MEMBER"] }));

      expect(result.valid).toBe(false);
      expect(result.violations.map((violation) => violation.code)).toEqual([
        "APPROVER_ROLE_NOT_PERMITTED",
        "OWNER_APPROVAL_REQUIRES_OWNER_APPROVER",
      ]);
      expect(result.proposed).toBeNull();
      expect(rows).toHaveLength(0);
    });

    it("diffs against the active version and flags staleness", async () => {
      const { service } = build();
      await service.update(owner, ORG, update());

      const result = await service.preview(owner, ORG, update({ requiredApprovals: 4, expectedVersion: 0 }));

      expect(result).toMatchObject({
        valid: true,
        currentVersion: 1,
        stale: true,
        changes: [{ field: "requiredApprovals", from: 2, to: 4 }],
      });
    });

    it("leaves staleness unknown when no expectedVersion is given", async () => {
      const { service } = build();
      const { expectedVersion, ...rest } = update();
      void expectedVersion;

      await expect(service.preview(owner, ORG, rest)).resolves.toMatchObject({ stale: null });
    });

    it("evaluates a sample role change under the proposed policy", async () => {
      const { service } = build();

      const result = await service.preview(owner, ORG, {
        ...update({ requiredApprovals: 3 }),
        sampleChange: { fromRole: "ADMIN", toRole: "OWNER" },
      });

      expect(result.sampleChange).toMatchObject({
        approvalRequired: true,
        requiredApprovals: 3,
        ownerApprovalRequired: true,
        eligibleApproverRoles: ["OWNER"],
      });
    });

    it("rejects a sample change that names neither role", async () => {
      const { service } = build();

      await expect(
        service.preview(owner, ORG, { ...update(), sampleChange: {} }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("history", () => {
    it("pages versions newest first with a version cursor", async () => {
      const { service } = build();
      for (let version = 0; version < 3; version += 1) {
        await service.update(owner, ORG, update({ requiredApprovals: version + 2, expectedVersion: version }));
      }

      const first = await service.history(viewer, ORG, { limit: 2 });
      expect(first.items.map((item) => item.version)).toEqual([3, 2]);
      expect(first.nextBeforeVersion).toBe(2);

      const second = await service.history(viewer, ORG, { limit: 2, beforeVersion: 2 });
      expect(second.items.map((item) => [item.version, item.status])).toEqual([[1, "SUPERSEDED"]]);
      expect(second.nextBeforeVersion).toBeNull();
    });

    it("is empty when only the platform default applies", async () => {
      const { service } = build();
      await expect(service.history(viewer, ORG, {})).resolves.toEqual({
        items: [],
        nextBeforeVersion: null,
      });
    });
  });
});
