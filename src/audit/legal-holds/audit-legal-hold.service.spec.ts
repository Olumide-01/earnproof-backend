import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { AuditLegalHold } from "@prisma/client";
import { AuthenticatedUser } from "../../auth/auth.types";
import { Clock } from "../../common/time/clock";
import { PrismaService } from "../../database/prisma.service";
import {
  AuditLegalHoldService,
  HOLD_APPROVAL_WINDOW_MS,
  MAX_HOLD_DAYS,
  MAX_HOLD_RANGE_DAYS,
} from "./audit-legal-hold.service";
import { CreateAuditLegalHoldDto } from "./dto/audit-legal-hold.dto";
import { isHoldInEffect, MAX_HOLDS_IN_EFFECT } from "./legal-hold-scope";

const DAY_MS = 24 * 60 * 60 * 1_000;
const T0 = new Date("2026-10-17T12:00:00.000Z");
/** Synthetic commitment: SHA-256 of the string "test". Not a real case reference. */
const COMMITMENT = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

class TestClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const admin = (id: string) =>
  ({ id, role: "ADMIN", walletAddress: `G-${id}`, walletHash: `h-${id}` }) as AuthenticatedUser;
const alice = admin("alice");
const bob = admin("bob");
const carol = admin("carol");

function fakePrisma(clock: TestClock) {
  const holds: AuditLegalHold[] = [];
  const auditLogs: Array<Record<string, unknown>> = [];
  let nextId = 1;

  const matchesUpdate = (hold: AuditLegalHold, where: Record<string, unknown>) =>
    hold.id === where.id && hold.status === where.status && hold.revision === where.revision;

  const auditLegalHold = {
    count: jest.fn(async () => holds.filter((hold) => isHoldInEffect(hold, clock.now())).length),
    create: jest.fn(async ({ data }: { data: Partial<AuditLegalHold> }) => {
      const hold = {
        status: "PENDING_APPROVAL",
        revision: 0,
        approvedById: null,
        approvedAt: null,
        rejectedById: null,
        rejectedAt: null,
        releaseRequestedById: null,
        releaseRequestedAt: null,
        releasedById: null,
        releasedAt: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        ...data,
        id: `hold-${nextId++}`,
      } as AuditLegalHold;
      holds.push(hold);
      return { ...hold };
    }),
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
      const hold = holds.find((candidate) => candidate.id === where.id);
      return hold ? { ...hold } : null;
    }),
    findMany: jest.fn(async ({ take }: { take: number }) =>
      [...holds].reverse().slice(0, take).map((hold) => ({ ...hold })),
    ),
    updateMany: jest.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hold = holds.find((candidate) => matchesUpdate(candidate, where));
        if (!hold) return { count: 0 };
        const { revision, ...rest } = data as { revision: { increment: number } };
        Object.assign(hold, rest, { revision: hold.revision + revision.increment });
        return { count: 1 };
      },
    ),
  };

  const prisma = {
    auditLegalHold,
    organization: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "org-1" ? { id: "org-1" } : null,
      ),
    },
    auditLog: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => auditLogs.push(data)) },
  };

  return { prisma, holds, auditLogs };
}

function build() {
  const clock = new TestClock(T0);
  const fake = fakePrisma(clock);
  const service = new AuditLegalHoldService(fake.prisma as unknown as PrismaService, clock);
  return { service, clock, ...fake };
}

function request(overrides: Partial<CreateAuditLegalHoldDto> = {}): CreateAuditLegalHoldDto {
  return {
    scope: "ORGANIZATION",
    organizationId: "org-1",
    authority: "COURT_ORDER",
    reasonCommitment: COMMITMENT,
    rangeStart: new Date(T0.getTime() - 400 * DAY_MS),
    rangeEnd: new Date(T0.getTime() - 300 * DAY_MS),
    expiresAt: new Date(T0.getTime() + 90 * DAY_MS),
    ...overrides,
  };
}

async function activeHold(service: AuditLegalHoldService) {
  const hold = await service.request(alice, request());
  return service.approve(bob, hold.id, { expectedRevision: 0 });
}

