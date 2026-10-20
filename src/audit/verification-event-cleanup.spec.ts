import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FixedClock } from "../../test/time/fixed-clock";
import {
  expiredEventsFilter,
  VERIFICATION_EVENT_CLEANUP_CATEGORY,
  VERIFICATION_EVENT_CLEANUP_POLICY_VERSION,
  VerificationEventService,
} from "./verification-event.service";

/**
 * Dry-run and impact reporting for the expired verification-event cleanup
 * (earnproof-backend#209). The existing service spec covers the deletion
 * itself; this covers the preview and its report.
 */
describe("VerificationEventService expired-event cleanup", () => {
  const NOW = new Date("2026-08-26T00:00:00.000Z");

  function build(overrides: Record<string, jest.Mock> = {}) {
    const verificationEventLog = {
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 4 }),
      count: jest.fn().mockResolvedValue(4),
      findMany: jest.fn(),
      ...overrides,
    };
    const prisma = { verificationEventLog } as never;
    const config = {
      get: jest.fn((key: string) =>
        key === "verificationEventRetentionDays" ? 90 : undefined,
      ),
    } as unknown as ConfigService;
    const clock = new FixedClock(NOW);

    return {
      service: new VerificationEventService(prisma, config, clock),
      delegate: verificationEventLog,
      clock,
    };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("dry run counts eligible events and performs no writes", async () => {
    const { service, delegate } = build();

    const count = await service.cleanupExpiredEvents({ dryRun: true });

    expect(count).toBe(4);
    expect(delegate.count).toHaveBeenCalledWith({
      where: { retainUntil: { lt: NOW } },
    });
    for (const write of [
      "create",
      "createMany",
      "update",
      "updateMany",
      "delete",
      "deleteMany",
    ]) {
      expect(delegate[write as keyof typeof delegate]).not.toHaveBeenCalled();
    }
  });

  it("dry run and execution use the same predicate under a fixed clock", async () => {
    const { service, delegate } = build();

    await service.cleanupExpiredEvents({ dryRun: true });
    await service.cleanupExpiredEvents();

    const dryWhere = delegate.count.mock.calls[0][0].where;
    const realWhere = delegate.deleteMany.mock.calls[0][0].where;
    expect(dryWhere).toEqual(realWhere);
    expect(realWhere).toEqual(expiredEventsFilter(NOW));
  });

  it("keeps an event whose retainUntil equals now (strict less-than)", () => {
    const filter = expiredEventsFilter(NOW);

    expect(filter.retainUntil).toHaveProperty("lt", NOW);
    expect(filter.retainUntil).not.toHaveProperty("lte");
  });

  it("reports mode, cutoff, policy version, and counts only", async () => {
    const { service } = build();

    const dry = await service.runExpiredEventsCleanup({ dryRun: true });
    const real = await service.runExpiredEventsCleanup();

    expect(dry).toEqual({
      mode: "dry_run",
      policyVersion: VERIFICATION_EVENT_CLEANUP_POLICY_VERSION,
      evaluatedAt: NOW.toISOString(),
      categories: [
        {
          category: VERIFICATION_EVENT_CLEANUP_CATEGORY,
          cutoff: NOW.toISOString(),
          cutoffColumn: "retainUntil",
          selected: 4,
          affected: 0,
          truncated: false,
          failed: false,
          organizations: [{ organizationId: null, count: 4 }],
          otherOrganizations: { buckets: 0, count: 0 },
        },
      ],
      totals: { selected: 4, affected: 0 },
    });
    expect(real.mode).toBe("execute");
    expect(real.totals).toEqual({ selected: 4, affected: 4 });
  });

  it("reports empty results without organization buckets", async () => {
    const { service } = build({ count: jest.fn().mockResolvedValue(0) });

    const report = await service.runExpiredEventsCleanup({ dryRun: true });

    expect(report.totals).toEqual({ selected: 0, affected: 0 });
    expect(report.categories[0].organizations).toEqual([]);
  });

  it("marks a failed dry run rather than throwing, and still writes nothing", async () => {
    const { service, delegate } = build({
      count: jest.fn().mockRejectedValue(new Error("db down")),
    });

    const report = await service.runExpiredEventsCleanup({ dryRun: true });

    expect(report.categories[0].failed).toBe(true);
    expect(report.totals.selected).toBe(0);
    expect(delegate.deleteMany).not.toHaveBeenCalled();
  });

  it("evaluates against the injected clock", async () => {
    const { service, clock, delegate } = build();
    clock.set("2030-01-01T00:00:00.000Z");

    const report = await service.runExpiredEventsCleanup({ dryRun: true });

    expect(report.evaluatedAt).toBe("2030-01-01T00:00:00.000Z");
    expect(delegate.count.mock.calls[0][0].where.retainUntil.lt).toEqual(
      new Date("2030-01-01T00:00:00.000Z"),
    );
  });
});
