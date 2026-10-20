import { AuditLegalHold } from "@prisma/client";
import { holdsInEffectWhere, isHoldInEffect, MAX_HOLDS_IN_EFFECT } from "../../audit/legal-holds/legal-hold-scope";
import { PrismaService } from "../../database/prisma.service";
import { RetentionCleanupService } from "./retention-cleanup.service";

const NOW = new Date("2026-10-17T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

interface AuditRow {
  id: string;
  organizationId: string | null;
  createdAt: Date;
}

type Where = Record<string, unknown>;

/**
 * Evaluates the subset of Prisma's filter language the sweep emits, with SQL
 * NULL semantics for the organization match: `{ equals: X, not: null }` is
 * false (not unknown) for a NULL column, so `NOT` of it keeps SYSTEM rows.
 */
function matches(row: AuditRow, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "NOT") {
      return (condition as Where[]).every((clause) => !matches(row, clause));
    }
    const value = (row as unknown as Record<string, unknown>)[key];
    const clause = condition as Record<string, unknown>;
    if (clause.in) return (clause.in as string[]).includes(value as string);
    if ("equals" in clause) return value !== null && value === clause.equals;
    if (clause.lt || clause.gte || clause.lte) {
      const time = (value as Date).getTime();
      return (
        (!clause.lt || time < (clause.lt as Date).getTime()) &&
        (!clause.gte || time >= (clause.gte as Date).getTime()) &&
        (!clause.lte || time <= (clause.lte as Date).getTime())
      );
    }
    return value === condition;
  });
}

function hold(overrides: Partial<AuditLegalHold>): AuditLegalHold {
  return {
    id: "hold",
    scope: "ORGANIZATION",
    organizationId: "org-a",
    authority: "COURT_ORDER",
    reasonCommitment: "0".repeat(64),
    rangeStart: daysAgo(500),
    rangeEnd: daysAgo(400),
    status: "ACTIVE",
    revision: 1,
    requestedById: "alice",
    approvalDeadline: daysAgo(1),
    approvedById: "bob",
    approvedAt: daysAgo(1),
    rejectedById: null,
    rejectedAt: null,
    releaseRequestedById: null,
    releaseRequestedAt: null,
    releasedById: null,
    releasedAt: null,
    expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    ...overrides,
  };
}

function setup(rows: AuditRow[], holds: AuditLegalHold[]) {
  const store = { rows: [...rows], holds: [...holds] };
  const holdLookups: Where[] = [];
  const deleteWheres: Where[] = [];

  const auditLog = {
    findMany: jest.fn(async ({ where, take, skip = 0 }: { where: Where; take: number; skip?: number }) =>
      store.rows
        .filter((row) => matches(row, where))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .slice(skip, skip + take)
        .map((row) => ({ id: row.id })),
    ),
    deleteMany: jest.fn(async ({ where }: { where: Where }) => {
      deleteWheres.push(where);
      const before = store.rows.length;
      store.rows = store.rows.filter((row) => !matches(row, where));
      return { count: before - store.rows.length };
    }),
  };

  const auditLegalHold = {
    findMany: jest.fn(async ({ where, take }: { where: ReturnType<typeof holdsInEffectWhere>; take: number }) => {
      holdLookups.push(where);
      return store.holds
        .filter((candidate) => isHoldInEffect(candidate, where.expiresAt.gt))
        .slice(0, take);
    }),
  };

  const empty = { findMany: async () => [], deleteMany: async () => ({ count: 0 }) };
  const prisma = {
    walletChallenge: empty,
    authSession: empty,
    webhookDelivery: empty,
    verificationEventLog: empty,
    anchoringIntent: empty,
    idempotencyRecord: empty,
    auditLog,
    auditLegalHold,
  } as unknown as PrismaService;

  return { service: new RetentionCleanupService(prisma), store, auditLog, auditLegalHold, holdLookups, deleteWheres };
}

const auditResult = (result: Awaited<ReturnType<RetentionCleanupService["run"]>>) =>
  result.report?.categories.find((category) => category.category === "audit_logs");