describe("AuditLegalHoldService", () => {
  describe("request", () => {
    it("creates a pending hold that is in effect immediately", async () => {
      const { service } = build();

      const hold = await service.request(alice, request());

      expect(hold).toMatchObject({
        status: "PENDING_APPROVAL",
        revision: 0,
        requestedById: "alice",
        organizationId: "org-1",
        inEffect: true,
        approvalDeadline: new Date(T0.getTime() + HOLD_APPROVAL_WINDOW_MS),
      });
    });

    it("never stores more than the commitment and structured fields", async () => {
      const { service, holds, auditLogs } = build();

      await service.request(alice, request());

      expect(Object.keys(holds[0]).sort()).toEqual(
        [
          "approvalDeadline", "approvedAt", "approvedById", "authority", "createdAt",
          "expiresAt", "id", "organizationId", "rangeEnd", "rangeStart", "reasonCommitment",
          "rejectedAt", "rejectedById", "releaseRequestedAt", "releaseRequestedById",
          "releasedAt", "releasedById", "requestedById", "revision", "scope", "status", "updatedAt",
        ].sort(),
      );
      expect(Object.keys(auditLogs[0].metadata as object).sort()).toEqual(
        ["authority", "expiresAt", "rangeEnd", "rangeStart", "reasonCommitment", "revision", "scope", "status"],
      );
    });

    it("caps the approval deadline at the hold's own expiry", async () => {
      const { service } = build();
      const expiresAt = new Date(T0.getTime() + 60_000);

      await expect(service.request(alice, request({ expiresAt }))).resolves.toMatchObject({
        approvalDeadline: expiresAt,
      });
    });

    it.each([
      ["organization hold without organizationId", { organizationId: undefined }],
      ["platform hold naming an organization", { scope: "PLATFORM" as const }],
      ["inverted range", { rangeStart: new Date(T0.getTime() - DAY_MS), rangeEnd: new Date(T0.getTime() - 2 * DAY_MS) }],
      ["expiry now", { expiresAt: T0 }],
      ["expiry past the maximum", { expiresAt: new Date(T0.getTime() + MAX_HOLD_DAYS * DAY_MS + 1) }],
      [
        "range wider than the maximum",
        { rangeStart: new Date(T0.getTime() - (MAX_HOLD_RANGE_DAYS + 1) * DAY_MS), rangeEnd: T0 },
      ],
    ])("rejects %s", async (_label, overrides) => {
      const { service, holds } = build();
      await expect(service.request(alice, request(overrides))).rejects.toThrow(BadRequestException);
      expect(holds).toHaveLength(0);
    });

    it("accepts the exact maximum expiry and a single-instant range", async () => {
      const { service } = build();

      await expect(
        service.request(
          alice,
          request({
            expiresAt: new Date(T0.getTime() + MAX_HOLD_DAYS * DAY_MS),
            rangeStart: new Date(T0.getTime() - DAY_MS),
            rangeEnd: new Date(T0.getTime() - DAY_MS),
          }),
        ),
      ).resolves.toMatchObject({ status: "PENDING_APPROVAL" });
    });

    it("accepts a platform hold without an organization", async () => {
      const { service } = build();
      await expect(
        service.request(alice, request({ scope: "PLATFORM", organizationId: undefined })),
      ).resolves.toMatchObject({ scope: "PLATFORM", organizationId: null });
    });

    it("rejects an unknown organization", async () => {
      const { service } = build();
      await expect(service.request(alice, request({ organizationId: "nope" }))).rejects.toThrow(
        NotFoundException,
      );
    });

    it("refuses new holds once the in-effect limit is reached", async () => {
      const { service, prisma } = build();
      prisma.auditLegalHold.count.mockResolvedValueOnce(MAX_HOLDS_IN_EFFECT);

      await expect(service.request(alice, request())).rejects.toThrow(ConflictException);
    });
  });

  describe("approval", () => {
    it("lets a second administrator approve", async () => {
      const { service, auditLogs } = build();
      const hold = await service.request(alice, request());

      await expect(service.approve(bob, hold.id, { expectedRevision: 0 })).resolves.toMatchObject({
        status: "ACTIVE",
        approvedById: "bob",
        revision: 1,
        inEffect: true,
      });
      expect(auditLogs.map((log) => log.action)).toEqual([
        "audit.legal_hold.requested",
        "audit.legal_hold.approved",
      ]);
    });

    it("prohibits self-approval and self-rejection", async () => {
      const { service, holds } = build();
      const hold = await service.request(alice, request());

      await expect(service.approve(alice, hold.id, { expectedRevision: 0 })).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.reject(alice, hold.id, { expectedRevision: 0 })).rejects.toThrow(
        ForbiddenException,
      );
      expect(holds[0].status).toBe("PENDING_APPROVAL");
    });

    it("refuses approval at the exact approval deadline", async () => {
      const { service, clock } = build();
      const hold = await service.request(alice, request());

      clock.advance(HOLD_APPROVAL_WINDOW_MS);

      await expect(service.approve(bob, hold.id, { expectedRevision: 0 })).rejects.toThrow(
        /deadline or expiry has passed/,
      );
    });

    it("accepts approval one millisecond before the deadline", async () => {
      const { service, clock } = build();
      const hold = await service.request(alice, request());

      clock.advance(HOLD_APPROVAL_WINDOW_MS - 1);

      await expect(service.approve(bob, hold.id, { expectedRevision: 0 })).resolves.toMatchObject({
        status: "ACTIVE",
      });
    });

    it("rejects a replayed approval as stale", async () => {
      const { service } = build();
      const hold = await service.request(alice, request());
      await service.approve(bob, hold.id, { expectedRevision: 0 });

      await expect(service.approve(bob, hold.id, { expectedRevision: 0 })).rejects.toThrow(
        /expected revision 0 but the hold is at revision 1/,
      );
    });

    it("lets exactly one of two concurrent decisions win", async () => {
      const { service, holds } = build();
      const hold = await service.request(alice, request());

      const outcomes = await Promise.allSettled([
        service.approve(bob, hold.id, { expectedRevision: 0 }),
        service.reject(carol, hold.id, { expectedRevision: 0 }),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect((outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
      expect(holds[0].revision).toBe(1);
    });

    it("refuses a decision on a rejected hold", async () => {
      const { service } = build();
      const hold = await service.request(alice, request());
      await service.reject(bob, hold.id, { expectedRevision: 0 });

      await expect(service.approve(carol, hold.id, { expectedRevision: 1 })).rejects.toThrow(
        /is REJECTED/,
      );
    });

    it("reports an unknown hold as not found", async () => {
      const { service } = build();
      await expect(service.approve(bob, "missing", { expectedRevision: 0 })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("release", () => {
    it("needs a request and an independent approval", async () => {
      const { service } = build();
      const hold = await activeHold(service);

      const pending = await service.requestRelease(alice, hold.id, { expectedRevision: 1 });
      expect(pending).toMatchObject({ status: "RELEASE_PENDING", inEffect: true });

      const released = await service.approveRelease(carol, hold.id, { expectedRevision: 2 });
      expect(released).toMatchObject({ status: "RELEASED", releasedById: "carol", inEffect: false });
    });

    it("prohibits approving one's own release request", async () => {
      const { service, holds } = build();
      const hold = await activeHold(service);
      await service.requestRelease(bob, hold.id, { expectedRevision: 1 });

      await expect(service.approveRelease(bob, hold.id, { expectedRevision: 2 })).rejects.toThrow(
        ForbiddenException,
      );
      expect(holds[0].status).toBe("RELEASE_PENDING");
    });

    it("cannot release a hold that was never approved", async () => {
      const { service } = build();
      const hold = await service.request(alice, request());

      await expect(service.requestRelease(bob, hold.id, { expectedRevision: 0 })).rejects.toThrow(
        /is PENDING_APPROVAL/,
      );
    });

    it("refuses to release an expired hold", async () => {
      const { service, clock } = build();
      const hold = await activeHold(service);
      clock.advance(90 * DAY_MS);

      await expect(service.requestRelease(alice, hold.id, { expectedRevision: 1 })).rejects.toThrow(
        /already expired/,
      );
    });
  });

  describe("reads", () => {
    it("reports inEffect at read time", async () => {
      const { service, clock } = build();
      const hold = await activeHold(service);

      await expect(service.get(hold.id)).resolves.toMatchObject({ inEffect: true });
      clock.advance(90 * DAY_MS);
      await expect(service.get(hold.id)).resolves.toMatchObject({ inEffect: false });
    });

    it("pages the list with a cursor", async () => {
      const { service } = build();
      await service.request(alice, request());
      await service.request(alice, request());

      const page = await service.list({ limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBe(page.items[0].id);
    });
  });
});
