import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  HealthService,
} from "./health.service";
import { DependencyResult, DependencyStatus } from "./health.types";
import { CircuitBreakerRegistry } from "../common/resilience/circuit-breaker.registry";

interface ConfigOverrides {
  [key: string]: unknown;
}

function buildConfig(overrides: ConfigOverrides = {}): ConfigService {
  const base: ConfigOverrides = {
    databaseUrl: "postgresql://user:hunter2@db.internal:5432/earnproof",
    sessionSecret: "session-secret",
    credentialSigningSecret: "signing-secret",
    "stellar.horizonUrl": "https://horizon-testnet.stellar.org",
    "contractAnchoring.enabled": false,
    "health.probeTimeoutMs": 50,
    "health.cacheTtlMs": 0,
  };

  const merged = { ...base, ...overrides };

  return {
    get: jest.fn((key: string) => merged[key]),
  } as unknown as ConfigService;
}

function buildPrisma(overrides: Partial<PrismaService> = {}): PrismaService {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
    webhookDelivery: { count: jest.fn().mockResolvedValue(0) },
    ...overrides,
  } as unknown as PrismaService;
}

function findDependency(
  result: { dependencies: DependencyResult[] },
  name: string,
): DependencyResult {
  const dependency = result.dependencies.find((d) => d.name === name);
  if (!dependency) {
    throw new Error(`dependency "${name}" missing from result`);
  }
  return dependency;
}

const mockDrift = { checkDrift: jest.fn().mockResolvedValue({ overall: "none", items: [], lastCheckedAt: null, cached: false }), isBlocked: jest.fn().mockResolvedValue(false) } as never;

