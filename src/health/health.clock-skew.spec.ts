import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../database/prisma.service";
import type { ClockSkewMonitorService, ClockSkewSnapshot } from "./clock-skew-monitor.service";
import { HealthService } from "./health.service";
import { DependencyKind, DependencyStatus } from "./health.types";

/** Readiness and diagnostics integration of the clock skew monitor (#328). */

function buildConfig(): ConfigService {
  const values: Record<string, unknown> = {
    databaseUrl: "postgresql://localhost/earnproof",
    sessionSecret: "session-secret",
    credentialSigningSecret: "signing-secret",
    "health.probeTimeoutMs": 50,
    "health.cacheTtlMs": 0,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function buildPrisma(): PrismaService {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
    webhookDelivery: { count: jest.fn().mockResolvedValue(0) },
  } as unknown as PrismaService;
}

function snapshot(overrides: Partial<ClockSkewSnapshot> = {}): ClockSkewSnapshot {
  return {
    status: "ok",
    skewMs: 0,
    source: "horizon_http_date",
    samplesConsidered: 2,
    evaluatedAt: "2030-01-01T00:00:00.000Z",
    alert: { active: false, severity: null, breachStartedAt: null },
    policy: { warnMs: 2_000, criticalMs: 10_000, unknownPolicy: "fail_closed", readinessImpact: "critical" },
    sources: [{ name: "horizon_http_date", outcome: "ok", skewMs: 0 }],
    ...overrides,
  };
}

function monitor(options: {
  enabled?: boolean;
  readinessImpact?: "none" | "critical";
  blocks?: boolean;
  snapshot?: ClockSkewSnapshot;
}): ClockSkewMonitorService {
  return {
    enabled: options.enabled ?? true,
    readinessImpact: options.readinessImpact ?? "critical",
    blocksReadiness: jest.fn(() => options.blocks ?? false),
    snapshot: jest.fn(() => options.snapshot ?? snapshot()),
  } as unknown as ClockSkewMonitorService;
}

function service(clockSkew?: ClockSkewMonitorService): HealthService {
  return new HealthService(buildPrisma(), buildConfig(), undefined, undefined, undefined, clockSkew);
}

describe("HealthService clock skew integration", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200 } as Response);
  });

  afterEach(() => jest.restoreAllMocks());

  describe("readiness", () => {
    it("is unchanged when no monitor is wired (regression)", async () => {
      const result = await service().checkReadiness();
      expect(result.status).toBe("ready");
      expect(result.dependencies.map((d) => d.name)).not.toContain("clock_skew");
    });

    it("adds a required clock_skew dependency that passes when not blocked", async () => {
      const result = await service(monitor({})).checkReadiness();
      const dependency = result.dependencies.find((d) => d.name === "clock_skew");

      expect(result.status).toBe("ready");
      expect(dependency).toMatchObject({ kind: DependencyKind.REQUIRED, status: DependencyStatus.OK });
    });

    it("fails readiness during a sustained critical alert", async () => {
      const result = await service(monitor({ blocks: true })).checkReadiness();

      expect(result.status).toBe("not_ready");
      expect(result.dependencies.find((d) => d.name === "clock_skew")).toMatchObject({
        status: DependencyStatus.ERROR,
        reason: "clock_skew_sustained_critical",
      });
    });

    it("never exposes skew detail on the public readiness probe", async () => {
      const result = await service(monitor({ blocks: true })).checkReadiness();
      expect(result.dependencies.find((d) => d.name === "clock_skew")).not.toHaveProperty("clockSkew");
    });

    it("omits clock_skew from readiness when impact is none or the monitor is disabled", async () => {
      for (const clockSkew of [monitor({ readinessImpact: "none" }), monitor({ enabled: false })]) {
        const result = await service(clockSkew).checkReadiness();
        expect(result.dependencies.map((d) => d.name)).not.toContain("clock_skew");
      }
    });

    it("re-reads monitor state on every poll instead of caching the verdict", async () => {
      const clockSkew = monitor({});
      const health = service(clockSkew);
      await health.checkReadiness();
      await health.checkReadiness();
      expect(clockSkew.blocksReadiness).toHaveBeenCalledTimes(2);
    });
  });

  describe("diagnostics", () => {
    async function diagnosticsEntry(clockSkew?: ClockSkewMonitorService) {
      const result = await service(clockSkew).checkDiagnostics();
      return { result, entry: result.dependencies.find((d) => d.name === "clock_skew") };
    }

    it("reports NOT_CONFIGURED without a monitor", async () => {
      const { entry } = await diagnosticsEntry();
      expect(entry).toMatchObject({ status: DependencyStatus.NOT_CONFIGURED });
    });

    it("reports DISABLED when monitoring is switched off", async () => {
      const { entry } = await diagnosticsEntry(monitor({ enabled: false }));
      expect(entry).toMatchObject({ status: DependencyStatus.DISABLED });
    });

    it.each([
      ["ok", DependencyStatus.OK, undefined],
      ["warning", DependencyStatus.DEGRADED, "clock_skew_warning"],
      ["critical", DependencyStatus.ERROR, "clock_skew_critical"],
    ] as const)("maps %s to %s as an optional entry", async (status, expected, reason) => {
      const { result, entry } = await diagnosticsEntry(monitor({ snapshot: snapshot({ status }) }));
      expect(entry).toMatchObject({ kind: DependencyKind.OPTIONAL, status: expected });
      expect(entry?.reason).toBe(reason);
      // An unsustained deviation must not flip the diagnostics verdict.
      expect(result.status).toBe("ready");
    });

    it("maps unknown according to the explicit policy", async () => {
      const closed = await diagnosticsEntry(
        monitor({ snapshot: snapshot({ status: "unknown", reason: "no_samples" }) }),
      );
      expect(closed.entry).toMatchObject({
        status: DependencyStatus.ERROR,
        reason: "clock_skew_unknown:no_samples",
      });

      const open = await diagnosticsEntry(
        monitor({
          snapshot: snapshot({
            status: "unknown",
            reason: "no_fresh_samples",
            policy: { warnMs: 2_000, criticalMs: 10_000, unknownPolicy: "fail_open", readinessImpact: "critical" },
          }),
        }),
      );
      expect(open.entry).toMatchObject({
        status: DependencyStatus.DEGRADED,
        reason: "clock_skew_unknown:no_fresh_samples",
      });
    });

    it("agrees with readiness when the monitor blocks", async () => {
      const { result, entry } = await diagnosticsEntry(
        monitor({ blocks: true, snapshot: snapshot({ status: "critical" }) }),
      );
      expect(entry).toMatchObject({
        kind: DependencyKind.REQUIRED,
        status: DependencyStatus.ERROR,
        reason: "clock_skew_sustained_critical",
      });
      expect(result.status).toBe("not_ready");
    });

    it("attaches the privacy-safe snapshot", async () => {
      const { entry } = await diagnosticsEntry(monitor({}));
      expect(entry?.clockSkew).toEqual(snapshot());
    });
  });
});
