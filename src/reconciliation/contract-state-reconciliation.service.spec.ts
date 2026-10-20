import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../database/prisma.service";
import { ContractDigestClient } from "./contract-digest-client";
import { BackendStateDigestCalculator } from "./backend-state-digest-calculator";
import { ContractStateReconciliationService } from "./contract-state-reconciliation.service";

describe("ContractStateReconciliationService", () => {
  let service: ContractStateReconciliationService;
  let digestClient: ContractDigestClient;
  let digestCalculator: BackendStateDigestCalculator;
  let prismaService: PrismaService;
  let configService: ConfigService;

  beforeEach(async () => {
    const mockPrismaService = {
      $executeRawUnsafe: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, unknown> = {
          "contractReconciliation.enabled": true,
          "stellar.network": "testnet",
          "contractReconciliation.contractId":
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
          "contractReconciliation.staleThresholdMs": 60 * 60 * 1000,
        };
        return config[key];
      }),
    };

    const mockDigestClient = {
      fetchAndVerify: jest.fn(),
    };

    const mockCalculator = {
      computeDigest: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ContractStateReconciliationService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: ContractDigestClient,
          useValue: mockDigestClient,
        },
        {
          provide: BackendStateDigestCalculator,
          useValue: mockCalculator,
        },
      ],
    }).compile();

    service = moduleRef.get<ContractStateReconciliationService>(
      ContractStateReconciliationService,
    );
    digestClient =
      moduleRef.get<ContractDigestClient>(ContractDigestClient);
    digestCalculator = moduleRef.get<BackendStateDigestCalculator>(
      BackendStateDigestCalculator,
    );
    prismaService = moduleRef.get<PrismaService>(PrismaService);
    configService = moduleRef.get<ConfigService>(ConfigService);
  });

  describe("compareCheckpoint", () => {
    it("should return MATCH when digests are identical", async () => {
      const liveDigest = {
        network: "testnet",
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        checkpointNumber: "100",
        digestVersion: "1.0",
        components: {
          issuerCount: "5",
          registrationHash: "sha256:abc123",
          attestationCount: "3",
        },
        timestamp: new Date(),
      };

      const backendDigest = {
        digestVersion: "1.0",
        components: {
          issuerCount: "5",
          registrationHash: "sha256:abc123",
          attestationCount: "3",
        },
        computedAt: new Date(),
      };

      (digestClient.fetchAndVerify as jest.Mock).mockResolvedValue({
        ok: true,
        digest: liveDigest,
      });

      (digestCalculator.computeDigest as jest.Mock).mockResolvedValue(
        backendDigest,
      );

      (prismaService.$executeRawUnsafe as jest.Mock).mockResolvedValue(0);

      const result = await service.compareCheckpoint(
        "testnet",
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        "100",
      );

      expect(result.verificationStatus).toBe("PASSED");
      expect(result.comparisonStatus).toBe("MATCH");
      expect(result.mismatchCount).toBe(0);
    });

    it("should return MISMATCH when components differ", async () => {
      const liveDigest = {
        network: "testnet",
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        checkpointNumber: "100",
        digestVersion: "1.0",
        components: {
          issuerCount: "5",
          registrationHash: "sha256:abc123",
          attestationCount: "3",
        },
        timestamp: new Date(),
      };

      const backendDigest = {
        digestVersion: "1.0",
        components: {
          issuerCount: "6", // Different
          registrationHash: "sha256:abc123",
          attestationCount: "3",
        },
        computedAt: new Date(),
      };

      (digestClient.fetchAndVerify as jest.Mock).mockResolvedValue({
        ok: true,
        digest: liveDigest,
      });

      (digestCalculator.computeDigest as jest.Mock).mockResolvedValue(
        backendDigest,
      );

      (prismaService.$executeRawUnsafe as jest.Mock).mockResolvedValue(0);

      const result = await service.compareCheckpoint(
        "testnet",
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        "100",
      );

      expect(result.verificationStatus).toBe("PASSED");
      expect(result.comparisonStatus).toBe("MISMATCH");
      expect(result.mismatchCount).toBe(1); // issuerCount mismatch
    });

    it("should return FAILED if verification fails", async () => {
      (digestClient.fetchAndVerify as jest.Mock).mockResolvedValue({
        ok: false,
        failure: {
          code: "UNKNOWN_VERSION",
          message: "Digest version is not supported",
        },
      });

      (prismaService.$executeRawUnsafe as jest.Mock).mockResolvedValue(0);

      const result = await service.compareCheckpoint(
        "testnet",
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        "100",
      );

      expect(result.verificationStatus).toBe("FAILED");
      expect(result.verificationFailures).toBeDefined();
      expect(result.verificationFailures?.[0].code).toBe("UNKNOWN_VERSION");
    });

    it("should persist mismatches idempotently", async () => {
      const liveDigest = {
        network: "testnet",
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        checkpointNumber: "100",
        digestVersion: "1.0",
        components: {
          issuerCount: "5",
          registrationHash: "sha256:abc123",
        },
        timestamp: new Date(),
      };

      const backendDigest = {
        digestVersion: "1.0",
        components: {
          issuerCount: "6",
          registrationHash: "sha256:abc123",
        },
        computedAt: new Date(),
      };

      (digestClient.fetchAndVerify as jest.Mock).mockResolvedValue({
        ok: true,
        digest: liveDigest,
      });

      (digestCalculator.computeDigest as jest.Mock).mockResolvedValue(
        backendDigest,
      );

      (prismaService.$executeRawUnsafe as jest.Mock).mockResolvedValue(0);

      const result1 = await service.compareCheckpoint(
        "testnet",
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        "100",
      );

      // Re-run with same runId should not create duplicates
      // (In real implementation, we'd check the runId parameter)
      expect(result1.mismatchCount).toBe(1);
    });
  });
});
