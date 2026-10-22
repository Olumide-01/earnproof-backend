import { ConflictException } from "@nestjs/common";
import {
  OrganizationInvitation,
  OrganizationInvitationStatus,
  OrganizationMemberRole,
  ResourceStatus,
} from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { sha256 } from "../common/crypto/hash";
import { FixedClock } from "../../test/time/fixed-clock";
import { OrganizationInvitationsService } from "./organization-invitations.service";

describe("OrganizationInvitations Concurrency & Races", () => {
  let service: OrganizationInvitationsService;
  let prisma: any;
  let clock: FixedClock;

  const ORG_ID = "org_race_test";
  const WALLET_INVITEE = "GA2C5RFPE6GCKMY3Z4BDTJNNCYDCPQDZJNO5ZPBG6R7CQBFE5QDKQ6Y7";

  const inviteeUser: AuthenticatedUser = {
    id: "user_invitee_race",
    walletAddress: WALLET_INVITEE,
    walletHash: sha256(WALLET_INVITEE),
    role: "WORKER",
  };

  beforeEach(() => {
    clock = new FixedClock("2026-10-22T10:00:00.000Z");
  });

  it("concurrent acceptance creates at most one membership (atomic consumption race)", async () => {
    let currentStatus = OrganizationInvitationStatus.PENDING;
    let acceptedAt: Date | null = null;
    let acceptedById: string | null = null;
    const createdMemberships: any[] = [];

    const invitationRecord: OrganizationInvitation = {
      id: "inv_race_1",
      organizationId: ORG_ID,
      role: OrganizationMemberRole.MEMBER,
      inviterId: "user_inviter",
      recipientWalletAddress: WALLET_INVITEE,
      recipientWalletHash: sha256(WALLET_INVITEE),
      secretHash: sha256("race_secret"),
      status: OrganizationInvitationStatus.PENDING,
      expiresAt: new Date(clock.now().getTime() + 600000),
      acceptedAt: null,
      acceptedById: null,
      declinedAt: null,
      declinedById: null,
      revokedAt: null,
      revokedById: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };

    prisma = {
      organizationInvitation: {
        findUnique: jest.fn().mockImplementation(() =>
          Promise.resolve({
            ...invitationRecord,
            status: currentStatus,
            acceptedAt,
            acceptedById,
            organization: { name: "Race Org" },
          }),
        ),
        // Atomic conditional update simulating Postgres row lock / updateMany
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          if (
            currentStatus === OrganizationInvitationStatus.PENDING &&
            where.status === OrganizationInvitationStatus.PENDING
          ) {
            currentStatus = data.status;
            acceptedAt = data.acceptedAt;
            acceptedById = data.acceptedById;
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        }),
      },
      organizationMember: {
        findUnique: jest.fn().mockImplementation(() => {
          // If a membership was created in an earlier race step, return it
          if (createdMemberships.length > 0) {
            return Promise.resolve(createdMemberships[0]);
          }
          return Promise.resolve(null);
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const membership = {
            id: `mem_${createdMemberships.length + 1}`,
            ...data,
          };
          createdMemberships.push(membership);
          return Promise.resolve(membership);
        }),
      },
      appendAuditLog: jest.fn().mockResolvedValue({ id: "audit_tx" }),
      $transaction: jest.fn().mockImplementation((cb) => cb(prisma)),
    };

    service = new OrganizationInvitationsService(prisma, clock);

    // Launch 10 concurrent accept requests
    const token = "inv_race_1.race_secret";
    const attempts = Array.from({ length: 10 }, () =>
      service.acceptInvitation(inviteeUser, { token }).then(
        (res) => ({ success: true, res }),
        (err) => ({ success: false, err }),
      ),
    );

    const results = await Promise.all(attempts);

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    // EXACTLY one must succeed
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(9);

    // All failures must be ConflictException (replay or race loss)
    failures.forEach((f) => {
      expect(f.err).toBeInstanceOf(ConflictException);
    });

    // EXACTLY one membership must have been created in the database
    expect(createdMemberships).toHaveLength(1);
    expect(createdMemberships[0].userId).toBe(inviteeUser.id);
    expect(createdMemberships[0].organizationId).toBe(ORG_ID);
    expect(createdMemberships[0].role).toBe(OrganizationMemberRole.MEMBER);
    expect(createdMemberships[0].status).toBe(ResourceStatus.ACTIVE);
  });

  it("simultaneous accept and decline results in only one terminal transition", async () => {
    let currentStatus = OrganizationInvitationStatus.PENDING;

    const invitationRecord: OrganizationInvitation = {
      id: "inv_race_2",
      organizationId: ORG_ID,
      role: OrganizationMemberRole.MEMBER,
      inviterId: "user_inviter",
      recipientWalletAddress: WALLET_INVITEE,
      recipientWalletHash: sha256(WALLET_INVITEE),
      secretHash: sha256("race_secret_2"),
      status: OrganizationInvitationStatus.PENDING,
      expiresAt: new Date(clock.now().getTime() + 600000),
      acceptedAt: null,
      acceptedById: null,
      declinedAt: null,
      declinedById: null,
      revokedAt: null,
      revokedById: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };

    prisma = {
      organizationInvitation: {
        findUnique: jest.fn().mockImplementation(() =>
          Promise.resolve({
            ...invitationRecord,
            status: currentStatus,
            organization: { name: "Race Org" },
          }),
        ),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          if (
            currentStatus === OrganizationInvitationStatus.PENDING &&
            where.status === OrganizationInvitationStatus.PENDING
          ) {
            currentStatus = data.status;
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        }),
      },
      organizationMember: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: "mem_race", ...data }),
        ),
      },
      appendAuditLog: jest.fn().mockResolvedValue({ id: "audit_tx" }),
      $transaction: jest.fn().mockImplementation((cb) => cb(prisma)),
    };

    service = new OrganizationInvitationsService(prisma, clock);
    const token = "inv_race_2.race_secret_2";

    // Launch simultaneous accept and decline
    const [acceptRes, declineRes] = await Promise.all([
      service.acceptInvitation(inviteeUser, { token }).then(
        (res) => ({ success: true, res }),
        (err) => ({ success: false, err }),
      ),
      service.declineInvitation(inviteeUser, { token }).then(
        (res) => ({ success: true, res }),
        (err) => ({ success: false, err }),
      ),
    ]);

    // One succeeds, one fails with ConflictException
    const outcomes = [acceptRes.success, declineRes.success];
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(
      acceptRes.success ? declineRes.err : acceptRes.err,
    ).toBeInstanceOf(ConflictException);
  });
});
