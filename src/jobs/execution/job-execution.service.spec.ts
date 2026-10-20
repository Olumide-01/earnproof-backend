import { JobExecutionOutcome } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import {
  JobCancelledError,
  JobExecutionService,
} from "./job-execution.service";

interface Row {
  id: string;
  jobName: string;
  jobVersion: string;
  leaseOwner: string;
  attempt: number;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: JobExecutionOutcome | null;
  errorCategory: string | null;
  originalExecutionId: string | null;
  retainUntil: Date;
}

/**
 * In-memory stand-in for the JobExecution delegate.
 *
 * Implements exactly the query surface the service uses — create, the
 * `finishedAt: null`-guarded updateMany, findMany with an `lt` cutoff and a
 * `take`, and deleteMany by id — so the invariants (one terminal outcome, crash
 * recovery, pruning) are exercised without a database.
 */
class FakeStore {
  rows: Row[] = [];
  private seq = 0;

  asPrisma(): PrismaService {
    return { jobExecution: this } as unknown as PrismaService;
  }

  async create({ data, select }: any) {
    const row: Row = {
      id: `exec_${this.seq++}`,
      jobName: data.jobName,
      jobVersion: data.jobVersion,
      leaseOwner: data.leaseOwner,
      attempt: data.attempt ?? 1,
      startedAt: new Date(),
      finishedAt: null,
      outcome: null,
      errorCategory: null,
      originalExecutionId: data.originalExecutionId ?? null,
      retainUntil: data.retainUntil,
    };
    this.rows.push(row);
    return select ? { id: row.id } : row;
  }

  async updateMany({ where, data }: any) {
    let count = 0;
    for (const row of this.rows) {
      if (row.id !== where.id) continue;
      if (where.finishedAt === null && row.finishedAt !== null) continue;
      row.outcome = data.outcome;
      row.errorCategory = data.errorCategory ?? null;
      row.finishedAt = data.finishedAt;
      count += 1;
    }
    return { count };
  }

  async findMany({ where, take, orderBy }: any) {
    let matched = this.rows.filter((row) => {
      if (where?.finishedAt === null && row.finishedAt !== null) return false;
      if (where?.startedAt?.lt && !(row.startedAt < where.startedAt.lt)) {
        return false;
      }
      if (where?.retainUntil?.lt && !(row.retainUntil < where.retainUntil.lt)) {
        return false;
      }
      if (where?.jobName && row.jobName !== where.jobName) return false;
      if (where?.outcome && row.outcome !== where.outcome) return false;
      return true;
    });

    if (orderBy?.startedAt === "desc") {
      matched = matched.sort(
        (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
      );
    }
    if (orderBy?.retainUntil === "asc") {
      matched = matched.sort(
        (a, b) => a.retainUntil.getTime() - b.retainUntil.getTime(),
      );
    }

    return matched.slice(0, take).map((row) => ({ ...row }));
  }

  async deleteMany({ where }: any) {
    const ids: string[] = where.id.in;
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !ids.includes(row.id));
    return { count: before - this.rows.length };
  }
}

function descriptor(overrides = {}) {
  return {
    jobName: "retention-cleanup",
    jobVersion: "1",
    leaseOwner: "host:123",
    ...overrides,
  };
}