describe("HealthService", () => {
  beforeEach(() => {
    // The service logs full errors server-side by design; silence that in tests.
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("liveness", () => {
    it("performs no external calls", () => {
      const prisma = buildPrisma();
      const service = new HealthService(prisma, buildConfig(), mockDrift);

      const result = service.checkLiveness();

      expect(result.status).toBe("ok");
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe("readiness", () => {
    it("is ready when required dependencies are healthy", async () => {
      const service = new HealthService(buildPrisma(), buildConfig(), mockDrift);

      const result = await service.checkReadiness();

      expect(result.status).toBe("ready");
      expect(findDependency(result, "database").status).toBe(
        DependencyStatus.OK,
      );
    });

    it("is not ready when the database probe fails", async () => {
      const service = new HealthService(
        buildPrisma({
          $queryRaw: jest.fn().mockRejectedValue(new Error("connection refused")),
        } as Partial<PrismaService>),
        buildConfig(),
        mockDrift,
      );

      const result = await service.checkReadiness();

      expect(result.status).toBe("not_ready");
      expect(findDependency(result, "database").status).toBe(
        DependencyStatus.ERROR,
      );
    });

    it("is not ready when required configuration is absent", async () => {
      const service = new HealthService(
        buildPrisma(),
        buildConfig({ credentialSigningSecret: "" }),
        mockDrift,
      );

      const result = await service.checkReadiness();
      const configuration = findDependency(result, "configuration");

      expect(result.status).toBe("not_ready");
      expect(configuration.reason).toBe(
        "missing_required_config:credentialSigningSecret",
      );
    });

    it("excludes optional dependencies entirely", async () => {
      // Readiness must not consult optional dependencies at all: a Horizon
      // outage cannot be allowed to take unrelated routes offline.
      const service = new HealthService(buildPrisma(), buildConfig(), mockDrift);

      const result = await service.checkReadiness();
      const names = result.dependencies.map((d) => d.name);

      expect(names).toEqual(["database", "configuration"]);
    });
  });

  describe("timeouts", () => {
    it("reports timeout rather than hanging when a probe stalls", async () => {
      // Held open deliberately, then released in the assertion phase: a real
      // stalled dependency never resolves, and leaving a live timer behind
      // would leak a handle into the rest of the suite.
      let releaseStalled: () => void = () => undefined;
      const stalled = new Promise((resolve) => {
        releaseStalled = () => resolve(undefined);
      });

      const service = new HealthService(
        buildPrisma({
          $queryRaw: jest.fn().mockImplementation(() => stalled),
        } as Partial<PrismaService>),
        buildConfig({ "health.probeTimeoutMs": 20 }),
        mockDrift,
      );

      const result = await service.checkReadiness();
      releaseStalled();
      const database = findDependency(result, "database");

      expect(database.status).toBe(DependencyStatus.TIMEOUT);
      expect(database.reason).toBe("probe_timeout");
      expect(result.status).toBe("not_ready");
    });

    it("falls back to the documented default timeout", () => {
      expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(2_000);
      expect(DEFAULT_CACHE_TTL_MS).toBe(5_000);
    });
  });

  describe("redaction", () => {
    it("never leaks connection details from a driver error", async () => {
      // A real driver error commonly embeds the DSN, including the password.
      const leaky = new Error(
        "connect ECONNREFUSED postgresql://user:hunter2@db.internal:5432/earnproof",
      );

      const service = new HealthService(
        buildPrisma({
          $queryRaw: jest.fn().mockRejectedValue(leaky),
        } as Partial<PrismaService>),
        buildConfig(),
        mockDrift,
      );

      const result = await service.checkReadiness();
      const serialized = JSON.stringify(result);

      expect(findDependency(result, "database").reason).toBe("probe_failed");
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("db.internal");
      expect(serialized).not.toContain("ECONNREFUSED");
    });

    it("reports missing config by name without exposing any value", async () => {
      const service = new HealthService(
        buildPrisma(),
        buildConfig({ sessionSecret: "" }),
        mockDrift,
      );

      const result = await service.checkReadiness();
      const serialized = JSON.stringify(result);

      expect(findDependency(result, "configuration").reason).toContain(
        "sessionSecret",
      );
      // The other secrets are present and must not appear in output.
      expect(serialized).not.toContain("signing-secret");
      expect(serialized).not.toContain("hunter2");
    });
  });

  describe("caching", () => {
    it("serves a cached result within the TTL and marks it cached", async () => {
      const prisma = buildPrisma();
      const service = new HealthService(
        prisma,
        buildConfig({ "health.cacheTtlMs": 10_000 }),
        mockDrift,
      );

      await service.checkReadiness();
      const second = await service.checkReadiness();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

      const database = findDependency(second, "database");
      expect(database.cached).toBe(true);
      expect(typeof database.ageMs).toBe("number");
    });

    it("re-probes once the cached result is stale", async () => {
      const prisma = buildPrisma();
      const service = new HealthService(
        prisma,
        buildConfig({ "health.cacheTtlMs": 0 }),
        mockDrift,
      );

      await service.checkReadiness();
      await service.checkReadiness();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it("resetCache forces a fresh probe", async () => {
      const prisma = buildPrisma();
      const service = new HealthService(
        prisma,
        buildConfig({ "health.cacheTtlMs": 10_000 }),
        mockDrift,
      );

      await service.checkReadiness();
      service.resetCache();
      await service.checkReadiness();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });
  });

  describe("concurrent probes", () => {
    it("coalesces simultaneous callers onto a single probe", async () => {
      // Without single-flight, a slow dependency plus a high poll rate produces
      // exactly the overload the probe is supposed to detect.
      let resolveQuery: (value: unknown) => void = () => undefined;
      const gated = new Promise((resolve) => {
        resolveQuery = resolve;
      });

      const prisma = buildPrisma({
        $queryRaw: jest.fn().mockImplementation(() => gated),
      } as Partial<PrismaService>);

      const service = new HealthService(
        prisma,
        buildConfig({ "health.cacheTtlMs": 0 }),
        mockDrift,
      );

      const inFlight = Promise.all([
        service.checkReadiness(),
        service.checkReadiness(),
        service.checkReadiness(),
      ]);

      resolveQuery([{ "?column?": 1 }]);
      const results = await inFlight;

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      results.forEach((result) => expect(result.status).toBe("ready"));
    });
  });

  describe("dependency recovery", () => {
    it("returns to ready after a failing dependency recovers", async () => {
      const $queryRaw = jest
        .fn()
        .mockRejectedValueOnce(new Error("down"))
        .mockResolvedValue([{ "?column?": 1 }]);

      const service = new HealthService(
        buildPrisma({ $queryRaw } as Partial<PrismaService>),
        buildConfig({ "health.cacheTtlMs": 0 }),
        mockDrift,
      );

      await expect(service.checkReadiness()).resolves.toMatchObject({
        status: "not_ready",
      });
      await expect(service.checkReadiness()).resolves.toMatchObject({
        status: "ready",
      });
    });
  });

  describe("partial degradation", () => {
    it("stays ready when only an optional dependency is unhealthy", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 503 } as Response);
      global.fetch = fetchMock as unknown as typeof fetch;

      const service = new HealthService(buildPrisma(), buildConfig(), mockDrift);
      const result = await service.checkDiagnostics();

      expect(result.status).toBe("ready");
      expect(findDependency(result, "horizon").status).toBe(
        DependencyStatus.ERROR,
      );
      expect(findDependency(result, "horizon").reason).toBe(
        "upstream_status_503",
      );
    });

    it("marks a webhook backlog as degraded without exposing delivery data", async () => {
      const service = new HealthService(
        buildPrisma({
          webhookDelivery: { count: jest.fn().mockResolvedValue(4) },
        } as unknown as Partial<PrismaService>),
        buildConfig(),
        mockDrift,
      );

      const result = await service.checkDiagnostics();
      const webhooks = findDependency(result, "webhook_delivery");

      expect(webhooks.status).toBe(DependencyStatus.DEGRADED);
      expect(webhooks.reason).toBe("failed_deliveries_present");
      // No endpoint URLs, payloads, or organization identifiers.
      expect(JSON.stringify(webhooks)).not.toContain("http");
    });

    it("reports disabled anchoring without probing it", async () => {
      const service = new HealthService(
        buildPrisma(),
        buildConfig({ "contractAnchoring.enabled": false }),
        mockDrift,
      );

      const result = await service.checkDiagnostics();

      expect(findDependency(result, "contract_anchoring").status).toBe(
        DependencyStatus.DISABLED,
      );
    });

    it("distinguishes enabled-but-unconfigured anchoring", async () => {
      const service = new HealthService(
        buildPrisma(),
        buildConfig({
          "contractAnchoring.enabled": true,
          "contractAnchoring.proofRegistryContractId": "",
        }),
        mockDrift,
      );

      const result = await service.checkDiagnostics();
      const anchoring = findDependency(result, "contract_anchoring");

      expect(anchoring.status).toBe(DependencyStatus.NOT_CONFIGURED);
      expect(anchoring.reason).toBe("proof_registry_contract_id_absent");
    });

    it("reports horizon as not configured when no URL is set", async () => {
      const service = new HealthService(
        buildPrisma(),
        buildConfig({ "stellar.horizonUrl": "" }),
        mockDrift,
      );

      const result = await service.checkDiagnostics();

      expect(findDependency(result, "horizon").status).toBe(
        DependencyStatus.NOT_CONFIGURED,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // beginShutdown (earnproof-backend#68)
  // ---------------------------------------------------------------------------

  describe("beginShutdown", () => {
    it("makes checkReadiness report not_ready immediately, even with a healthy database", async () => {
      const prisma = buildPrisma();
      const service = new HealthService(prisma, buildConfig(), mockDrift);

      // Sanity check: ready before shutdown begins.
      expect((await service.checkReadiness()).status).toBe("ready");

      service.beginShutdown();
      const result = await service.checkReadiness();

      expect(result.status).toBe("not_ready");
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // only the pre-shutdown call
    });

    it("does not consult or extend the dependency cache while shutting down", async () => {
      const prisma = buildPrisma();
      const service = new HealthService(prisma, buildConfig(), mockDrift);
      await service.checkReadiness(); // warms the cache

      service.beginShutdown();
      await service.checkReadiness();
      await service.checkReadiness();

      // No additional probes after beginShutdown() — the not_ready answer is
      // synthesized without touching the database at all.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("is idempotent — calling it more than once is safe", () => {
      const service = new HealthService(buildPrisma(), buildConfig(), mockDrift);
      expect(() => {
        service.beginShutdown();
        service.beginShutdown();
      }).not.toThrow();
    });
  });

  describe("circuit breaker diagnostics", () => {
    it("reports NOT_CONFIGURED when no registry is wired", async () => {
      const service = new HealthService(buildPrisma(), buildConfig());
      const result = await service.checkDiagnostics();
      const circuits = findDependency(result, "circuit_breakers");
      expect(circuits.status).toBe(DependencyStatus.NOT_CONFIGURED);
      expect(circuits.reason).toBe("registry_absent");
    });

    it("reports OK with per-circuit detail when every circuit is closed", async () => {
      const registry = new CircuitBreakerRegistry();
      registry.getOrCreate({ name: "horizon:testnet" });
      const service = new HealthService(buildPrisma(), buildConfig(), registry);

      const result = await service.checkDiagnostics();
      const circuits = findDependency(result, "circuit_breakers");

      expect(circuits.status).toBe(DependencyStatus.OK);
      expect(circuits.circuits).toEqual([
        expect.objectContaining({ name: "horizon:testnet", state: "closed" }),
      ]);
    });

    it("reports DEGRADED and names the tripped circuits, never a payload", async () => {
      const registry = new CircuitBreakerRegistry();
      const breaker = registry.getOrCreate({
        name: "horizon:testnet",
        failureThreshold: 1,
        openDurationMs: 60_000,
      });
      await breaker
        .execute(() => Promise.reject(new Error("down")), () => "trip")
        .catch(() => undefined);

      const service = new HealthService(buildPrisma(), buildConfig(), registry);
      const result = await service.checkDiagnostics();
      const circuits = findDependency(result, "circuit_breakers");

      expect(circuits.status).toBe(DependencyStatus.DEGRADED);
      expect(circuits.reason).toBe("tripped:horizon:testnet");
      // Detail is counts and states only.
      expect(circuits.circuits?.[0]).toMatchObject({
        name: "horizon:testnet",
        state: "open",
        openCount: 1,
      });
    });
  });
});
