import { CspDirective, CspDisposition, CspRouteCategory } from "@prisma/client";
import { CspViolationService } from "./csp-violation.service";

function makeReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    directive: CspDirective.SCRIPT_SRC,
    routeCategory: CspRouteCategory.DASHBOARD,
    release: "2026.10.1",
    disposition: CspDisposition.ENFORCE,
    ...overrides,
  };
}

function makePrisma() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    cspViolationSummary: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function makeAbuse(accept = true) {
  return { shouldAccept: jest.fn().mockReturnValue(accept) };
}

describe("CspViolationService", () => {
  describe("positive", () => {
    it("upserts the aggregate row for a report that passes sampling", async () => {
      const prisma = makePrisma();
      const abuse = makeAbuse(true);
      const service = new CspViolationService(prisma as never, abuse as never);

      await service.ingest(makeReport() as never, { ip: "1.2.3.4" });

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe("negative / sampling", () => {
    it("does not touch storage when the abuse service samples the report out", async () => {
      const prisma = makePrisma();
      const abuse = makeAbuse(false);
      const service = new CspViolationService(prisma as never, abuse as never);

      await service.ingest(makeReport() as never, { ip: "1.2.3.4" });

      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it("checks sampling against a bucket key derived from all four fields, not a fixed key", async () => {
      const prisma = makePrisma();
      const abuse = makeAbuse(true);
      const service = new CspViolationService(prisma as never, abuse as never);

      await service.ingest(makeReport({ directive: CspDirective.IMG_SRC }) as never, {
        ip: "1.2.3.4",
      });

      const [, bucketKey] = abuse.shouldAccept.mock.calls[0];
      expect(bucketKey).toContain("IMG_SRC");
      expect(bucketKey).toContain("DASHBOARD");
      expect(bucketKey).toContain("2026.10.1");
      expect(bucketKey).toContain("ENFORCE");
    });
  });

  describe("regression / fail-open", () => {
    it("never throws when the upsert fails (fail-open, matching ApiKeyUsageService)", async () => {
      const prisma = makePrisma();
      prisma.$executeRaw.mockRejectedValue(new Error("connection reset"));
      const abuse = makeAbuse(true);
      const service = new CspViolationService(prisma as never, abuse as never);

      await expect(
        service.ingest(makeReport() as never, { ip: "1.2.3.4" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("boundary", () => {
    it("rounds lastSeenAt down to the nearest minute before storing", async () => {
      const prisma = makePrisma();
      const abuse = makeAbuse(true);
      const service = new CspViolationService(prisma as never, abuse as never);

      jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:45.500Z"));
      await service.ingest(makeReport() as never, { ip: "1.2.3.4" });
      jest.useRealTimers();

      const callArgs = prisma.$executeRaw.mock.calls[0];
      // Tagged-template call: values are passed as subsequent arguments.
      const dateValues = callArgs.filter((v: unknown) => v instanceof Date);
      for (const value of dateValues as Date[]) {
        expect(value.getUTCSeconds()).toBe(0);
        expect(value.getUTCMilliseconds()).toBe(0);
      }
    });
  });

  describe("getSummary", () => {
    it("returns only bounded aggregate fields, never a raw identifier", async () => {
      const prisma = makePrisma();
      prisma.cspViolationSummary.findMany.mockResolvedValue([
        {
          directive: CspDirective.SCRIPT_SRC,
          routeCategory: CspRouteCategory.DASHBOARD,
          release: "2026.10.1",
          disposition: CspDisposition.ENFORCE,
          count: 5n,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      ]);
      const service = new CspViolationService(prisma as never, makeAbuse() as never);

      const summary = await service.getSummary();

      expect(prisma.cspViolationSummary.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            directive: true,
            routeCategory: true,
            release: true,
            disposition: true,
            count: true,
          }),
        }),
      );
      expect(summary).toHaveLength(1);
      const serialized = JSON.stringify(summary, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
      expect(serialized).not.toMatch(/https?:\/\//);
    });
  });
});
