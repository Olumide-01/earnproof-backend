import { OrganizationInvitationStatus, OrganizationMemberRole, ResourceStatus } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { findForbiddenAuditContent } from "../common/audit/audit-redaction";
import { sha256 } from "../common/crypto/hash";
import { FixedClock } from "../../test/time/fixed-clock";
import { OrganizationInvitationsService } from "./organization-invitations.service";

describe("OrganizationInvitations Audit Redaction & Privacy", () => {
  let service: OrganizationInvitationsService;
  let prisma: any;
  let clock: FixedClock;
  const capturedAuditLogs: any[] = [];

  const ORG_ID = "org_audit_test";
  const WALLET_INVITER = "GBWM4FST7D2Q5YJ6F2R2L3D7Y4Y5W6E7R8T9Y0U1I2O3P4A5S6D7F8G9";
  const WALLET_INVITEE = "GA2C5RFPE6GCKMY3Z4BDTJNNCYDCPQDZJNO5ZPBG6R7CQBFE5QDKQ6Y7";

  const adminUser: AuthenticatedUser = {
    id: "user_admin",
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

  beforeEach(() => {
    capturedAuditLogs.length = 0;
    clock = new FixedClock("2026-10-22T10:00:00.000Z");

    prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          id: ORG_ID,
          name: "Audit Org",
          archivedAt: null,
          deletedAt: null,
        }),
      },
      organizationMember: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.organizationId_userId?.userId === adminUser.id) {
            return Promise.resolve({
              id: "mem_admin",
              organizationId: ORG_ID,
              userId: adminUser.id,
              role: OrganizationMemberRole.ADMIN,
              status: ResourceStatus.ACTIVE,
            });
          }
          return Promise.resolve(null);
        }),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: "mem_created", ...data }),
        ),
      },
      organizationInvitation: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: "inv_audit_1",
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
        create: jest.fn().mockImplementation((args) => {
          capturedAuditLogs.push(args.data);
          return Promise.resolve({ id: "audit_1", ...args.data });
        }),
      },
      appendAuditLog: jest.fn().mockImplementation((tx, args) => {
        capturedAuditLogs.push(args.data);
        return Promise.resolve({ id: "audit_tx", ...args.data });
      }),
      $transaction: jest.fn().mockImplementation((cb) => cb(prisma)),
    };

    service = new OrganizationInvitationsService(prisma, clock);
  });

  it("ensures invitation creation audit record contains NO secrets, tokens, or raw addresses", async () => {
    const created = await service.createInvitation(adminUser, ORG_ID, {
      recipientWalletAddress: WALLET_INVITEE,
      role: OrganizationMemberRole.MEMBER,
    });

    expect(capturedAuditLogs).toHaveLength(1);
    const log = capturedAuditLogs[0];

    // Must be valid organization.invitation.created event
    expect(log.action).toBe("organization.invitation.created");
    expect(log.resourceType).toBe("OrganizationInvitation");

    // Scan for forbidden audit content (token, secret, privatekey, raw address, etc.)
    const findings = findForbiddenAuditContent(log);
    expect(findings).toEqual([]);

    // Assert raw secret/token was NOT leaked into the audit record
    const serialised = JSON.stringify(log);
    const secretPart = created.token.split(".")[1];
    expect(serialised).not.toContain(secretPart);
    expect(serialised).not.toContain(created.token);
    expect(serialised).not.toContain(WALLET_INVITEE);

    // Assert only hashed recipient wallet was retained
    expect(log.metadata.recipientWalletHash).toBe(sha256(WALLET_INVITEE));
  });

  it("ensures invitation acceptance audit record contains NO forbidden content", async () => {
    const created = await service.createInvitation(adminUser, ORG_ID, {
      recipientWalletAddress: WALLET_INVITEE,
      role: OrganizationMemberRole.MEMBER,
    });
    capturedAuditLogs.length = 0;

    const secret = created.token.split(".")[1];
    prisma.organizationInvitation.findUnique.mockResolvedValueOnce({
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
      organization: { name: "Audit Org" },
    });

    await service.acceptInvitation(inviteeUser, { token: created.token });

    expect(capturedAuditLogs).toHaveLength(1);
    const log = capturedAuditLogs[0];

    expect(log.action).toBe("organization.invitation.accepted");
    const findings = findForbiddenAuditContent(log);
    expect(findings).toEqual([]);

    const serialised = JSON.stringify(log);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain(created.token);
    expect(serialised).not.toContain(WALLET_INVITEE);
  });

  it("ensures invitation decline audit record contains NO forbidden content", async () => {
    const created = await service.createInvitation(adminUser, ORG_ID, {
      recipientWalletAddress: WALLET_INVITEE,
      role: OrganizationMemberRole.MEMBER,
    });
    capturedAuditLogs.length = 0;

    const secret = created.token.split(".")[1];
    prisma.organizationInvitation.findUnique.mockResolvedValueOnce({
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
      organization: { name: "Audit Org" },
    });

    await service.declineInvitation(inviteeUser, { token: created.token });

    expect(capturedAuditLogs).toHaveLength(1);
    const log = capturedAuditLogs[0];

    expect(log.action).toBe("organization.invitation.declined");
    const findings = findForbiddenAuditContent(log);
    expect(findings).toEqual([]);

    const serialised = JSON.stringify(log);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain(created.token);
    expect(serialised).not.toContain(WALLET_INVITEE);
  });

  it("ensures invitation revocation audit record contains NO forbidden content", async () => {
    prisma.organizationInvitation.findUnique.mockResolvedValueOnce({
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
    });

    await service.revokeInvitation(adminUser, ORG_ID, "inv_to_revoke");

    expect(capturedAuditLogs).toHaveLength(1);
    const log = capturedAuditLogs[0];

    expect(log.action).toBe("organization.invitation.revoked");
    const findings = findForbiddenAuditContent(log);
    expect(findings).toEqual([]);

    const serialised = JSON.stringify(log);
    expect(serialised).not.toContain(WALLET_INVITEE);
  });
});
