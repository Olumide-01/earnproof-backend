import { PrismaService } from "../../database/prisma.service";
import { RetentionCleanupService } from "./retention-cleanup.service";
import { RetentionConfigError } from "./retention-policy";

/** One row in the fake store. */
interface Row {
  id: string;
  [column: string]: unknown;
}

/**
 * Minimal in-memory stand-in for a Prisma model delegate.
 *
 * Implements enough of the query surface for the sweep — `lt` on the cutoff
 * column, `in` on ids, equality on the extra eligibility conditions — so the
 * batching, resumption, and filtering logic can be exercised without a
 * database. Calls are recorded so tests can assert *how* the sweep ran, not
 * only what it left behind.
 */
class FakeDelegate {
  rows: Row[];
  readonly takes: number[] = [];
  readonly findCalls: Array<Record<string, unknown>> = [];
  deleteCalls = 0;
  /** Invoked before each deleteMany, to simulate interruption or concurrency. */
  onDelete?: (ids: string[]) => void;

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

  async count({ where }: { where: Record<string, unknown> }): Promise<number> {
    return this.rows.filter((row) => this.matches(row, where)).length;
  }

  async findMany({
    where,
    select,
    orderBy,
    take,
    skip = 0,
  }: {
    where: Record<string, unknown>;
    select: Record<string, unknown>;
    orderBy: Array<Record<string, "asc" | "desc">>;
    take: number;
    skip?: number;
  }): Promise<Array<Record<string, unknown>>> {
    this.takes.push(take);
    this.findCalls.push({ where, select, orderBy, take, skip });

    const column = Object.keys(orderBy[0])[0];
    return this.rows
      .filter((row) => this.matches(row, where))
      .sort((a, b) => {
        const left = a[column] as Date;
        const right = b[column] as Date;
        // Mirrors the service's `id` tiebreaker, so paging is total.
        return left.getTime() - right.getTime() || a.id.localeCompare(b.id);
      })
      .slice(skip, skip + take)
      // Projects only the selected columns, as Prisma would.
      .map((row) =>
        Object.fromEntries(
          Object.keys(select)
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
    this.deleteCalls += 1;
    const ids = (where.id as { in: string[] }).in;
    this.onDelete?.(ids);

    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !ids.includes(row.id));
    return { count: before - this.rows.length };
  }
}

const NOW = new Date("2026-08-26T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

/** A row whose cutoff column sits `days` before {@link NOW}. */
function aged(id: string, column: string, days: number, extra: Row = { id }): Row {
  return { ...extra, id, [column]: new Date(NOW.getTime() - days * DAY_MS) };
}

/** Builds a service backed by fake delegates for the named classes. */
function serviceWith(delegates: Record<string, FakeDelegate>): {
  service: RetentionCleanupService;
  delegates: Record<string, FakeDelegate>;
} {
  const prisma = {
    walletChallenge: delegates.wallet_challenges ?? new FakeDelegate([]),
    authSession: delegates.auth_sessions ?? new FakeDelegate([]),
    webhookDelivery: delegates.webhook_deliveries ?? new FakeDelegate([]),
    verificationEventLog: delegates.verification_events ?? new FakeDelegate([]),
    auditLog: delegates.audit_logs ?? new FakeDelegate([]),
    anchoringIntent: delegates.failed_anchoring_intents ?? new FakeDelegate([]),
    // No legal holds: audit-log selection is unchanged (#311).
    auditLegalHold: { findMany: async () => [] },
  } as unknown as PrismaService;

  return { service: new RetentionCleanupService(prisma), delegates };
}

describe("RetentionCleanupService", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.RETENTION_WALLET_CHALLENGE_DAYS;
    delete process.env.RETENTION_WEBHOOK_DELIVERY_DAYS;
  });