describe("retention cleanup with legal holds", () => {
  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const rows: AuditRow[] = [
    { id: "held-start", organizationId: "org-a", createdAt: daysAgo(500) },
    { id: "held-end", organizationId: "org-a", createdAt: daysAgo(400) },
    { id: "other-org", organizationId: "org-b", createdAt: daysAgo(450) },
    { id: "system", organizationId: null, createdAt: daysAgo(450) },
    { id: "outside-range", organizationId: "org-a", createdAt: daysAgo(399) },
  ];

  it("never deletes held records and still removes unrelated expired ones", async () => {
    const { service, store } = setup(rows, [hold({})]);

    await service.run({ only: ["audit_logs"], now: NOW });

    expect(store.rows.map((row) => row.id).sort()).toEqual(["held-end", "held-start"]);
  });

  it("is unchanged when no hold is in effect", async () => {
    const { service, store, auditLog } = setup(rows, []);

    await service.run({ only: ["audit_logs"], now: NOW });

    expect(store.rows).toEqual([]);
    expect(auditLog.findMany.mock.calls[0][0].where).not.toHaveProperty("NOT");
  });

  it("holds every organization and SYSTEM record under a platform hold", async () => {
    const { service, store } = setup(rows, [hold({ scope: "PLATFORM", organizationId: null })]);

    await service.run({ only: ["audit_logs"], now: NOW });

    expect(store.rows.map((row) => row.id).sort()).toEqual(["held-end", "held-start", "other-org", "system"]);
  });

  it.each([
    ["released", hold({ status: "RELEASED" })],
    ["rejected", hold({ status: "REJECTED" })],
    ["expired", hold({ expiresAt: NOW })],
    ["lapsed pending", hold({ status: "PENDING_APPROVAL", approvalDeadline: NOW })],
  ])("does not protect records under a %s hold", async (_label, inactive) => {
    const { service, store } = setup(rows, [inactive]);

    await service.run({ only: ["audit_logs"], now: NOW });

    expect(store.rows).toEqual([]);
  });

  it("protects records while a hold awaits approval", async () => {
    const pending = hold({ status: "PENDING_APPROVAL", approvalDeadline: new Date(NOW.getTime() + 1) });
    const { service, store } = setup(rows, [pending]);

    await service.run({ only: ["audit_logs"], now: NOW });

    expect(store.rows.map((row) => row.id).sort()).toEqual(["held-end", "held-start"]);
  });

  it("protects records when a hold commits between selection and deletion", async () => {
    const { service, store, auditLegalHold } = setup(rows, []);
    // First lookup (for the select) sees no hold; the hold commits before the
    // delete statement, whose own lookup must see it.
    auditLegalHold.findMany.mockImplementationOnce(async () => {
      store.holds.push(hold({}));
      return [];
    });

    const result = await service.run({ only: ["audit_logs"], now: NOW });

    expect(store.rows.map((row) => row.id).sort()).toEqual(["held-end", "held-start"]);
    expect(auditResult(result)).toMatchObject({ selected: 5, affected: 3 });
  });

  it("excludes held records from a dry run's selection", async () => {
    const { service, store } = setup(rows, [hold({})]);

    const result = await service.run({ only: ["audit_logs"], now: NOW, dryRun: true });

    expect(auditResult(result)).toMatchObject({ selected: 3, affected: 0 });
    expect(store.rows).toHaveLength(5);
  });

  it("fails closed when the hold lookup fails", async () => {
    const { service, store, auditLegalHold } = setup(rows, []);
    auditLegalHold.findMany.mockRejectedValue(new Error("db down"));

    const result = await service.run({ only: ["audit_logs"], now: NOW });

    expect(auditResult(result)).toMatchObject({ failed: true, affected: 0 });
    expect(store.rows).toHaveLength(5);
  });

  it("fails closed rather than trusting a truncated hold list", async () => {
    const many = Array.from({ length: MAX_HOLDS_IN_EFFECT + 1 }, (_, index) =>
      hold({ id: `hold-${index}`, organizationId: `org-${index}` }),
    );
    const { service, store, auditLegalHold } = setup(rows, many);

    const result = await service.run({ only: ["audit_logs"], now: NOW });

    expect(auditLegalHold.findMany.mock.calls[0][0].take).toBe(MAX_HOLDS_IN_EFFECT + 1);
    expect(auditResult(result)).toMatchObject({ failed: true });
    expect(store.rows).toHaveLength(5);
  });

  it("judges holds at the run's evaluation instant", async () => {
    const { service, holdLookups } = setup(rows, []);

    await service.run({ only: ["audit_logs"], now: NOW });

    expect(holdLookups[0]).toEqual(holdsInEffectWhere(NOW));
  });

  it("does not consult holds for other retention classes", async () => {
    const { service, auditLegalHold } = setup(rows, [hold({})]);

    await service.run({ only: ["wallet_challenges", "webhook_deliveries"], now: NOW });

    expect(auditLegalHold.findMany).not.toHaveBeenCalled();
  });
});
