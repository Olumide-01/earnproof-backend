import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../database/prisma.service";
import { ContractSuccessorService } from "./contract-successor.service";
import {
  ContractIdentity,
  SuccessorReadinessStatusCode,
} from "./contracts.types";

/**
 * Test fixtures and helpers for contract successor readiness assessment.
 */
describe("ContractSuccessorService", () => {
  let service: ContractSuccessorService;
  let configService: ConfigService;
  let prisma: PrismaService;

  const defaultNetwork = "testnet";
  const defaultContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const defaultVersion = 1;

  const buildMockConfig = (overrides: Record<string, any> = {}) => {
    const defaults = {
      "stellar.network": defaultNetwork,
      "contractAnchoring.proofRegistryContractId": defaultContractId,
      "contractAnchoring.schemaVersion": defaultVersion,
      "contractAnchoring.enabled": true,
      "health.cacheTtlMs": 0, // Disable caching in tests
    };
    return { ...defaults, ...overrides };
  };

  const buildMockConfigService = (config: Record<string, any>) => {
    return {
      get: jest.fn((key: string) => config[key]),
    } as unknown as ConfigService;
  };

  const buildMockPrisma = (overrides: Record<string, any> = {}) => {
    const defaults = {
      protocolPauseState: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      contractSuccessorFindingAcknowledgement: {
        create: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    return { ...defaults, ...overrides } as unknown as PrismaService;
  };

  const makeService = (configOverrides = {}, prismaOverrides = {}) => {
    const config = buildMockConfigService(buildMockConfig(configOverrides));
    const prismaInstance = buildMockPrisma(prismaOverrides);
    return new ContractSuccessorService(config, prismaInstance);
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("assessReadiness", () => {
    describe("scenario: all checks pass", () => {
      it("returns ready status with no findings", async () => {
        service = makeService();
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const result = await service.assessReadiness(successor);

        expect(result.status).toBe("ready");
        expect(result.overall).toBe("none");
        expect(result.findings).toBeDefined();
        expect(result.assessedAt).toBeDefined();
        expect(result.cached).toBe(false);
      });

      it("includes informational findings when all checks pass", async () => {
        service = makeService();
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const result = await service.assessReadiness(successor);

        const informationalFindings = result.findings.filter(
          (f) => f.severity === "informational",
        );
        expect(informationalFindings.length).toBeGreaterThan(0);
      });
    });

    describe("scenario: network mismatch", () => {
      it("returns not_ready with blocking finding", async () => {
        service = makeService({ "stellar.network": "mainnet" });
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const result = await service.assessReadiness(successor);

        expect(result.status).toBe("not_ready");
        expect(result.overall).toBe("blocking");
        const blocking = result.findings.find(
          (f) => f.key === SuccessorReadinessStatusCode.IDENTITY_MISMATCH,
        );
        expect(blocking).toBeDefined();
        expect(blocking?.severity).toBe("blocking");
      });
    });

    describe("scenario: contract ID mismatch", () => {
      it("returns not_ready when configured ID differs", async () => {
        service = makeService({
          "contractAnchoring.proofRegistryContractId":
            "CDIFFERENT00000000000000000000000000000000000000000000000",
        });
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const result = await service.assessReadiness(successor);

        expect(result.status).toBe("not_ready");
        const mismatch = result.findings.find(
          (f) => f.key === SuccessorReadinessStatusCode.IDENTITY_MISMATCH,
        );
        expect(mismatch).toBeDefined();
      });
    });

    describe("scenario: schema version mismatch", () => {
      it("returns blocking finding when version differs", async () => {
        service = makeService({ "contractAnchoring.schemaVersion": 2 });
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: 1,
        };

        const result = await service.assessReadiness(successor);

        expect(result.status).toBe("not_ready");
        const schemaMismatch = result.findings.find(
          (f) =>
            f.key ===
            SuccessorReadinessStatusCode.SCHEMA_VERSION_MISMATCH,
        );
        expect(schemaMismatch).toBeDefined();
        expect(schemaMismatch?.severity).toBe("blocking");
      });
    });

    describe("scenario: successor paused", () => {
      it("returns blocking finding when successor is paused", async () => {
        const prismaOverrides = {
          protocolPauseState: {
            findUnique: jest.fn().mockResolvedValue({
              network: defaultNetwork,
              contractId: defaultContractId,
              isPaused: true,
            }),
          },
        };
        service = makeService({}, prismaOverrides);
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const result = await service.assessReadiness(successor);

        expect(result.status).toBe("not_ready");
        const pausedFinding = result.findings.find(
          (f) => f.key === SuccessorReadinessStatusCode.SUCCESSOR_PAUSED,
        );
        expect(pausedFinding).toBeDefined();
        expect(pausedFinding?.severity).toBe("blocking");
      });
    });

    describe("scenario: pause state not found", () => {
      it("returns advisory finding and remains ready", async () => {
        const prismaOverrides = {
          protocolPauseState: {
            findUnique: jest.fn().mockResolvedValue(null),
          },
        };
        service = makeService({}, prismaOverrides);
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const result = await service.assessReadiness(successor);

        expect(result.status).toBe("ready");
        const notFoundFinding = result.findings.find(
          (f) => f.key === "pause_state_not_found",
        );
        expect(notFoundFinding?.severity).toBe("advisory");
      });
    });

    describe("scenario: caching", () => {
      it("returns cached result when fresh", async () => {
        service = makeService({ "health.cacheTtlMs": 5000 });
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const first = await service.assessReadiness(successor);
        expect(first.cached).toBe(false);

        const second = await service.assessReadiness(successor);
        expect(second.cached).toBe(true);
        expect(second.ageMs).toBeGreaterThanOrEqual(0);
      });

      it("resets cache when reset is called", async () => {
        service = makeService({ "health.cacheTtlMs": 5000 });
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const first = await service.assessReadiness(successor);
        expect(first.cached).toBe(false);

        service.resetCache();

        const third = await service.assessReadiness(successor);
        expect(third.cached).toBe(false);
      });
    });
  });

  describe("acknowledgeFinding", () => {
    describe("scenario: valid acknowledgement", () => {
      it("stores acknowledgement in database", async () => {
        const prismaOverrides = {
          protocolPauseState: {
            findUnique: jest.fn().mockResolvedValue(null),
          },
          contractSuccessorFindingAcknowledgement: {
            create: jest.fn().mockResolvedValue(null),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
            findMany: jest.fn().mockResolvedValue([]),
          },
        };
        service = makeService({}, prismaOverrides);
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        await service.acknowledgeFinding(successor, {
          findingKey: SuccessorReadinessStatusCode.SCHEMA_VERSION_MISMATCH,
          acknowledgedBy: "actor-123",
          note: "Expected during upgrade",
          ttlSeconds: 86400,
        });

        expect(prismaOverrides.contractSuccessorFindingAcknowledgement.create).toHaveBeenCalled();
      });
    });

    describe("scenario: TTL exceeds maximum", () => {
      it("throws error when TTL exceeds 7 days", async () => {
        service = makeService();
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const eightDaysSeconds = 8 * 24 * 3600;
        await expect(
          service.acknowledgeFinding(successor, {
            findingKey: "test_finding",
            acknowledgedBy: "actor-123",
            note: "Too long",
            ttlSeconds: eightDaysSeconds,
          }),
        ).rejects.toThrow();
      });
    });

    describe("scenario: invalid TTL", () => {
      it("throws error when TTL is zero", async () => {
        service = makeService();
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        await expect(
          service.acknowledgeFinding(successor, {
            findingKey: "test_finding",
            acknowledgedBy: "actor-123",
            note: "Invalid",
            ttlSeconds: 0,
          }),
        ).rejects.toThrow();
      });

      it("throws error when TTL is negative", async () => {
        service = makeService();
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        await expect(
          service.acknowledgeFinding(successor, {
            findingKey: "test_finding",
            acknowledgedBy: "actor-123",
            note: "Invalid",
            ttlSeconds: -1,
          }),
        ).rejects.toThrow();
      });
    });

    describe("scenario: invalidates cache", () => {
      it("clears cache after acknowledgement", async () => {
        const prismaOverrides = {
          protocolPauseState: {
            findUnique: jest.fn().mockResolvedValue(null),
          },
          contractSuccessorFindingAcknowledgement: {
            create: jest.fn().mockResolvedValue(null),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
            findMany: jest.fn().mockResolvedValue([]),
          },
        };
        service = makeService({ "health.cacheTtlMs": 5000 }, prismaOverrides);
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        // Populate cache
        const first = await service.assessReadiness(successor);
        expect(first.cached).toBe(false);

        // Acknowledge finding (should invalidate cache)
        await service.acknowledgeFinding(successor, {
          findingKey: "test_finding",
          acknowledgedBy: "actor-123",
          note: "test",
          ttlSeconds: 3600,
        });

        // Next assessment should be fresh
        const second = await service.assessReadiness(successor);
        expect(second.cached).toBe(false);
      });
    });
  });

  describe("purgeExpiredAcknowledgements", () => {
    describe("scenario: valid purge", () => {
      it("deletes expired acknowledgements", async () => {
        const prismaOverrides = {
          contractSuccessorFindingAcknowledgement: {
            deleteMany: jest.fn().mockResolvedValue({ count: 5 }),
          },
        };
        service = makeService({}, prismaOverrides);

        const count = await service.purgeExpiredAcknowledgements();

        expect(count).toBe(5);
        expect(
          prismaOverrides.contractSuccessorFindingAcknowledgement.deleteMany,
        ).toHaveBeenCalledWith({
          where: { expiresAt: { lt: expect.any(Date) } },
        });
      });
    });

    describe("scenario: no expired acknowledgements", () => {
      it("returns zero count", async () => {
        const prismaOverrides = {
          contractSuccessorFindingAcknowledgement: {
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
        };
        service = makeService({}, prismaOverrides);

        const count = await service.purgeExpiredAcknowledgements();

        expect(count).toBe(0);
      });
    });
  });

  describe("canMigrate", () => {
    describe("scenario: ready to migrate", () => {
      it("returns true when all checks pass", async () => {
        service = makeService();
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const result = await service.canMigrate(successor);

        expect(result).toBe(true);
      });
    });

    describe("scenario: not ready to migrate", () => {
      it("returns false when blocking findings exist", async () => {
        service = makeService({ "stellar.network": "mainnet" });
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const result = await service.canMigrate(successor);

        expect(result).toBe(false);
      });
    });
  });

  describe("error handling and edge cases", () => {
    describe("scenario: database error on acknowledgement", () => {
      it("handles database errors gracefully", async () => {
        const prismaOverrides = {
          protocolPauseState: {
            findUnique: jest.fn().mockResolvedValue(null),
          },
          contractSuccessorFindingAcknowledgement: {
            create: jest
              .fn()
              .mockRejectedValue(new Error("Database connection failed")),
          },
        };
        service = makeService({}, prismaOverrides);
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        await expect(
          service.acknowledgeFinding(successor, {
            findingKey: "test",
            acknowledgedBy: "actor",
            note: "test",
            ttlSeconds: 3600,
          }),
        ).rejects.toThrow();
      });
    });

    describe("scenario: pause state check fails", () => {
      it("returns advisory finding on error", async () => {
        const prismaOverrides = {
          protocolPauseState: {
            findUnique: jest
              .fn()
              .mockRejectedValue(new Error("Network error")),
          },
        };
        service = makeService({}, prismaOverrides);
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        };

        const result = await service.assessReadiness(successor);

        const errorFinding = result.findings.find(
          (f) =>
            f.key ===
            SuccessorReadinessStatusCode.PAUSE_STATE_INCOMPATIBLE,
        );
        expect(errorFinding?.severity).toBe("advisory");
      });
    });

    describe("scenario: multiple blocking findings", () => {
      it("marks overall as blocking", async () => {
        service = makeService({
          "stellar.network": "mainnet",
          "contractAnchoring.schemaVersion": 2,
        });
        const successor: ContractIdentity = {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: 1,
        };

        const result = await service.assessReadiness(successor);

        expect(result.overall).toBe("blocking");
        const blockingCount = result.findings.filter(
          (f) => f.severity === "blocking",
        ).length;
        expect(blockingCount).toBeGreaterThan(1);
      });
    });
  });

  describe("concurrency and state isolation", () => {
    describe("scenario: concurrent assessments", () => {
      it("handles concurrent readiness checks", async () => {
        service = makeService();
        const successor1: ContractIdentity = {
          network: "testnet",
          contractId: defaultContractId,
          expectedVersion: 1,
        };
        const successor2: ContractIdentity = {
          network: "mainnet",
          contractId: defaultContractId,
          expectedVersion: 1,
        };

        const results = await Promise.all([
          service.assessReadiness(successor1),
          service.assessReadiness(successor2),
        ]);

        expect(results).toHaveLength(2);
        expect(results[0]).toBeDefined();
        expect(results[1]).toBeDefined();
      });
    });
  });
});
