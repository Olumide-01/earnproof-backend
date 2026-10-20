import { Test } from "@nestjs/testing";
import { PrismaService } from "../database/prisma.service";
import { BackendStateDigestCalculator } from "./backend-state-digest-calculator";

describe("BackendStateDigestCalculator", () => {
  let calculator: BackendStateDigestCalculator;
  let prismaService: PrismaService;

  beforeEach(async () => {
    const mockPrismaService = {
      issuer: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
      attestation: {
        count: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BackendStateDigestCalculator,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    calculator =
      moduleRef.get<BackendStateDigestCalculator>(
        BackendStateDigestCalculator,
      );
    prismaService = moduleRef.get<PrismaService>(PrismaService);
  });

  describe("computeDigest", () => {
    it("should compute digest with all components", async () => {
      // Mock database queries
      (prismaService.issuer.count as jest.Mock).mockResolvedValue(5);
      (prismaService.issuer.findMany as jest.Mock).mockResolvedValue([]);
      (prismaService.attestation.count as jest.Mock).mockResolvedValue(3);

      const digest = await calculator.computeDigest("testnet", "100");

      expect(digest.digestVersion).toBe("1.0");
      expect(digest.components.issuerCount).toBe("5");
      expect(digest.components.registrationHash).toContain("sha256:");
      expect(digest.components.attestationCount).toBe("3");
    });

    it("should produce deterministic registration hash", async () => {
      const issuers = [
        {
          id: "issuer_1",
          organizationId: "org_1",
          stellarAddress: "GAAA",
        },
        {
          id: "issuer_2",
          organizationId: "org_2",
          stellarAddress: "GBBB",
        },
      ];

      (prismaService.issuer.count as jest.Mock).mockResolvedValue(2);
      (prismaService.issuer.findMany as jest.Mock).mockResolvedValue(issuers);
      (prismaService.attestation.count as jest.Mock).mockResolvedValue(0);

      const digest1 = await calculator.computeDigest("testnet", "100");
      const digest2 = await calculator.computeDigest("testnet", "100");

      // Same input should produce same hash (deterministic)
      expect(digest1.components.registrationHash).toBe(
        digest2.components.registrationHash,
      );
    });

    it("should produce different hash for different issuer set", async () => {
      (prismaService.issuer.count as jest.Mock)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3);
      (prismaService.issuer.findMany as jest.Mock)
        .mockResolvedValueOnce([
          {
            id: "issuer_1",
            organizationId: "org_1",
            stellarAddress: "GAAA",
          },
        ])
        .mockResolvedValueOnce([
          {
            id: "issuer_1",
            organizationId: "org_1",
            stellarAddress: "GAAA",
          },
          {
            id: "issuer_2",
            organizationId: "org_2",
            stellarAddress: "GBBB",
          },
        ]);
      (prismaService.attestation.count as jest.Mock)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const digest1 = await calculator.computeDigest("testnet", "100");
      const digest2 = await calculator.computeDigest("testnet", "100");

      // Different issuers should produce different hashes
      expect(digest1.components.registrationHash).not.toBe(
        digest2.components.registrationHash,
      );
    });
  });
});
