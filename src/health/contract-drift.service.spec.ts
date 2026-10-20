import { ConfigService } from "@nestjs/config";
import { ContractDriftService } from "./contract-drift.service";

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const base: Record<string, unknown> = {
    "stellar.network": "testnet",
    "contractAnchoring.enabled": false,
    "contractAnchoring.proofRegistryContractId": "",
    "contractAnchoring.issuerAddress": "",
    "contractAnchoring.schemaVersion": 1,
    "health.cacheTtlMs": 0, // always re-check in tests
  };
  return {
    get: jest.fn((key: string) => ({ ...base, ...overrides }[key]),),
  } as unknown as ConfigService;
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    contractDriftAcknowledgement: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    ...overrides,
  };
}

function makeService(configOverrides = {}, prismaOverrides = {}) {
  return new ContractDriftService(
    buildConfig(configOverrides) as ConfigService,
    buildPrisma(prismaOverrides) as never,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ContractDriftService", () => {

  // ── Clean state ──────────────────────────────────────────────────────────

  describe("when anchoring is disabled", () => {
    it("returns overall=none with no items", async () => {
      const service = makeService({ "contractAnchoring.enabled": false });
      const status = await service.checkDrift();
      expect(status.overall).toBe("none");
      expect(status.items).toHaveLength(0);
    });

    it("sets lastCheckedAt to a valid ISO string", async () => {
      const service = makeService();
      const status = await service.checkDrift();
      expect(new Date(status.lastCheckedAt!).toISOString()).toBe(status.lastCheckedAt);
    });

    it("cached=false on first call", async () => {
      const service = makeService();
      const status = await service.checkDrift();
      expect(status.cached).toBe(false);
    });
  });

  // ── Config-level blocking drift ──────────────────────────────────────────

  describe("blocking drift — missing configuration", () => {
    it("reports contract_id_absent as blocking when anchoring enabled but no contract ID", async () => {
      const service = makeService({
        "contractAnchoring.enabled": true,
        "contractAnchoring.proofRegistryContractId": undefined,
        "contractAnchoring.issuerAddress": "GABCDE...",
      });
      const status = await service.checkDrift();
      const item = status.items.find((i) => i.key === "contract_id_absent");
      expect(item).toBeDefined();
      expect(item!.severity).toBe("blocking");
      expect(status.overall).toBe("blocking");
    });

    it("reports issuer_address_absent as blocking when anchoring enabled but no issuer", async () => {
      const service = makeService({
        "contractAnchoring.enabled": true,
        "contractAnchoring.proofRegistryContractId": "CTEST1234",
        "contractAnchoring.issuerAddress": undefined,
      });
      const status = await service.checkDrift();
      const item = status.items.find((i) => i.key === "issuer_address_absent");
      expect(item).toBeDefined();
      expect(item!.severity).toBe("blocking");
    });

    it("reports schema_version_invalid as blocking when version < 1", async () => {
      const service = makeService({
        "contractAnchoring.enabled": true,
        "contractAnchoring.proofRegistryContractId": "CTEST1234",
        "contractAnchoring.issuerAddress": "GABCDE...",
        "contractAnchoring.schemaVersion": 0,
      });
      const status = await service.checkDrift();
      const item = status.items.find((i) => i.key === "schema_version_invalid");
      expect(item).toBeDefined();
      expect(item!.severity).toBe("blocking");
    });

    it("isBlocked returns true when there is unacknowledged blocking drift", async () => {
      const service = makeService({
        "contractAnchoring.enabled": true,
        "contractAnchoring.proofRegistryContractId": undefined,
      });
      await expect(service.isBlocked()).resolves.toBe(true);
    });

    it("isBlocked returns false when anchoring is disabled", async () => {
      const service = makeService({ "contractAnchoring.enabled": false });
      await expect(service.isBlocked()).resolves.toBe(false);
    });
  });

  // ── Degraded drift ───────────────────────────────────────────────────────

  describe("degraded drift", () => {
    it("reports network_unrecognised as degraded for unknown network names", async () => {
      const service = makeService({
        "contractAnchoring.enabled": true,
        "contractAnchoring.proofRegistryContractId": "CTEST1234",
        "contractAnchoring.issuerAddress": "GABCDE...",
        "stellar.network": "localnet",
      });
      const status = await service.checkDrift();
      const item = status.items.find((i) => i.key === "network_unrecognised");
      expect(item).toBeDefined();
      expect(item!.severity).toBe("degraded");
    });

    it("overall is degraded when highest unacknowledged severity is degraded", async () => {
      const service = makeService({
        "contractAnchoring.enabled": true,
        "contractAnchoring.proofRegistryContractId": "CTEST1234",
        "contractAnchoring.issuerAddress": "GABCDE...",
        "stellar.network": "unknownnet",
      });
      const status = await service.checkDrift();
      expect(status.overall).toBe("degraded");
    });
  });

  // ── Acknowledgement ──────────────────────────────────────────────────────

  describe("acknowledgement", () => {
    it("acknowledged items are excluded from overall severity", async () => {
      const prisma = buildPrisma({
        contractDriftAcknowledgement: {
          findMany: jest.fn().mockResolvedValue([
            { driftKey: "contract_id_absent" },
          ]),
          create: jest.fn(),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      });
      const service = new ContractDriftService(
        buildConfig({
          "contractAnchoring.enabled": true,
          "contractAnchoring.proofRegistryContractId": undefined,
          "contractAnchoring.issuerAddress": "GABCDE...",
        }) as ConfigService,
        prisma as never,
      );
      const status = await service.checkDrift();
      const item = status.items.find((i) => i.key === "contract_id_absent");
      expect(item!.acknowledged).toBe(true);
      // overall excludes acknowledged items
      expect(status.overall).toBe("none");
    });

    it("isBlocked returns false when all blocking items are acknowledged", async () => {
      const prisma = buildPrisma({
        contractDriftAcknowledgement: {
          findMany: jest.fn().mockResolvedValue([
            { driftKey: "contract_id_absent" },
            { driftKey: "issuer_address_absent" },
          ]),
          create: jest.fn(),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      });
      const service = new ContractDriftService(
        buildConfig({
          "contractAnchoring.enabled": true,
          "contractAnchoring.proofRegistryContractId": undefined,
          "contractAnchoring.issuerAddress": undefined,
        }) as ConfigService,
        prisma as never,
      );
      await expect(service.isBlocked()).resolves.toBe(false);
    });

    it("acknowledge() creates a row with correct expiresAt", async () => {
      const createMock = jest.fn().mockResolvedValue({});
      const prisma = buildPrisma({
        contractDriftAcknowledgement: {
          findMany: jest.fn().mockResolvedValue([]),
          create: createMock,
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      });
      const service = new ContractDriftService(buildConfig() as ConfigService, prisma as never);
      const before = Date.now();
      await service.acknowledge({
        driftKey: "schema_version_mismatch",
        acknowledgedBy: "operator-1",
        note: "Planned schema upgrade",
        ttlSeconds: 3600,
      });
      const call = createMock.mock.calls[0][0] as { data: { expiresAt: Date } };
      const expiry = call.data.expiresAt.getTime();
      expect(expiry).toBeGreaterThanOrEqual(before + 3600 * 1000 - 100);
      expect(expiry).toBeLessThanOrEqual(before + 3600 * 1000 + 1000);
    });

    it("acknowledge() rejects TTL exceeding 7 days", async () => {
      const service = makeService();
      await expect(
        service.acknowledge({
          driftKey: "x",
          acknowledgedBy: "op",
          note: "test",
          ttlSeconds: 7 * 24 * 3600 + 1,
        }),
      ).rejects.toThrow("7 days");
    });

    it("acknowledge() rejects zero or negative TTL", async () => {
      const service = makeService();
      await expect(
        service.acknowledge({ driftKey: "x", acknowledgedBy: "op", note: "n", ttlSeconds: 0 }),
      ).rejects.toThrow();
    });

    it("acknowledge() invalidates the in-memory cache", async () => {
      const prisma = buildPrisma();
      const service = new ContractDriftService(
        buildConfig({ "health.cacheTtlMs": 100_000 }) as ConfigService,
        prisma as never,
      );
      await service.checkDrift(); // warm cache
      await service.acknowledge({ driftKey: "x", acknowledgedBy: "op", note: "n", ttlSeconds: 60 });
      // After acknowledge the cache is reset, so checkDrift calls the DB again
      (prisma.contractDriftAcknowledgement.findMany as jest.Mock).mockResolvedValueOnce([{ driftKey: "x" }]);
      const status = await service.checkDrift();
      expect(status.cached).toBe(false);
    });
  });

  // ── Caching ──────────────────────────────────────────────────────────────

  describe("caching", () => {
    it("serves cached result within TTL and marks cached=true", async () => {
      const service = new ContractDriftService(
        buildConfig({ "health.cacheTtlMs": 100_000 }) as ConfigService,
        buildPrisma() as never,
      );
      await service.checkDrift();
      const second = await service.checkDrift();
      expect(second.cached).toBe(true);
    });

    it("re-checks after resetCache()", async () => {
      const prisma = buildPrisma();
      const service = new ContractDriftService(
        buildConfig({ "health.cacheTtlMs": 100_000 }) as ConfigService,
        prisma as never,
      );
      const first = await service.checkDrift();
      expect(first.cached).toBe(false);
      service.resetCache();
      const second = await service.checkDrift();
      // After resetCache(), the next call must not be served from cache
      expect(second.cached).toBe(false);
    });
  });

  // ── Recovery ─────────────────────────────────────────────────────────────

  describe("recovery", () => {
    it("returns overall=none after a previously drifted config is corrected", async () => {
      // First call: anchoring enabled, no contract ID → blocking
      const configMock = jest.fn();
      const anchEnabled = true;
      let contractId: string | undefined = undefined;
      configMock.mockImplementation((key: string) => {
        const map: Record<string, unknown> = {
          "contractAnchoring.enabled": anchEnabled,
          "contractAnchoring.proofRegistryContractId": contractId,
          "contractAnchoring.issuerAddress": "GABCDE...",
          "contractAnchoring.schemaVersion": 1,
          "stellar.network": "testnet",
          "health.cacheTtlMs": 0,
        };
        return map[key];
      });
      const service = new ContractDriftService(
        { get: configMock } as unknown as ConfigService,
        buildPrisma() as never,
      );
      const s1 = await service.checkDrift();
      expect(s1.overall).toBe("blocking");

      // "Fix" the config
      contractId = "CTEST12345678";
      const s2 = await service.checkDrift();
      expect(s2.overall).toBe("none");
    });
  });

  // ── Outage resilience ────────────────────────────────────────────────────

  describe("outage resilience", () => {
    it("does not throw when acknowledgement DB query fails — returns items without ack info", async () => {
      const prisma = buildPrisma({
        contractDriftAcknowledgement: {
          findMany: jest.fn().mockRejectedValue(new Error("DB down")),
          create: jest.fn(),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      });
      const service = new ContractDriftService(
        buildConfig({
          "contractAnchoring.enabled": true,
          "contractAnchoring.proofRegistryContractId": undefined,
        }) as ConfigService,
        prisma as never,
      );
      // Should resolve, not reject
      await expect(service.checkDrift()).resolves.toBeDefined();
    });
  });

  // ── purgeExpiredAcknowledgements ─────────────────────────────────────────

  describe("purgeExpiredAcknowledgements", () => {
    it("calls deleteMany with expiresAt < now and returns count", async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 4 });
      const prisma = buildPrisma({
        contractDriftAcknowledgement: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
          deleteMany,
        },
      });
      const service = new ContractDriftService(buildConfig() as ConfigService, prisma as never);
      const count = await service.purgeExpiredAcknowledgements();
      expect(count).toBe(4);
      expect(deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { expiresAt: { lt: expect.any(Date) } } }),
      );
    });
  });

  // ── Privacy invariants ───────────────────────────────────────────────────

  describe("privacy invariants", () => {
    it("drift descriptions never contain raw secret values", async () => {
      const service = makeService({
        "contractAnchoring.enabled": true,
        "contractAnchoring.proofRegistryContractId": undefined,
      });
      const status = await service.checkDrift();
      const serialized = JSON.stringify(status);
      // Descriptions must not echo config values (they could be secrets)
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("sk_live_");
    });

    it("drift items are safe reason codes, not raw driver errors", async () => {
      const service = makeService({
        "contractAnchoring.enabled": true,
        "contractAnchoring.proofRegistryContractId": undefined,
      });
      const status = await service.checkDrift();
      for (const item of status.items) {
        // Keys must be snake_case identifiers, not error messages
        expect(item.key).toMatch(/^[a-z_]+$/);
      }
    });
  });
});