  describe("cutoff boundaries", () => {
    it("removes records older than the cutoff and keeps newer ones", () => {
      // Default for wallet challenges is 7 days.
      const delegate = new FakeDelegate([
        aged("old", "expiresAt", 30),
        aged("boundary-outside", "expiresAt", 6),
        aged("recent", "expiresAt", 1),
      ]);

      const { service } = serviceWith({ wallet_challenges: delegate });

      return service
        .run({ only: ["wallet_challenges"], now: NOW })
        .then((result) => {
          expect(result.results[0].affected).toBe(1);
          expect(delegate.rows.map((row) => row.id).sort()).toEqual([
            "boundary-outside",
            "recent",
          ]);
        });
    });

    it("retains a record sitting exactly on the boundary", async () => {
      // Eligibility is `< cutoff`, so a record is never removed on the exact
      // day its retention period ends.
      const delegate = new FakeDelegate([aged("exact", "expiresAt", 7)]);
      const { service } = serviceWith({ wallet_challenges: delegate });

      await service.run({ only: ["wallet_challenges"], now: NOW });

      expect(delegate.rows).toHaveLength(1);
    });

    it("removes a record one millisecond past the boundary", async () => {
      const cutoff = new Date(NOW.getTime() - 7 * DAY_MS);
      const delegate = new FakeDelegate([
        { id: "just-past", expiresAt: new Date(cutoff.getTime() - 1) },
      ]);
      const { service } = serviceWith({ wallet_challenges: delegate });

      await service.run({ only: ["wallet_challenges"], now: NOW });

      expect(delegate.rows).toHaveLength(0);
    });

    it("moves the boundary when the retention override changes", async () => {
      process.env.RETENTION_WALLET_CHALLENGE_DAYS = "60";

      const delegate = new FakeDelegate([aged("thirty-days", "expiresAt", 30)]);
      const { service } = serviceWith({ wallet_challenges: delegate });

      await service.run({ only: ["wallet_challenges"], now: NOW });

      // Under the default of 7 days this would have been removed.
      expect(delegate.rows).toHaveLength(1);
    });
  });

  describe("bounded batching", () => {
    it("never requests more than one batch at a time", async () => {
      const rows = Array.from({ length: 1_200 }, (_, index) =>
        aged(`row-${index}`, "expiresAt", 30),
      );
      const delegate = new FakeDelegate(rows);
      const { service } = serviceWith({ wallet_challenges: delegate });

      await service.run({ only: ["wallet_challenges"], now: NOW });

      // An unbounded deleteMany holds locks for as long as it runs; every
      // request here must be capped.
      expect(Math.max(...delegate.takes)).toBe(500);
    });

    it("drains a backlog across multiple batches in one run", async () => {
      const rows = Array.from({ length: 1_200 }, (_, index) =>
        aged(`row-${index}`, "expiresAt", 30),
      );
      const delegate = new FakeDelegate(rows);
      const { service } = serviceWith({ wallet_challenges: delegate });

      const result = await service.run({
        only: ["wallet_challenges"],
        now: NOW,
      });

      expect(result.results[0].affected).toBe(1_200);
      expect(result.results[0].batches).toBe(3);
      expect(result.results[0].truncated).toBe(false);
    });

    it("reports truncation rather than silently leaving a backlog", async () => {
      // 20 batches of 500 is the per-run cap. A sweep that stopped early while
      // reporting success would let a backlog grow unnoticed.
      const rows = Array.from({ length: 10_600 }, (_, index) =>
        aged(`row-${index}`, "expiresAt", 30),
      );
      const delegate = new FakeDelegate(rows);
      const { service } = serviceWith({ wallet_challenges: delegate });

      const result = await service.run({
        only: ["wallet_challenges"],
        now: NOW,
      });

      expect(result.results[0].truncated).toBe(true);
      expect(result.results[0].affected).toBe(10_000);
      expect(delegate.rows).toHaveLength(600);
    });

    it("stops as soon as the eligible set is drained", async () => {
      const delegate = new FakeDelegate([aged("only", "expiresAt", 30)]);
      const { service } = serviceWith({ wallet_challenges: delegate });

      await service.run({ only: ["wallet_challenges"], now: NOW });

      // One short batch is enough; a second query would be wasted work.
      expect(delegate.deleteCalls).toBe(1);
    });
  });

  describe("restart and resumption", () => {
    it("continues from where an interrupted run stopped", async () => {
      const rows = Array.from({ length: 1_200 }, (_, index) =>
        aged(`row-${index}`, "expiresAt", 30),
      );
      const delegate = new FakeDelegate(rows);
      const { service } = serviceWith({ wallet_challenges: delegate });

      // Simulate a crash after the first batch.
      let batchesSeen = 0;
      delegate.onDelete = () => {
        batchesSeen += 1;
        if (batchesSeen === 2) throw new Error("process died");
      };

      const first = await service.run({
        only: ["wallet_challenges"],
        now: NOW,
      });
      // The class failed mid-sweep; the run reports it and moves on.
      expect(first.skipped).toBe(false);

      const remaining = delegate.rows.length;
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(1_200);

      // A fresh run needs no persisted cursor: fewer rows are eligible, so it
      // simply continues.
      delegate.onDelete = undefined;
      const second = await service.run({
        only: ["wallet_challenges"],
        now: NOW,
      });

      expect(second.results[0].affected).toBe(remaining);
      expect(delegate.rows).toHaveLength(0);
    });

    it("leaves rows eligible when a delete fails, losing no progress", async () => {
      const delegate = new FakeDelegate([aged("row", "expiresAt", 30)]);
      const { service } = serviceWith({ wallet_challenges: delegate });

      delegate.onDelete = () => {
        throw new Error("transient failure");
      };

      await service.run({ only: ["wallet_challenges"], now: NOW });
      expect(delegate.rows).toHaveLength(1);

      delegate.onDelete = undefined;
      await service.run({ only: ["wallet_challenges"], now: NOW });
      expect(delegate.rows).toHaveLength(0);
    });
  });

