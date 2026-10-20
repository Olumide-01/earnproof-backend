import { Logger } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { FixedClock } from "../../../test/time/fixed-clock";
import {
  RetentionCleanupService,
  RetentionPlanError,
  type RetentionRunResult,
} from "./retention-cleanup.service";
import { retentionPolicyVersion } from "./retention-policy";
import {
  boundOrganizationCounts,
  compareWithPlan,
  MAX_ORGANIZATION_BUCKETS,
  type RetentionImpactReport,
} from "./retention-report";

/**
 * Dry-run and impact reporting for the retention sweep (earnproof-backend#209).
 *
 * The existing service spec covers deletion semantics; this one covers the
 * guarantees an operator relies on before letting a sweep delete anything:
 * the preview writes nothing, describes exactly what the real run will select,
 * and says so in a report that holds counts rather than content.
 */

interface Row {
  id: string;
  [column: string]: unknown;
}

const WRITE_METHODS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
];

/** In-memory delegate recording every method invoked on it. */
class RecordingDelegate {
  rows: Row[];
  readonly calls: string[] = [];
  readonly wheres: Array<Record<string, unknown>> = [];
  readonly selects: Array<Record<string, unknown>> = [];
  /** Ids each findMany returned, in order. */
  readonly selectedIds: string[] = [];
  /** Ids each deleteMany removed, in order. */
  readonly deletedIds: string[] = [];

  constructor(rows: Row[]) {
    this.rows = [...rows];
  }

  private matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([column, condition]) => {
      if (condition && typeof condition === "object") {
        const clause = condition as { lt?: Date; in?: string[] };
        if (clause.lt !== undefined) {
          const value = row[column];
          return value instanceof Date && value.getTime() < clause.lt.getTime();
        }
        if (clause.in !== undefined) {
          return clause.in.includes(row[column] as string);
        }
      }
      return row[column] === condition;
    });
  }

  async findMany(args: {
    where: Record<string, unknown>;
    select: Record<string, unknown>;
    orderBy: Array<Record<string, "asc" | "desc">>;
    take: number;
    skip?: number;
  }): Promise<Array<Record<string, unknown>>> {
    this.calls.push("findMany");
    this.wheres.push(args.where);
    this.selects.push(args.select);

    const column = Object.keys(args.orderBy[0])[0];
    const skip = args.skip ?? 0;
    const page = this.rows
      .filter((row) => this.matches(row, args.where))
      .sort(
        (a, b) =>
          (a[column] as Date).getTime() - (b[column] as Date).getTime() ||
          a.id.localeCompare(b.id),
      )
      .slice(skip, skip + args.take);

    this.selectedIds.push(...page.map((row) => row.id));

    return page.map((row) =>
      Object.fromEntries(
        Object.keys(args.select)
          .filter((key) => key in row)
          .map((key) => [key, row[key]]),
      ),
    );
  }

  async deleteMany({
    where,
  }: {
    where: Record<string, unknown>;
  }): Promise<{ count: number }> {
    this.calls.push("deleteMany");
    const ids = (where.id as { in: string[] }).in;
    this.deletedIds.push(...ids);
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !ids.includes(row.id));
    return { count: before - this.rows.length };
  }
}

