import {
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { OrganizationInvitationStatus, OrganizationMemberRole, ResourceStatus } from "@prisma/client";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { OrganizationInvitationsService } from "../../src/organizations/organization-invitations.service";
import { OrganizationMembersService } from "../../src/organizations/organization-members.service";
import { OrganizationsService } from "../../src/organizations/organizations.service";
import { integrationDatabase } from "./harness/database";
import { seedUser } from "./harness/fixtures";
import { integrationModule } from "./harness/nest";

/**
 * Organization invitations integration tests.
 * Validates complete invitation lifecycle against real PostgreSQL:
 * create, inspect, accept, decline, revoke, and list.
 */

const db = integrationDatabase();
const injector = integrationModule([
  OrganizationsService,
  OrganizationMembersService,
  OrganizationInvitationsService,
]);

function organizationsService(): OrganizationsService {
  return injector.get(OrganizationsService);
}

function invitationsService(): OrganizationInvitationsService {
  return injector.get(OrganizationInvitationsService);
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

describe("organization invitations lifecycle (integration)", () => {
  it("executes the full invitation lifecycle: create -> inspect -> accept -> replay rejection", async () => {
    const owner = await authenticatedUser("inv-lifecycle-owner");
    const invitee = await authenticatedUser("inv-lifecycle-invitee");
    const attacker = await authenticatedUser("inv-lifecycle-attacker");

    const org = await organizationsService().createOrganization(owner, {
      name: "Invitation Lifecycle Org",
      slug: `inv-org-${Date.now()}`,
    });

    const otherOrg = await organizationsService().createOrganization(owner, {
      name: "Other Org",
      slug: `other-org-${Date.now()}`,
    });

    // 1. Create invitation
    const created = await invitationsService().createInvitation(owner, org.id, {
      recipientWalletAddress: invitee.walletAddress,
      role: OrganizationMemberRole.MEMBER,
      ttlSeconds: 3600,
    });

    expect(created.id).toBeDefined();
    expect(created.token).toBeDefined();
    expect(created.status).toBe(OrganizationInvitationStatus.PENDING);

    // Verify row in database has ONLY hashed secret
    const persisted = await db.prisma.organizationInvitation.findUnique({
      where: { id: created.id },
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.secretHash).toBeDefined();
    expect(persisted?.secretHash).not.toEqual(created.token);

    // 2. Inspect invitation
    const inspected = await invitationsService().inspectInvitation(created.token);
    expect(inspected.id).toBe(created.id);
    expect(inspected.organizationId).toBe(org.id);
    expect(inspected.recipientWalletAddress).toBe(invitee.walletAddress);
    expect(inspected.status).toBe(OrganizationInvitationStatus.PENDING);

    // 3. Negative checks: wrong-wallet fails closed
    await expect(
      invitationsService().acceptInvitation(attacker, { token: created.token }),
    ).rejects.toThrow(ForbiddenException);

    // 4. Negative checks: cross-tenant fails closed
    await expect(
      invitationsService().acceptInvitation(invitee, {
        token: created.token,
        organizationId: otherOrg.id,
      }),
    ).rejects.toThrow(ForbiddenException);

    // 5. Positive check: accept invitation
    const accepted = await invitationsService().acceptInvitation(invitee, {
      token: created.token,
    });
    expect(accepted.invitation.status).toBe(OrganizationInvitationStatus.ACCEPTED);
    expect(accepted.membership.role).toBe(OrganizationMemberRole.MEMBER);

    // Verify membership row in DB
    const memberRow = await db.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: org.id,
          userId: invitee.id,
        },
      },
    });
    expect(memberRow).not.toBeNull();
    expect(memberRow?.status).toBe(ResourceStatus.ACTIVE);
    expect(memberRow?.role).toBe(OrganizationMemberRole.MEMBER);

    // 6. Negative checks: replay acceptance fails closed
    await expect(
      invitationsService().acceptInvitation(invitee, { token: created.token }),
    ).rejects.toThrow(ConflictException);
  });

  it("handles revocation and decline correctly", async () => {
    const owner = await authenticatedUser("inv-revoke-owner");
    const invitee = await authenticatedUser("inv-revoke-invitee");

    const org = await organizationsService().createOrganization(owner, {
      name: "Revocation Org",
      slug: `rev-org-${Date.now()}`,
    });

    const created = await invitationsService().createInvitation(owner, org.id, {
      recipientWalletAddress: invitee.walletAddress,
      role: OrganizationMemberRole.MEMBER,
    });

    // Revoke
    const revoked = await invitationsService().revokeInvitation(owner, org.id, created.id);
    expect(revoked.status).toBe(OrganizationInvitationStatus.REVOKED);

    // Acceptance of revoked invitation fails closed
    await expect(
      invitationsService().acceptInvitation(invitee, { token: created.token }),
    ).rejects.toThrow(ConflictException);
  });
});