  describe("single-run coordination", () => {
    it("skips a run that would overlap one already in progress", async () => {
      const rows = Array.from({ length: 600 }, (_, index) =>
        aged(`row-${index}`, "expiresAt", 30),
      );
      const delegate = new FakeDelegate(rows);
      const { service } = serviceWith({ wallet_challenges: delegate });

      let concurrent: Awaited<ReturnType<typeof service.run>> | undefined;

      // Fire a second run from inside the first, which is exactly what a slow
      // sweep overlapping its next tick would do.
      delegate.onDelete = () => {
        if (!concurrent) {
          void service
            .run({ only: ["wallet_challenges"], now: NOW })
            .then((result) => {
              concurrent = result;
            });
        }
      };

      await service.run({ only: ["wallet_challenges"], now: NOW });
      await Promise.resolve();

      expect(concurrent?.skipped).toBe(true);
      expect(concurrent?.totalAffected).toBe(0);
    });

    it("clears the guard once a run finishes", async () => {
      const { service } = serviceWith({});

      await service.run({ only: ["wallet_challenges"], now: NOW });
      expect(service.isRunning).toBe(false);

      const second = await service.run({
        only: ["wallet_challenges"],
        now: NOW,
      });
      expect(second.skipped).toBe(false);
    });

    it("clears the guard even when a sweep throws", async () => {
      const delegate = new FakeDelegate([aged("row", "expiresAt", 30)]);
      const { service } = serviceWith({ wallet_challenges: delegate });

      delegate.onDelete = () => {
        throw new Error("boom");
      };

      await service.run({ only: ["wallet_challenges"], now: NOW });

      // A guard left set by a failure would silently disable cleanup forever.
      expect(service.isRunning).toBe(false);
    });
  });

  describe("dry run", () => {
    it("reports eligible records without deleting them", async () => {
      const delegate = new FakeDelegate([
        aged("old-1", "expiresAt", 30),
        aged("old-2", "expiresAt", 30),
        aged("recent", "expiresAt", 1),
      ]);
      const { service } = serviceWith({ wallet_challenges: delegate });

      const result = await service.run({
        only: ["wallet_challenges"],
        now: NOW,
        dryRun: true,
      });

      expect(result.results[0].affected).toBe(2);
      expect(result.results[0].dryRun).toBe(true);
      expect(delegate.deleteCalls).toBe(0);
      expect(delegate.rows).toHaveLength(3);
    });

    it("agrees with what a real run then removes", async () => {
      // The check is only useful if the preview matches the outcome.
      const build = () =>
        new FakeDelegate([
          aged("a", "expiresAt", 30),
          aged("b", "expiresAt", 20),
          aged("c", "expiresAt", 1),
        ]);

      const preview = build();
      const previewResult = await serviceWith({
        wallet_challenges: preview,
      }).service.run({ only: ["wallet_challenges"], now: NOW, dryRun: true });

      const real = build();
      const realResult = await serviceWith({
        wallet_challenges: real,
      }).service.run({ only: ["wallet_challenges"], now: NOW });

      expect(previewResult.results[0].affected).toBe(
        realResult.results[0].affected,
      );
    });
  });