describe("JobExecutionService", () => {
  let store: FakeStore;
  let service: JobExecutionService;

  beforeEach(() => {
    store = new FakeStore();
    service = new JobExecutionService(store.asPrisma());
  });

  describe("track", () => {
    it("records a SUCCEEDED terminal outcome on the happy path", async () => {
      const result = await service.track(descriptor(), async () => "done");

      expect(result).toBe("done");
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0].outcome).toBe(JobExecutionOutcome.SUCCEEDED);
      expect(store.rows[0].finishedAt).not.toBeNull();
      expect(store.rows[0].errorCategory).toBeNull();
    });

    it("records FAILED with a bounded category and re-throws the error", async () => {
      const boom = new Error("connect ECONNREFUSED 10.0.0.5:5432");
      (boom as { status?: number }).status = 503;

      await expect(
        service.track(descriptor(), async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      const row = store.rows[0];
      expect(row.outcome).toBe(JobExecutionOutcome.FAILED);
      // The category is stored; the message (with its host and port) is not.
      expect(row.errorCategory).toBe("dependency_unavailable");
      expect(JSON.stringify(row)).not.toContain("ECONNREFUSED");
    });

    it("records CANCELLED when the work signals cancellation", async () => {
      await expect(
        service.track(descriptor(), async () => {
          throw new JobCancelledError();
        }),
      ).rejects.toBeInstanceOf(JobCancelledError);

      expect(store.rows[0].outcome).toBe(JobExecutionOutcome.CANCELLED);
      expect(store.rows[0].errorCategory).toBe("cancelled");
    });
  });

  describe("one terminal outcome", () => {
    it("ignores a second completion (overlap / duplicate delivery)", async () => {
      const { id } = await service.begin(descriptor());

      expect(await service.finish(id, JobExecutionOutcome.SUCCEEDED)).toBe(true);
      // A late crash-recovery or duplicate must not overwrite the settled row.
      expect(await service.finish(id, JobExecutionOutcome.CRASHED)).toBe(false);

      expect(store.rows[0].outcome).toBe(JobExecutionOutcome.SUCCEEDED);
    });
  });

  describe("retries", () => {
    it("links a retry to the root execution and increments the attempt", async () => {
      const first = await service.begin(descriptor());
      await service.finish(first.id, JobExecutionOutcome.FAILED, "timeout");

      const retry = await service.beginRetry(
        { id: first.id, attempt: 1, originalExecutionId: null },
        descriptor(),
      );
      const retryRow = store.rows.find((row) => row.id === retry.id)!;
      expect(retryRow.originalExecutionId).toBe(first.id);
      expect(retryRow.attempt).toBe(2);

      // A retry of a retry still points at the original root, staying flat.
      const third = await service.beginRetry(
        { id: retry.id, attempt: 2, originalExecutionId: first.id },
        descriptor(),
      );
      expect(store.rows.find((row) => row.id === third.id)!.originalExecutionId).toBe(
        first.id,
      );
    });
  });

  describe("recoverCrashed", () => {
    it("marks long-running orphaned executions CRASHED, leaving fresh ones", async () => {
      const now = new Date("2026-01-01T12:00:00Z");
      const crashed = await service.begin(descriptor());
      const fresh = await service.begin(descriptor());
      // Age the first row past the staleness threshold.
      store.rows.find((row) => row.id === crashed.id)!.startedAt = new Date(
        now.getTime() - 60 * 60 * 1000,
      );
      store.rows.find((row) => row.id === fresh.id)!.startedAt = now;

      const recovered = await service.recoverCrashed({
        staleAfterMs: 15 * 60 * 1000,
        now,
      });

      expect(recovered).toBe(1);
      expect(store.rows.find((row) => row.id === crashed.id)!.outcome).toBe(
        JobExecutionOutcome.CRASHED,
      );
      expect(store.rows.find((row) => row.id === fresh.id)!.outcome).toBeNull();
    });

    it("does not overwrite a worker that finished just before recovery ran", async () => {
      const now = new Date("2026-01-01T12:00:00Z");
      const slow = await service.begin(descriptor());
      const row = store.rows[0];
      row.startedAt = new Date(now.getTime() - 60 * 60 * 1000);
      // The slow-but-alive worker wins the race and completes first.
      await service.finish(slow.id, JobExecutionOutcome.SUCCEEDED);

      const recovered = await service.recoverCrashed({
        staleAfterMs: 15 * 60 * 1000,
        now,
      });

      expect(recovered).toBe(0);
      expect(row.outcome).toBe(JobExecutionOutcome.SUCCEEDED);
    });
  });

  describe("listRecent", () => {
    it("caps the limit at MAX_QUERY_LIMIT", async () => {
      for (let i = 0; i < 150; i += 1) await service.begin(descriptor());
      const rows = await service.listRecent({ limit: 10_000 });
      expect(rows.length).toBe(JobExecutionService.MAX_QUERY_LIMIT);
    });

    it("derives durationMs for finished rows and null for running ones", async () => {
      const { id } = await service.begin(descriptor());
      const row = store.rows[0];
      row.startedAt = new Date("2026-01-01T00:00:00Z");
      await service.finish(id, JobExecutionOutcome.SUCCEEDED);
      row.finishedAt = new Date("2026-01-01T00:00:05Z");

      const [finished] = await service.listRecent({});
      expect(finished.durationMs).toBe(5_000);

      await service.begin(descriptor());
      const running = (await service.listRecent({ onlyRunning: true }))[0];
      expect(running.durationMs).toBeNull();
    });
  });

  describe("prune", () => {
    it("removes only rows whose retention window has closed", async () => {
      const now = new Date("2026-01-10T00:00:00Z");
      const expired = await service.begin(descriptor());
      const live = await service.begin(descriptor());
      store.rows.find((row) => row.id === expired.id)!.retainUntil = new Date(
        "2026-01-01T00:00:00Z",
      );
      store.rows.find((row) => row.id === live.id)!.retainUntil = new Date(
        "2026-02-01T00:00:00Z",
      );

      const removed = await service.prune({ now });

      expect(removed).toBe(1);
      expect(store.rows.map((row) => row.id)).toEqual([live.id]);
    });

    it("returns 0 when nothing is expired", async () => {
      await service.begin(descriptor());
      expect(await service.prune({ now: new Date("2020-01-01") })).toBe(0);
    });
  });
});
