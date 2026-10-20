import { ForbiddenException, NotFoundException, ConflictException } from "@nestjs/common";
import { OrganizationMembersService } from "../../src/organizations/organization-members.service";
import { OrganizationsService } from "../../src/organizations/organizations.service";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { integrationDatabase } from "./harness/database";
import { integrationModule } from "./harness/nest";
import { seedUser } from "./harness/fixtures";

/**
 * Organization membership integration tests.
 * Tests complete membership lifecycle against real PostgreSQL.
 */

const db = integrationDatabase();
const injector = integrationModule([
  OrganizationsService,
  OrganizationMembersService,
]);

function organizationsService(): OrganizationsService {
  return injector.get(OrganizationsService);
}

function membersService(): OrganizationMembersService {
  return injector.get(OrganizationMembersService);
}

async function authenticatedUser(seed: string): Promise<AuthenticatedUser> {
  const user = await seedUser(db.prisma, seed);
  return {
    id: user.id,
    walletAddress: user.walletAddress,
    walletHash: user.walletHash,
    role: user.role,
  };
}

describe("organization membership lifecycle", () => {
  describe("organization creation", () => {
    it("creates initial OWNER membership for creator", async () => {
      const admin = await authenticatedUser("membership-create-admin");
      const orgService = organizationsService();

      const org = await orgService.createOrganization(admin, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });

      // Verify membership was created
      const role = await membersService().getMemberRole(admin.id, org.id);
      expect(role).toBe("OWNER");

      // Verify member can be fetched
      const members = await db.prisma.organizationMember.findMany({
        where: { organizationId: org.id },
      });
      expect(members).toHaveLength(1);
      expect(members[0].userId).toBe(admin.id);
      expect(members[0].role).toBe("OWNER");
    });
  });

  describe("assignMember - positive cases", () => {
    it("allows owner to assign member with MEMBER role", async () => {
      const owner = await authenticatedUser("membership-owner");
      const target = await authenticatedUser("membership-target");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });

      // Assign member
      const result = await membersService_.assignMember(owner, org.id, {
        userId: target.id,
        role: "MEMBER",
      });

      expect(result.userId).toBe(target.id);
      expect(result.role).toBe("MEMBER");
      expect(result.organizationId).toBe(org.id);

      // Verify in database
      const role = await membersService_.getMemberRole(target.id, org.id);
      expect(role).toBe("MEMBER");
    });

    it("allows admin to assign member with different roles", async () => {
      const owner = await authenticatedUser("membership-admin-assign");
      const adminUser = await authenticatedUser("membership-org-admin");
      const target1 = await authenticatedUser("membership-target1");
      const target2 = await authenticatedUser("membership-target2");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization and assign admin
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });
      await membersService_.assignMember(owner, org.id, {
        userId: adminUser.id,
        role: "ADMIN",
      });

      // Admin assigns members
      await membersService_.assignMember(adminUser, org.id, {
        userId: target1.id,
        role: "MEMBER",
      });
      await membersService_.assignMember(adminUser, org.id, {
        userId: target2.id,
        role: "VIEWER",
      });

      const role1 = await membersService_.getMemberRole(target1.id, org.id);
      const role2 = await membersService_.getMemberRole(target2.id, org.id);
      expect(role1).toBe("MEMBER");
      expect(role2).toBe("VIEWER");
    });
  });

  describe("assignMember - negative cases", () => {
    it("prevents non-admin/owner from assigning members", async () => {
      const owner = await authenticatedUser("membership-member-assign-owner");
      const member = await authenticatedUser("membership-member-assigner");
      const target = await authenticatedUser("membership-assign-target");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization and assign member (not admin)
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });
      await membersService_.assignMember(owner, org.id, {
        userId: member.id,
        role: "MEMBER",
      });

      // Member tries to assign - should fail
      await expect(
        membersService_.assignMember(member, org.id, {
          userId: target.id,
          role: "MEMBER",
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("prevents duplicate membership", async () => {
      const owner = await authenticatedUser("membership-duplicate-owner");
      const target = await authenticatedUser("membership-duplicate-target");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization and assign member
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });
      await membersService_.assignMember(owner, org.id, {
        userId: target.id,
        role: "MEMBER",
      });

      // Try to assign again - should fail
      await expect(
        membersService_.assignMember(owner, org.id, {
          userId: target.id,
          role: "ADMIN",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("throws NotFoundException for nonexistent target user", async () => {
      const owner = await authenticatedUser("membership-notfound-owner");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });

      // Try to assign nonexistent user
      await expect(
        membersService_.assignMember(owner, org.id, {
          userId: "nonexistent",
          role: "MEMBER",
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("updateMemberRole - positive cases", () => {
    it("allows owner to update member role", async () => {
      const owner = await authenticatedUser("membership-role-update-owner");
      const target = await authenticatedUser("membership-role-update-target");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization and assign member
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });
      const member = await membersService_.assignMember(owner, org.id, {
        userId: target.id,
        role: "MEMBER",
      });

      // Update role
      const updated = await membersService_.updateMemberRole(
        owner,
        org.id,
        member.id,
        { role: "ADMIN" },
      );

      expect(updated.role).toBe("ADMIN");

      // Verify in database
      const role = await membersService_.getMemberRole(target.id, org.id);
      expect(role).toBe("ADMIN");
    });
  });

  describe("updateMemberRole - negative cases", () => {
    it("prevents non-owner from updating roles", async () => {
      const owner = await authenticatedUser("membership-role-update-not-owner");
      const member = await authenticatedUser("membership-role-updater");
      const target = await authenticatedUser("membership-role-update-tgt");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization and assign members
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });
      await membersService_.assignMember(owner, org.id, {
        userId: member.id,
        role: "ADMIN",
      });
      const targetMember = await membersService_.assignMember(owner, org.id, {
        userId: target.id,
        role: "MEMBER",
      });

      // Admin tries to update - should fail (only owner can)
      await expect(
        membersService_.updateMemberRole(member, org.id, targetMember.id, {
          role: "VIEWER",
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("prevents demoting the final owner", async () => {
      const owner = await authenticatedUser("membership-final-owner");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });

      // Get owner membership
      const members = await db.prisma.organizationMember.findMany({
        where: { organizationId: org.id, userId: owner.id },
      });
      expect(members).toHaveLength(1);

      // Try to demote owner - should fail
      await expect(
        membersService_.updateMemberRole(owner, org.id, members[0].id, {
          role: "ADMIN",
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows demoting owner if there's another owner", async () => {
      const owner1 = await authenticatedUser("membership-dual-owner1");
      const owner2 = await authenticatedUser("membership-dual-owner2");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization
      const org = await orgService.createOrganization(owner1, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });

      // Add second owner
      await membersService_.assignMember(owner1, org.id, {
        userId: owner2.id,
        role: "OWNER",
      });

      // Now demote first owner should succeed
      const members = await db.prisma.organizationMember.findMany({
        where: { organizationId: org.id, userId: owner1.id },
      });

      const updated = await membersService_.updateMemberRole(
        owner1,
        org.id,
        members[0].id,
        { role: "ADMIN" },
      );

      expect(updated.role).toBe("ADMIN");
    });
  });

  describe("removeMember - positive cases", () => {
    it("allows owner to remove member", async () => {
      const owner = await authenticatedUser("membership-remove-owner");
      const target = await authenticatedUser("membership-remove-target");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization and assign member
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });
      const member = await membersService_.assignMember(owner, org.id, {
        userId: target.id,
        role: "MEMBER",
      });

      // Remove member
      await membersService_.removeMember(owner, org.id, member.id);

      // Verify removed
      const role = await membersService_.getMemberRole(target.id, org.id);
      expect(role).toBeNull();
    });
  });

  describe("removeMember - negative cases", () => {
    it("prevents non-owner from removing members", async () => {
      const owner = await authenticatedUser("membership-remove-not-owner");
      const admin = await authenticatedUser("membership-remover");
      const target = await authenticatedUser("membership-remove-tgt");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization and assign members
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });
      await membersService_.assignMember(owner, org.id, {
        userId: admin.id,
        role: "ADMIN",
      });
      const targetMember = await membersService_.assignMember(owner, org.id, {
        userId: target.id,
        role: "MEMBER",
      });

      // Admin tries to remove - should fail
      await expect(
        membersService_.removeMember(admin, org.id, targetMember.id),
      ).rejects.toThrow(ForbiddenException);
    });

    it("prevents removing the final owner", async () => {
      const owner = await authenticatedUser("membership-remove-final-owner");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });

      // Get owner membership
      const members = await db.prisma.organizationMember.findMany({
        where: { organizationId: org.id, userId: owner.id },
      });

      // Try to remove owner - should fail
      await expect(
        membersService_.removeMember(owner, org.id, members[0].id),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("listMembers", () => {
    it("lists all members with pagination", async () => {
      const owner = await authenticatedUser("membership-list-owner");
      const members = await Promise.all(
        Array.from({ length: 5 }).map((_, i) =>
          authenticatedUser(`membership-list-member${i}`),
        ),
      );
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization and add members
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });
      for (const member of members) {
        await membersService_.assignMember(owner, org.id, {
          userId: member.id,
          role: "MEMBER",
        });
      }

      // List members
      const result = await membersService_.listMembers(owner, org.id, {});

      expect(result.items).toHaveLength(6); // 1 owner + 5 members
      expect(result.total).toBe(6);
      expect(result.page).toBe(1);
    });

    it("filters members by role", async () => {
      const owner = await authenticatedUser("membership-filter-owner");
      const admin = await authenticatedUser("membership-filter-admin");
      const member = await authenticatedUser("membership-filter-member");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create organization
      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });
      await membersService_.assignMember(owner, org.id, {
        userId: admin.id,
        role: "ADMIN",
      });
      await membersService_.assignMember(owner, org.id, {
        userId: member.id,
        role: "MEMBER",
      });

      // Filter by ADMIN role
      const adminResult = await membersService_.listMembers(owner, org.id, {
        role: "ADMIN",
      });
      expect(adminResult.items).toHaveLength(1);
      expect(adminResult.items[0].role).toBe("ADMIN");

      // Filter by MEMBER role
      const memberResult = await membersService_.listMembers(owner, org.id, {
        role: "MEMBER",
      });
      expect(memberResult.items).toHaveLength(1);
      expect(memberResult.items[0].role).toBe("MEMBER");
    });
  });

  describe("authorization checks", () => {
    it("canManageOrganization allows owners", async () => {
      const owner = await authenticatedUser("membership-manage-owner");
      const orgService = organizationsService();
      const membersService_ = membersService();

      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });

      const canManage = await membersService_.canManageOrganization(
        owner,
        org.id,
      );
      expect(canManage).toBe(true);
    });

    it("canViewOrganization allows members", async () => {
      const owner = await authenticatedUser("membership-view-owner");
      const member = await authenticatedUser("membership-viewer");
      const orgService = organizationsService();
      const membersService_ = membersService();

      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });
      await membersService_.assignMember(owner, org.id, {
        userId: member.id,
        role: "VIEWER",
      });

      const canView = await membersService_.canViewOrganization(member, org.id);
      expect(canView).toBe(true);
    });

    it("canViewOrganization denies non-members", async () => {
      const owner = await authenticatedUser("membership-view-owner2");
      const nonmember = await authenticatedUser("membership-non-viewer");
      const orgService = organizationsService();
      const membersService_ = membersService();

      const org = await orgService.createOrganization(owner, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });

      const canView = await membersService_.canViewOrganization(
        nonmember,
        org.id,
      );
      expect(canView).toBe(false);
    });
  });

  describe("boundary cases", () => {
    it("handles organization with multiple owners", async () => {
      const owner1 = await authenticatedUser("membership-multi-owner1");
      const owner2 = await authenticatedUser("membership-multi-owner2");
      const member = await authenticatedUser("membership-multi-member");
      const orgService = organizationsService();
      const membersService_ = membersService();

      const org = await orgService.createOrganization(owner1, {
        name: "Test Org",
        slug: `test-org-${Date.now()}`,
      });

      // Add second owner
      await membersService_.assignMember(owner1, org.id, {
        userId: owner2.id,
        role: "OWNER",
      });
      // Add member
      await membersService_.assignMember(owner1, org.id, {
        userId: member.id,
        role: "MEMBER",
      });

      // List members
      const result = await membersService_.listMembers(owner1, org.id, {});
      expect(result.total).toBe(3); // 2 owners + 1 member

      // Both owners should be able to manage
      const owner1CanManage = await membersService_.canManageOrganization(
        owner1,
        org.id,
      );
      const owner2CanManage = await membersService_.canManageOrganization(
        owner2,
        org.id,
      );
      expect(owner1CanManage).toBe(true);
      expect(owner2CanManage).toBe(true);
    });

    it("cross-organization identifiers don't grant access", async () => {
      const owner1 = await authenticatedUser("membership-cross-owner1");
      const owner2 = await authenticatedUser("membership-cross-owner2");
      const orgService = organizationsService();
      const membersService_ = membersService();

      // Create two organizations
      const org1 = await orgService.createOrganization(owner1, {
        name: "Org 1",
        slug: `org1-${Date.now()}`,
      });
      const org2 = await orgService.createOrganization(owner2, {
        name: "Org 2",
        slug: `org2-${Date.now()}`,
      });

      // Add owner1 as member to org2
      await membersService_.assignMember(owner2, org2.id, {
        userId: owner1.id,
        role: "MEMBER",
      });

      // owner1 should NOT be able to manage org2 (only MEMBER role)
      const canManage = await membersService_.canManageOrganization(
        owner1,
        org2.id,
      );
      expect(canManage).toBe(false);

      // But owner1 should be able to manage org1
      const canManageOwn = await membersService_.canManageOrganization(
        owner1,
        org1.id,
      );
      expect(canManageOwn).toBe(true);
    });
  });
});
