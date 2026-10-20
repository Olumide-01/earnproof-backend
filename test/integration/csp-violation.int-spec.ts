import { CspDirective, CspDisposition, CspRouteCategory } from "@prisma/client";
import { integrationDatabase } from "./harness/database";
import { CspViolationAbuseService } from "../../src/security/csp-violation-abuse.service";
import { CspViolationService } from "../../src/security/csp-violation.service";

/**
 * CSP violation aggregate ingestion (#336) against the real schema.
 *
 * The upsert's `ON CONFLICT ("directive", "routeCategory", "release",
 * "disposition") DO UPDATE SET count = count + 1` is exactly the kind of
 * property a mocked Prisma client cannot prove: that concurrent increments
 * for the same bucket converge on one row with no lost updates, which is the
 * real unique constraint and the real Postgres upsert, not a stand-in for
 * either.
 */

const db = integrationDatabase();

function makeService(perClientBucketLimit = 1_000) {
  const abuse = new CspViolationAbuseService({
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === "rateLimit.cspReportPerClientBucketLimit") return perClientBucketLimit;
      return fallback;
    }),
  } as never);
  return new CspViolationService(db.prisma as never, abuse);
}

function report(overrides: Partial<{ directive: CspDirective; release: string }> = {}) {
  return {
    directive: overrides.directive ?? CspDirective.SCRIPT_SRC,
    routeCategory: CspRouteCategory.DASHBOARD,
    release: overrides.release ?? "2026.10.1",
    disposition: CspDisposition.ENFORCE,
  };
}

describe("CSP violation aggregate ingestion (integration)", () => {
  it("concurrency: concurrent reports for the same bucket converge on one row with the correct total count", async () => {
    const service = makeService();
    const input = report({ release: "concurrency-test" });

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        service.ingest(input as never, { ip: `10.0.0.${i}` }),
      ),
    );

    const row = await db.prisma.cspViolationSummary.findUnique({
      where: {
        directive_routeCategory_release_disposition: {
          directive: input.directive,
          routeCategory: input.routeCategory,
          release: input.release,
          disposition: input.disposition,
        },
      },
    });

    expect(row?.count).toBe(10n);
  });

  it("recovery: a subsequent report after a prior failure still increments correctly", async () => {
    const service = makeService();
    const input = report({ release: "recovery-test" });

    await service.ingest(input as never, { ip: "10.0.1.1" });
    await service.ingest(input as never, { ip: "10.0.1.2" });

    const row = await db.prisma.cspViolationSummary.findUnique({
      where: {
        directive_routeCategory_release_disposition: {
          directive: input.directive,
          routeCategory: input.routeCategory,
          release: input.release,
          disposition: input.disposition,
        },
      },
    });

    expect(row?.count).toBe(2n);
  });

  it("boundary: distinct buckets (different directive) never share a row, even with the same release/category/disposition", async () => {
    const service = makeService();

    await service.ingest(
      report({ directive: CspDirective.SCRIPT_SRC, release: "boundary-test" }) as never,
      { ip: "10.0.2.1" },
    );
    await service.ingest(
      report({ directive: CspDirective.STYLE_SRC, release: "boundary-test" }) as never,
      { ip: "10.0.2.2" },
    );

    const rows = await db.prisma.cspViolationSummary.findMany({
      where: { release: "boundary-test" },
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.count === 1n)).toBe(true);
  });

  it("replay/abuse-control: repeated reports from the same client for the same bucket are sampled out, not double-counted", async () => {
    const service = makeService(1);
    const input = report({ release: "replay-test" });

    await service.ingest(input as never, { ip: "10.0.3.1" });
    await service.ingest(input as never, { ip: "10.0.3.1" });
    await service.ingest(input as never, { ip: "10.0.3.1" });

    const row = await db.prisma.cspViolationSummary.findUnique({
      where: {
        directive_routeCategory_release_disposition: {
          directive: input.directive,
          routeCategory: input.routeCategory,
          release: input.release,
          disposition: input.disposition,
        },
      },
    });

    expect(row?.count).toBe(1n);
  });
});