  describe("relation and tenancy constraints", () => {
    it("never sweeps a session still referenced by its rotation successor", async () => {
      // Deleting a rotated session would break the chain its successor points
      // at, which is a relation constraint the cutoff alone cannot express.
      const delegate = new FakeDelegate([
        { id: "rotated", expiresAt: new Date(NOW.getTime() - 90 * DAY_MS), rotatedToId: "newer" },
        { id: "orphan", expiresAt: new Date(NOW.getTime() - 90 * DAY_MS), rotatedToId: null },
      ]);
      const { service } = serviceWith({ auth_sessions: delegate });

      await service.run({ only: ["auth_sessions"], now: NOW });

      expect(delegate.rows.map((row) => row.id)).toEqual(["rotated"]);
    });

    it("sweeps only permanently-failed anchoring intents", async () => {
      // Confirmed intents carry the transaction hash linking a proof to the
      // ledger; pending intents are unfinished work. Neither may be swept.
      const old = new Date(NOW.getTime() - 200 * DAY_MS);
      const delegate = new FakeDelegate([
        { id: "failed", updatedAt: old, status: "FAILED", permanentError: true },
        { id: "confirmed", updatedAt: old, status: "CONFIRMED", permanentError: false },
        { id: "pending", updatedAt: old, status: "PENDING", permanentError: false },
        // Failed but still retryable: not permanent, so not eligible.
        { id: "retrying", updatedAt: old, status: "FAILED", permanentError: false },
      ]);
      const { service } = serviceWith({ failed_anchoring_intents: delegate });

      await service.run({ only: ["failed_anchoring_intents"], now: NOW });

      expect(delegate.rows.map((row) => row.id).sort()).toEqual([
        "confirmed",
        "pending",
        "retrying",
      ]);
    });

    it("scopes every deletion to explicitly selected ids", async () => {
      // Deleting by id, rather than by the eligibility filter, is what makes a
      // cross-tenant cascade impossible: the sweep can only remove rows it
      // selected under the cutoff for that one class.
      const delegate = new FakeDelegate([
        aged("eligible", "expiresAt", 30),
        aged("ineligible", "expiresAt", 1),
      ]);
      const { service } = serviceWith({ wallet_challenges: delegate });

      const seen: string[][] = [];
      delegate.onDelete = (ids) => seen.push(ids);

      await service.run({ only: ["wallet_challenges"], now: NOW });

      expect(seen).toEqual([["eligible"]]);
    });
  });

  describe("preserved classes", () => {
    it.each(["proofs", "revocation_evidence", "anchoring_state"])(
      "refuses to sweep %s even when named explicitly",
      async (key) => {
        const { service } = serviceWith({});
        await expect(service.run({ only: [key], now: NOW })).rejects.toThrow(
          RetentionConfigError,
        );
      },
    );

    it("refuses an unknown class rather than sweeping nothing quietly", async () => {
      const { service } = serviceWith({});
      await expect(
        service.run({ only: ["not_a_class"], now: NOW }),
      ).rejects.toThrow(/Unknown or non-sweepable/);
    });

    it("sweeps every sweepable class when none is named", async () => {
      const delegates = {
        wallet_challenges: new FakeDelegate([aged("wc", "expiresAt", 90)]),
        auth_sessions: new FakeDelegate([
          { id: "as", expiresAt: new Date(NOW.getTime() - 90 * DAY_MS), rotatedToId: null },
        ]),
        webhook_deliveries: new FakeDelegate([aged("wd", "createdAt", 90)]),
        audit_logs: new FakeDelegate([aged("al", "createdAt", 500)]),
      };
      const { service } = serviceWith(delegates);

      const result = await service.run({ now: NOW });

      expect(result.results).toHaveLength(7);
      expect(result.totalAffected).toBe(4);
    });
  });

  describe("failure isolation", () => {
    it("continues to later classes when one fails", async () => {
      // A misconfigured duration on one class must not stop the others from
      // being swept.
      process.env.RETENTION_WEBHOOK_DELIVERY_DAYS = "not-a-number";

      const challenges = new FakeDelegate([aged("wc", "expiresAt", 90)]);
      const { service } = serviceWith({
        wallet_challenges: challenges,
        webhook_deliveries: new FakeDelegate([aged("wd", "createdAt", 90)]),
      });

      const result = await service.run({ now: NOW });

      const webhook = result.results.find(
        (entry) => entry.key === "webhook_deliveries",
      );
      const challenge = result.results.find(
        (entry) => entry.key === "wallet_challenges",
      );

      expect(webhook?.affected).toBe(0);
      expect(challenge?.affected).toBe(1);
      expect(challenges.rows).toHaveLength(0);
    });
  });

  describe("reporting", () => {
    it("returns counts only, never record content", async () => {
      const delegate = new FakeDelegate([
        { id: "secret-proof-id", expiresAt: new Date(NOW.getTime() - 90 * DAY_MS) },
      ]);
      const { service } = serviceWith({ wallet_challenges: delegate });

      const result = await service.run({
        only: ["wallet_challenges"],
        now: NOW,
      });

      // The result shape carries no room for record identity at all.
      expect(Object.keys(result.results[0]).sort()).toEqual([
        "affected",
        "batches",
        "dryRun",
        "key",
        "truncated",
      ]);
      expect(JSON.stringify(result)).not.toContain("secret-proof-id");
    });

    it("totals affected records across classes", async () => {
      const { service } = serviceWith({
        wallet_challenges: new FakeDelegate([
          aged("a", "expiresAt", 90),
          aged("b", "expiresAt", 90),
        ]),
        audit_logs: new FakeDelegate([aged("c", "createdAt", 500)]),
      });

      const result = await service.run({ now: NOW });
      expect(result.totalAffected).toBe(3);
    });
  });
});
