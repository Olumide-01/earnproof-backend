import { Test, TestingModule } from "@nestjs/testing";
import { ContractsController } from "./contracts.controller";
import { ContractSuccessorService } from "./contract-successor.service";
import {
  ContractSuccessorReadinessDto,
  ContractIdentity,
} from "./contracts.types";
import { Request } from "express";

/**
 * Test fixtures and helpers for contracts controller.
 */
describe("ContractsController", () => {
  let controller: ContractsController;
  let service: ContractSuccessorService;

  const defaultNetwork = "testnet";
  const defaultContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const defaultVersion = 1;

  const buildMockService = (overrides: Record<string, any> = {}) => {
    const defaults = {
      assessReadiness: jest.fn().mockResolvedValue({
        successor: {
          network: defaultNetwork,
          contractId: defaultContractId,
          expectedVersion: defaultVersion,
        },
        status: "ready",
        findings: [],
        overall: "none",
        cached: false,
        assessedAt: new Date().toISOString(),
        latestCheckpoint: null,
      }),
      canMigrate: jest.fn().mockResolvedValue(true),
      acknowledgeFinding: jest.fn().mockResolvedValue(undefined),
    };
    return { ...defaults, ...overrides };
  };

  const buildMockRequest = (overrides: Partial<Request> = {}): Request => {
    const defaults = {
      headers: {
        "x-actor-id": "actor-123",
      },
    };
    return { ...defaults, ...overrides } as unknown as Request;
  };

  beforeEach(async () => {
    const mockService = buildMockService();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ContractsController],
      providers: [
        {
          provide: ContractSuccessorService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<ContractsController>(ContractsController);
    service = module.get<ContractSuccessorService>(ContractSuccessorService);
  });

  describe("assessReadiness", () => {
    describe("scenario: successful assessment", () => {
      it("returns readiness assessment from service", async () => {
        const mockRequest = buildMockRequest();
        const readiness: ContractSuccessorReadinessDto = {
          successor: {
            network: defaultNetwork,
            contractId: defaultContractId,
            expectedVersion: defaultVersion,
          },
          status: "ready",
          findings: [],
          overall: "none",
          cached: false,
          assessedAt: new Date().toISOString(),
          latestCheckpoint: null,
        };

        jest.spyOn(service, "assessReadiness").mockResolvedValue(readiness);

        const result = await controller.assessReadiness(
          defaultNetwork,
          defaultContractId,
          mockRequest,
        );

        expect(result).toEqual(readiness);
        expect(service.assessReadiness).toHaveBeenCalledWith(
          expect.objectContaining({
            network: defaultNetwork,
            contractId: defaultContractId,
          }),
        );
      });
    });

    describe("scenario: not ready assessment", () => {
      it("returns not_ready status with findings", async () => {
        const mockRequest = buildMockRequest();
        const readiness: ContractSuccessorReadinessDto = {
          successor: {
            network: defaultNetwork,
            contractId: defaultContractId,
            expectedVersion: defaultVersion,
          },
          status: "not_ready",
          reason: "schema_version_mismatch",
          findings: [
            {
              key: "schema_version_mismatch",
              severity: "blocking",
              description: "Schema version mismatch",
              acknowledged: false,
            },
          ],
          overall: "blocking",
          cached: false,
          assessedAt: new Date().toISOString(),
          latestCheckpoint: null,
        };

        jest.spyOn(service, "assessReadiness").mockResolvedValue(readiness);

        const result = await controller.assessReadiness(
          defaultNetwork,
          defaultContractId,
          mockRequest,
        );

        expect(result.status).toBe("not_ready");
        expect(result.reason).toBeDefined();
        expect(result.findings.length).toBeGreaterThan(0);
      });
    });

    describe("scenario: cached assessment", () => {
      it("returns cached result when available", async () => {
        const mockRequest = buildMockRequest();
        const readiness: ContractSuccessorReadinessDto = {
          successor: {
            network: defaultNetwork,
            contractId: defaultContractId,
            expectedVersion: defaultVersion,
          },
          status: "ready",
          findings: [],
          overall: "none",
          cached: true,
          ageMs: 1234,
          assessedAt: new Date().toISOString(),
          latestCheckpoint: null,
        };

        jest.spyOn(service, "assessReadiness").mockResolvedValue(readiness);

        const result = await controller.assessReadiness(
          defaultNetwork,
          defaultContractId,
          mockRequest,
        );

        expect(result.cached).toBe(true);
        expect(result.ageMs).toBeDefined();
      });
    });
  });

  describe("acknowledgeFinding", () => {
    describe("scenario: successful acknowledgement", () => {
      it("records acknowledgement and returns confirmation", async () => {
        const mockRequest = buildMockRequest();

        jest
          .spyOn(service, "acknowledgeFinding")
          .mockResolvedValue(undefined);

        const result = await controller.acknowledgeFinding(
          defaultNetwork,
          defaultContractId,
          "schema_version_mismatch",
          {
            note: "Expected during upgrade",
            ttlSeconds: 86400,
          },
          mockRequest,
        );

        expect(result.findingKey).toBe("schema_version_mismatch");
        expect(result.acknowledgedAt).toBeDefined();
        expect(result.expiresAt).toBeDefined();
        expect(result.acknowledgedBy).toBeDefined();

        expect(service.acknowledgeFinding).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            findingKey: "schema_version_mismatch",
            note: "Expected during upgrade",
            ttlSeconds: 86400,
          }),
        );
      });
    });

    describe("scenario: invalid TTL rejected", () => {
      it("throws error for excessive TTL", async () => {
        const mockRequest = buildMockRequest();

        jest.spyOn(service, "acknowledgeFinding").mockRejectedValue(
          new Error("Acknowledgement TTL may not exceed"),
        );

        await expect(
          controller.acknowledgeFinding(
            defaultNetwork,
            defaultContractId,
            "schema_version_mismatch",
            {
              note: "Too long",
              ttlSeconds: 8 * 24 * 3600, // 8 days
            },
            mockRequest,
          ),
        ).rejects.toThrow();
      });
    });

    describe("scenario: service error", () => {
      it("propagates service errors", async () => {
        const mockRequest = buildMockRequest();

        jest
          .spyOn(service, "acknowledgeFinding")
          .mockRejectedValue(new Error("Database error"));

        await expect(
          controller.acknowledgeFinding(
            defaultNetwork,
            defaultContractId,
            "test_finding",
            {
              note: "test",
              ttlSeconds: 3600,
            },
            mockRequest,
          ),
        ).rejects.toThrow();
      });
    });
  });

  describe("canMigrate", () => {
    describe("scenario: can migrate", () => {
      it("returns true when migration is possible", async () => {
        const mockRequest = buildMockRequest();

        jest.spyOn(service, "canMigrate").mockResolvedValue(true);

        const result = await controller.canMigrate(
          defaultNetwork,
          defaultContractId,
          mockRequest,
        );

        expect(result.canMigrate).toBe(true);
        expect(service.canMigrate).toHaveBeenCalledWith(
          expect.objectContaining({
            network: defaultNetwork,
            contractId: defaultContractId,
          }),
        );
      });
    });

    describe("scenario: cannot migrate", () => {
      it("returns false when blocking findings exist", async () => {
        const mockRequest = buildMockRequest();

        jest.spyOn(service, "canMigrate").mockResolvedValue(false);

        const result = await controller.canMigrate(
          defaultNetwork,
          defaultContractId,
          mockRequest,
        );

        expect(result.canMigrate).toBe(false);
      });
    });

    describe("scenario: service failure", () => {
      it("handles service errors", async () => {
        const mockRequest = buildMockRequest();

        jest
          .spyOn(service, "canMigrate")
          .mockRejectedValue(new Error("Assessment timeout"));

        await expect(
          controller.canMigrate(
            defaultNetwork,
            defaultContractId,
            mockRequest,
          ),
        ).rejects.toThrow();
      });
    });
  });

  describe("route parameter handling", () => {
    describe("scenario: valid network and contract ID", () => {
      it("passes parameters correctly to service", async () => {
        const mockRequest = buildMockRequest();
        const network = "mainnet";
        const contractId = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4";

        jest.spyOn(service, "assessReadiness").mockResolvedValue({
          successor: { network, contractId, expectedVersion: 1 },
          status: "ready",
          findings: [],
          overall: "none",
          cached: false,
          assessedAt: new Date().toISOString(),
          latestCheckpoint: null,
        });

        await controller.assessReadiness(network, contractId, mockRequest);

        expect(service.assessReadiness).toHaveBeenCalledWith(
          expect.objectContaining({
            network,
            contractId,
          }),
        );
      });
    });
  });

  describe("request context extraction", () => {
    describe("scenario: actor ID extraction", () => {
      it("extracts actor ID from request headers", async () => {
        const actorId = "actor-xyz-123";
        const mockRequest = buildMockRequest({
          headers: { "x-actor-id": actorId },
        });

        jest
          .spyOn(service, "acknowledgeFinding")
          .mockResolvedValue(undefined);

        await controller.acknowledgeFinding(
          defaultNetwork,
          defaultContractId,
          "test_finding",
          {
            note: "test",
            ttlSeconds: 3600,
          },
          mockRequest,
        );

        expect(service.acknowledgeFinding).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            acknowledgedBy: actorId,
          }),
        );
      });
    });

    describe("scenario: missing actor ID", () => {
      it("uses default actor ID when header missing", async () => {
        const mockRequest = buildMockRequest({
          headers: {},
        });

        jest
          .spyOn(service, "acknowledgeFinding")
          .mockResolvedValue(undefined);

        await controller.acknowledgeFinding(
          defaultNetwork,
          defaultContractId,
          "test_finding",
          {
            note: "test",
            ttlSeconds: 3600,
          },
          mockRequest,
        );

        expect(service.acknowledgeFinding).toHaveBeenCalled();
      });
    });
  });

  describe("finding key parameter handling", () => {
    describe("scenario: acknowledgement with various finding keys", () => {
      it("passes finding key correctly to service", async () => {
        const mockRequest = buildMockRequest();
        const findingKey = "custom_finding_key";

        jest
          .spyOn(service, "acknowledgeFinding")
          .mockResolvedValue(undefined);

        const result = await controller.acknowledgeFinding(
          defaultNetwork,
          defaultContractId,
          findingKey,
          {
            note: "test",
            ttlSeconds: 3600,
          },
          mockRequest,
        );

        expect(result.findingKey).toBe(findingKey);
        expect(service.acknowledgeFinding).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            findingKey,
          }),
        );
      });
    });
  });
});