const NOW = new Date("2026-08-26T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

const DELEGATE_KEYS: Record<string, string> = {
  wallet_challenges: "walletChallenge",
  auth_sessions: "authSession",
  webhook_deliveries: "webhookDelivery",
  verification_events: "verificationEventLog",
  audit_logs: "auditLog",
  failed_anchoring_intents: "anchoringIntent",
};

/**
 * Prisma stand-in that records every property touched on the client itself,
 * so a dry run reaching for `$executeRaw`, `$transaction`, or a model the sweep
 * has no business with is caught, not just a delete on a known delegate.
 */
function buildPrisma(delegates: Record<string, RecordingDelegate>) {
  const byModel: Record<string, RecordingDelegate> = {};
  for (const [key, model] of Object.entries(DELEGATE_KEYS)) {
    byModel[model] = delegates[key] ?? new RecordingDelegate([]);
  }

  const clientAccess: string[] = [];
  // Read-only legal-hold lookup (#311): no holds, so audit selection is unchanged.
  const noHolds = { findMany: async () => [] };
  const prisma = new Proxy(byModel, {
    get(target, property) {
      if (typeof property === "string") clientAccess.push(property);
      if (property === "auditLegalHold") return noHolds;
      return target[property as string];
    },
  }) as unknown as PrismaService;

  return { prisma, byModel, clientAccess };
}

function aged(id: string, column: string, days: number, extra: object = {}): Row {
  return { ...extra, id, [column]: new Date(NOW.getTime() - days * DAY_MS) };
}

function serviceWith(
  delegates: Record<string, RecordingDelegate>,
  clock: FixedClock = new FixedClock(NOW),
) {
  const built = buildPrisma(delegates);
  return {
    service: new RetentionCleanupService(built.prisma, clock),
    clock,
    ...built,
  };
}

function reportOf(result: RetentionRunResult): RetentionImpactReport {
  if (!result.report) throw new Error("run produced no report");
  return result.report;
}

describe("Retention dry run and impact reporting", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    delete process.env.RETENTION_WALLET_CHALLENGE_DAYS;
    delete process.env.RETENTION_WEBHOOK_DELIVERY_DAYS;
  });

  describe("dry run", () => {
    it("performs no writes on any delegate or on the client", async () => {
      const delegates = {
        wallet_challenges: new RecordingDelegate([aged("wc", "expiresAt", 90)]),
        auth_sessions: new RecordingDelegate([
          aged("as", "expiresAt", 90, { rotatedToId: null }),
        ]),
        webhook_deliveries: new RecordingDelegate([
          aged("wd", "createdAt", 90, { webhook: { organizationId: "org_a" } }),
        ]),
        verification_events: new RecordingDelegate([
          aged("ve", "retainUntil", 200),
        ]),
        audit_logs: new RecordingDelegate([aged("al", "createdAt", 500)]),
        failed_anchoring_intents: new RecordingDelegate([
          aged("ai", "updatedAt", 200, { status: "FAILED", permanentError: true }),
        ]),
      };
      const { service, byModel, clientAccess } = serviceWith(delegates);

      const result = await service.run({ dryRun: true });

      for (const delegate of Object.values(byModel)) {
        expect(delegate.calls.filter((c) => WRITE_METHODS.includes(c))).toEqual(
          [],
        );
      }
      // Only model delegates were reached for — never `$transaction`,
      // `$executeRaw`, or any other client-level escape hatch.
      expect(clientAccess.filter((name) => name.startsWith("$"))).toEqual([]);
      expect(
        Object.values(delegates).every((d) => d.rows.length === 1),
      ).toBe(true);
      expect(reportOf(result).totals).toEqual({ selected: 6, affected: 0 });
    });

    it("performs no external side effects", async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;

      const { service } = serviceWith({
        webhook_deliveries: new RecordingDelegate([
          aged("wd", "createdAt", 90, { webhook: { organizationId: "org_a" } }),
        ]),
      });

      await service.run({ dryRun: true });

      // No webhook, Horizon, or anchoring call may be triggered by a preview.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("reports every sweepable category with mode, cutoff, and policy version", async () => {
      const { service } = serviceWith({});

      const report = reportOf(await service.run({ dryRun: true }));

      expect(report.mode).toBe("dry_run");
      expect(report.evaluatedAt).toBe(NOW.toISOString());
      expect(report.policyVersion).toBe(retentionPolicyVersion());
      expect(report.categories.map((c) => c.category)).toEqual([
        "wallet_challenges",
        "auth_sessions",
        "webhook_deliveries",
        "verification_events",
        "audit_logs",
        "failed_anchoring_intents",
      ]);
      const challenge = report.categories[0];
      expect(challenge.cutoff).toBe(
        new Date(NOW.getTime() - 7 * DAY_MS).toISOString(),
      );
      expect(challenge.cutoffColumn).toBe("expiresAt");
    });

    it("remembers the latest plan so an execution can be compared to it", async () => {
      const { service } = serviceWith({});
      expect(service.latestPlan).toBeUndefined();

      const dry = await service.run({ dryRun: true });
      await service.run({});

      // An execution never overwrites the reviewed plan.
      expect(service.latestPlan).toEqual(dry.report);
    });
  });

  describe("execution", () => {
    it("deletes the selected rows and reports selected and affected counts", async () => {
      const delegate = new RecordingDelegate([
        aged("old-1", "expiresAt", 30),
        aged("old-2", "expiresAt", 30),
        aged("recent", "expiresAt", 1),
      ]);
      const { service } = serviceWith({ wallet_challenges: delegate });

      const result = await service.run({ only: ["wallet_challenges"] });
      const report = reportOf(result);

      expect(delegate.rows.map((r) => r.id)).toEqual(["recent"]);
      expect(report.mode).toBe("execute");
      expect(report.categories[0]).toMatchObject({
        selected: 2,
        affected: 2,
        truncated: false,
        failed: false,
      });
      expect(result.results[0].affected).toBe(2);
    });

    it("marks a category whose configuration fails, without abandoning the rest", async () => {
      process.env.RETENTION_WEBHOOK_DELIVERY_DAYS = "not-a-number";
      const { service } = serviceWith({
        wallet_challenges: new RecordingDelegate([aged("wc", "expiresAt", 90)]),
      });

      const report = reportOf(await service.run({ dryRun: true }));
      const webhook = report.categories.find(
        (c) => c.category === "webhook_deliveries",
      );

      expect(webhook).toMatchObject({ failed: true, selected: 0, cutoff: "" });
      expect(report.categories[0]).toMatchObject({ selected: 1, failed: false });
      expect(report.policyVersion).toMatch(/^v1-[0-9a-f]{16}$/);
    });
  });

  describe("organization and category counts", () => {
    it("attributes webhook deliveries to their organization", async () => {
      const webhook = (org: string) => ({ webhook: { organizationId: org } });
      const { service } = serviceWith({
        webhook_deliveries: new RecordingDelegate([
          aged("d1", "createdAt", 60, webhook("org_b")),
          aged("d2", "createdAt", 60, webhook("org_a")),
          aged("d3", "createdAt", 60, webhook("org_a")),
          aged("fresh", "createdAt", 1, webhook("org_c")),
        ]),
        audit_logs: new RecordingDelegate([
          aged("a1", "createdAt", 400),
          aged("a2", "createdAt", 400),
        ]),
      });

      const report = reportOf(await service.run({ dryRun: true }));
      const byCategory = new Map(report.categories.map((c) => [c.category, c]));

      expect(byCategory.get("webhook_deliveries")?.organizations).toEqual([
        { organizationId: "org_a", count: 2 },
        { organizationId: "org_b", count: 1 },
      ]);
      // Not tenant-scoped: reported under a null organization.
      expect(byCategory.get("audit_logs")?.organizations).toEqual([
        { organizationId: null, count: 2 },
      ]);
    });

    it("bounds organization buckets and folds the remainder", async () => {
      const rows = Array.from({ length: MAX_ORGANIZATION_BUCKETS + 5 }, (_, i) =>
        aged(`d${i}`, "createdAt", 60, {
          webhook: { organizationId: `org_${String(i).padStart(2, "0")}` },
        }),
      );
      const { service } = serviceWith({
        webhook_deliveries: new RecordingDelegate(rows),
      });

      const report = reportOf(await service.run({ dryRun: true }));
      const webhook = report.categories.find(
        (c) => c.category === "webhook_deliveries",
      );

      expect(webhook?.organizations).toHaveLength(MAX_ORGANIZATION_BUCKETS);
      expect(webhook?.otherOrganizations).toEqual({ buckets: 5, count: 5 });
      const reported =
        (webhook?.organizations ?? []).reduce((sum, o) => sum + o.count, 0) +
        (webhook?.otherOrganizations.count ?? 0);
      expect(reported).toBe(webhook?.selected);
    });

    it("orders buckets deterministically: largest first, then by id", () => {
      const tally = new Map<string | null, number>([
        ["org_c", 1],
        ["org_a", 3],
        ["org_b", 1],
        [null, 0],
      ]);

      expect(boundOrganizationCounts(tally, 2)).toEqual({
        organizations: [
          { organizationId: "org_a", count: 3 },
          { organizationId: "org_b", count: 1 },
        ],
        otherOrganizations: { buckets: 1, count: 1 },
      });
    });
  });

  describe("policy version", () => {
    it("is stable for an unchanged policy", () => {
      expect(retentionPolicyVersion()).toBe(retentionPolicyVersion());
      expect(retentionPolicyVersion()).toMatch(/^v1-[0-9a-f]{16}$/);
    });

    it("changes when a retention override changes the policy", () => {
      const baseline = retentionPolicyVersion();

      expect(
        retentionPolicyVersion({ RETENTION_WALLET_CHALLENGE_DAYS: "60" }),
      ).not.toBe(baseline);
      // An override equal to the default is the same policy.
      expect(
        retentionPolicyVersion({ RETENTION_WALLET_CHALLENGE_DAYS: "7" }),
      ).toBe(baseline);
    });

    it("is still produced when an override is invalid", () => {
      expect(
        retentionPolicyVersion({ RETENTION_WALLET_CHALLENGE_DAYS: "nope" }),
      ).toMatch(/^v1-[0-9a-f]{16}$/);
    });
  });

  describe("fixed-clock selection equivalence", () => {
    /** Builds the same dataset fresh for each mode. */
    function dataset(size: number, sameTimestamp = false): Row[] {
      return Array.from({ length: size }, (_, i) =>
        aged(
          `row-${String(i).padStart(5, "0")}`,
          "expiresAt",
          sameTimestamp ? 30 : 8 + (i % 40),
        ),
      ).reverse();
    }

    it.each([
      ["a single short page", 3, false],
      ["several pages with identical timestamps", 1_200, true],
      ["a backlog that hits the batch cap", 10_600, false],
    ])("dry run and execution select the same rows for %s", async (_label, size, same) => {
      const clock = new FixedClock(NOW);

      const preview = new RecordingDelegate(dataset(size, same));
      const dry = await serviceWith({ wallet_challenges: preview }, clock).service.run({
        only: ["wallet_challenges"],
        dryRun: true,
      });

      const real = new RecordingDelegate(dataset(size, same));
      const executed = await serviceWith({ wallet_challenges: real }, clock).service.run({
        only: ["wallet_challenges"],
      });

      expect(preview.selectedIds).toEqual(real.deletedIds);
      expect(preview.wheres[0]).toEqual(real.wheres[0]);
      expect(preview.selects[0]).toEqual(real.selects[0]);

      const planned = reportOf(dry).categories[0];
      const actual = reportOf(executed).categories[0];
      expect(planned.selected).toBe(actual.selected);
      expect(planned.truncated).toBe(actual.truncated);
      expect(planned.cutoff).toBe(actual.cutoff);
      expect(compareWithPlan(reportOf(dry), reportOf(executed))).toEqual({
        matches: true,
        issues: [],
      });
    });

    it("uses the injected clock rather than wall time", async () => {
      const clock = new FixedClock("2030-01-01T00:00:00.000Z");
      const { service } = serviceWith({}, clock);

      const report = reportOf(await service.run({ dryRun: true }));

      expect(report.evaluatedAt).toBe("2030-01-01T00:00:00.000Z");
    });
  });

  describe("comparison with a dry-run plan", () => {
    it("executes a plan at the plan's instant and confirms it matched", async () => {
      const delegate = new RecordingDelegate([
        aged("a", "expiresAt", 30),
        aged("b", "expiresAt", 20),
      ]);
      const { service, clock } = serviceWith({ wallet_challenges: delegate });

      const dry = await service.run({ only: ["wallet_challenges"], dryRun: true });
      // Time passes between review and execution; the plan's instant is reused.
      clock.advanceMs(60 * 60 * 1_000);

      const executed = await service.run({ plan: reportOf(dry) });

      expect(reportOf(executed).evaluatedAt).toBe(NOW.toISOString());
      expect(reportOf(executed).categories.map((c) => c.category)).toEqual([
        "wallet_challenges",
      ]);
      expect(executed.planComparison).toEqual({ matches: true, issues: [] });
      expect(delegate.rows).toHaveLength(0);
    });

    it("reports drift when the data changed after the plan", async () => {
      const delegate = new RecordingDelegate([aged("a", "expiresAt", 30)]);
      const { service } = serviceWith({ wallet_challenges: delegate });

      const dry = await service.run({ only: ["wallet_challenges"], dryRun: true });
      delegate.rows.push(aged("late", "expiresAt", 30));

      const executed = await service.run({ plan: reportOf(dry) });

      expect(executed.planComparison).toEqual({
        matches: false,
        issues: [
          {
            code: "count_drift",
            category: "wallet_challenges",
            planned: 1,
            actual: 2,
          },
        ],
      });
    });

    it("refuses a stale plan before selecting anything", async () => {
      const delegate = new RecordingDelegate([aged("a", "expiresAt", 30)]);
      const { service, clock } = serviceWith({ wallet_challenges: delegate });

      const dry = await service.run({ only: ["wallet_challenges"], dryRun: true });
      clock.advanceMs(25 * 60 * 60 * 1_000);
      const callsBefore = delegate.calls.length;

      await expect(service.run({ plan: reportOf(dry) })).rejects.toThrow(
        RetentionPlanError,
      );
      expect(delegate.calls.length).toBe(callsBefore);
      expect(delegate.rows).toHaveLength(1);
      expect(service.isRunning).toBe(false);
    });

    it("refuses a plan made under a different policy version", async () => {
      const { service } = serviceWith({});
      const dry = reportOf(await service.run({ dryRun: true }));

      process.env.RETENTION_WALLET_CHALLENGE_DAYS = "60";

      await expect(service.run({ plan: dry })).rejects.toThrow(
        /policy .* is in force/,
      );
    });

    it("refuses an execution report offered as a plan, and a plan offered to a dry run", async () => {
      const { service } = serviceWith({});
      const executed = reportOf(await service.run({}));
      const dry = reportOf(await service.run({ dryRun: true }));

      await expect(service.run({ plan: executed })).rejects.toThrow(
        /not a dry-run/,
      );
      await expect(service.run({ plan: dry, dryRun: true })).rejects.toThrow(
        /only be supplied to an execution/,
      );
    });

    it("flags every kind of mismatch without throwing", () => {
      const category = {
        category: "wallet_challenges",
        cutoff: "2026-08-19T00:00:00.000Z",
        cutoffColumn: "expiresAt",
        selected: 2,
        affected: 0,
        truncated: false,
        failed: false,
        organizations: [],
        otherOrganizations: { buckets: 0, count: 0 },
      };
      const plan: RetentionImpactReport = {
        mode: "dry_run",
        policyVersion: "v1-aaaaaaaaaaaaaaaa",
        evaluatedAt: "2026-08-26T00:00:00.000Z",
        categories: [category, { ...category, category: "audit_logs" }],
        totals: { selected: 4, affected: 0 },
      };
      const execution: RetentionImpactReport = {
        mode: "execute",
        policyVersion: "v1-bbbbbbbbbbbbbbbb",
        evaluatedAt: "2026-08-28T00:00:00.000Z",
        categories: [
          { ...category, cutoff: "2026-08-21T00:00:00.000Z", selected: 3 },
          { ...category, category: "auth_sessions" },
        ],
        totals: { selected: 5, affected: 5 },
      };

      const codes = compareWithPlan(plan, execution).issues.map((i) => i.code);

      expect(codes).toEqual([
        "policy_version_mismatch",
        "plan_stale",
        "cutoff_mismatch",
        "count_drift",
        "category_missing",
        "category_unplanned",
      ]);
      expect(
        compareWithPlan(execution, plan).issues.map((i) => i.code),
      ).toEqual(
        expect.arrayContaining([
          "plan_not_dry_run",
          "execution_not_execute",
          "plan_after_execution",
        ]),
      );
    });
  });

  describe("sensitive data exclusion", () => {
    it("never selects or reports record contents", async () => {
      const { service, byModel } = serviceWith({
        auth_sessions: new RecordingDelegate([
          aged("session-id-1", "expiresAt", 90, {
            rotatedToId: null,
            tokenHash: "tokenhash-deadbeef",
            userId: "user-secret-1",
          }),
        ]),
        wallet_challenges: new RecordingDelegate([
          aged("challenge-id-1", "expiresAt", 90, {
            walletAddress:
              "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
            message: "sign me",
          }),
        ]),
        webhook_deliveries: new RecordingDelegate([
          aged("delivery-id-1", "createdAt", 90, {
            webhook: { organizationId: "org_a" },
            payload: { amount: "1234.56" },
            responseBody: "receiver said hello",
          }),
        ]),
      });

      const result = await service.run({ dryRun: true });
      const serialized = JSON.stringify(result);

      for (const forbidden of [
        "session-id-1",
        "tokenhash-deadbeef",
        "user-secret-1",
        "challenge-id-1",
        "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        "sign me",
        "delivery-id-1",
        "1234.56",
        "receiver said hello",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }

      // Selection itself reads only ids and the owning organization.
      for (const delegate of Object.values(byModel)) {
        for (const select of delegate.selects) {
          expect(Object.keys(select).sort()).toEqual(
            expect.arrayContaining(["id"]),
          );
          expect(
            Object.keys(select).filter((k) => k !== "id" && k !== "webhook"),
          ).toEqual([]);
        }
      }
    });
  });

  describe("empty results and boundaries", () => {
    it("reports zero counts and no buckets when nothing is eligible", async () => {
      const { service } = serviceWith({});

      const result = await service.run({ dryRun: true });
      const report = reportOf(result);

      expect(report.totals).toEqual({ selected: 0, affected: 0 });
      for (const category of report.categories) {
        expect(category).toMatchObject({
          selected: 0,
          affected: 0,
          truncated: false,
          failed: false,
          organizations: [],
          otherOrganizations: { buckets: 0, count: 0 },
        });
      }
      expect(result.totalAffected).toBe(0);
    });

    it("excludes a record exactly on the cutoff in both modes", async () => {
      const cutoff = new Date(NOW.getTime() - 7 * DAY_MS);
      const rows = () => [
        { id: "exact", expiresAt: new Date(cutoff.getTime()) },
        { id: "just-past", expiresAt: new Date(cutoff.getTime() - 1) },
      ];

      const preview = new RecordingDelegate(rows());
      const dry = await serviceWith({ wallet_challenges: preview }).service.run({
        only: ["wallet_challenges"],
        dryRun: true,
      });
      const real = new RecordingDelegate(rows());
      await serviceWith({ wallet_challenges: real }).service.run({
        only: ["wallet_challenges"],
      });

      expect(reportOf(dry).categories[0].selected).toBe(1);
      expect(preview.selectedIds).toEqual(["just-past"]);
      expect(real.deletedIds).toEqual(["just-past"]);
      expect(reportOf(dry).categories[0].cutoff).toBe(cutoff.toISOString());
    });

    it("reports truncation identically when the backlog exactly fills the cap", async () => {
      const rows = () =>
        Array.from({ length: 10_000 }, (_, i) => aged(`r${i}`, "expiresAt", 30));

      const dry = await serviceWith({
        wallet_challenges: new RecordingDelegate(rows()),
      }).service.run({ only: ["wallet_challenges"], dryRun: true });
      const real = await serviceWith({
        wallet_challenges: new RecordingDelegate(rows()),
      }).service.run({ only: ["wallet_challenges"] });

      expect(reportOf(dry).categories[0]).toMatchObject({
        selected: 10_000,
        truncated: true,
      });
      expect(reportOf(real).categories[0]).toMatchObject({
        selected: 10_000,
        affected: 10_000,
        truncated: true,
      });
    });

    it("never asks for more than one batch per query in a dry run", async () => {
      const delegate = new RecordingDelegate(
        Array.from({ length: 1_200 }, (_, i) => aged(`r${i}`, "expiresAt", 30)),
      );
      const takes: number[] = [];
      const original = delegate.findMany.bind(delegate);
      delegate.findMany = (args) => {
        takes.push(args.take);
        return original(args);
      };

      await serviceWith({ wallet_challenges: delegate }).service.run({
        only: ["wallet_challenges"],
        dryRun: true,
      });

      expect(Math.max(...takes)).toBe(500);
      expect(takes).toHaveLength(3);
    });
  });
});
