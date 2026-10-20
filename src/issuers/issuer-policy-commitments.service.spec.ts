import { NotFoundException, ForbiddenException } from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../database/prisma.service";
import {
  IssuerPolicyCommitmentsService,
  IssuerPolicySnapshotInput,
} from "./issuer-policy-commitments.service";

describe("IssuerPolicyCommitmentsService", () => {
  let service: IssuerPolicyCommitmentsService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssuerPolicyCommitmentsService,
        {
          provide: PrismaService,
          useValue: {
            issuerPolicyCommitment: {
              create: jest.fn(),
              findUnique: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              updateMany: jest.fn(),
            },
            issuer: {
              findUnique: jest.fn(),
            },
            $transaction: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<IssuerPolicyCommitmentsService>(
      IssuerPolicyCommitmentsService,
    );
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe("captureOrReuse", () => {
    it("should return existing commitment if hashes match", async () => {
      const issuerId = "issuer-1";
      const policySnapshot: IssuerPolicySnapshotInput = {
        signingKeyVersionId: "key-1",
        stellarAddress: "GTEST",
        publicMetadata: { name: "Test" },
        status: ResourceStatus.ACTIVE,
      };

      const existingCommitment = {
        id: "commitment-1",
        issuerId,
        version: 1,
        commitment: "sha256:abc123",
        policyInputsHash: "sha256:def456",
        policySnapshot,
        effectiveAt: new Date(),
        supersededAt: null,
        correlationId: null,
        createdAt: new Date(),
      };

      (prisma.issuerPolicyCommitment.findFirst as jest.Mock).mockResolvedValue(
        existingCommitment,
      );

      const result = await service.captureOrReuse(issuerId, policySnapshot);

      expect(result).toEqual(existingCommitment);
      expect(prisma.issuerPolicyCommitment.findFirst).toHaveBeenCalledWith({
        where: {
          issuerId,
          commitment: expect.stringContaining("sha256:"),
          supersededAt: null,
        },
      });
    });

    it("should create new commitment if no matching policy", async () => {
      const issuerId = "issuer-1";
      const policySnapshot: IssuerPolicySnapshotInput = {
        signingKeyVersionId: "key-2",
        stellarAddress: "GTEST2",
        publicMetadata: null,
        status: ResourceStatus.ACTIVE,
      };

      (prisma.issuerPolicyCommitment.findFirst as jest.Mock).mockResolvedValue(
        null,
      );

      const newCommitment = {
        id: "commitment-2",
        issuerId,
        version: 2,
        commitment: "sha256:xyz789",
        policyInputsHash: "sha256:uvw000",
        policySnapshot,
        effectiveAt: new Date(),
        supersededAt: null,
        correlationId: "corr-1",
        createdAt: new Date(),
      };

      (prisma.$transaction as jest.Mock).mockImplementation((cb) => {
        // Mock transaction callback
        return cb({
          issuerPolicyCommitment: {
            findFirst: jest.fn().mockResolvedValue(null),
            updateMany: jest.fn(),
            create: jest.fn().mockResolvedValue(newCommitment),
          },
        });
      });

      const result = await service.captureOrReuse(
        issuerId,
        policySnapshot,
        "corr-1",
      );

      expect(result.version).toBe(2);
      expect(result.issuerId).toBe(issuerId);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("should increment version on new commitments", async () => {
      const issuerId = "issuer-1";
      const policySnapshot: IssuerPolicySnapshotInput = {
        signingKeyVersionId: "key-3",
        stellarAddress: "GTEST3",
        publicMetadata: { env: "production" },
        status: ResourceStatus.ACTIVE,
      };

      (prisma.issuerPolicyCommitment.findFirst as jest.Mock)
        .mockResolvedValueOnce(null)  // No existing commitment
        .mockResolvedValueOnce({
          version: 5,  // Current max version
        });  // findFirst for max version

      const transaction = jest.fn();
      (prisma.$transaction as jest.Mock).mockImplementation((cb) => {
        // Inside transaction: first call returns max version, then we create new
        return cb({
          issuerPolicyCommitment: {
            findFirst: jest
              .fn()
              .mockResolvedValue({ version: 5 }),  // Max version
            updateMany: jest.fn(),
            create: jest.fn().mockResolvedValue({
              id: "commitment-6",
              issuerId,
              version: 6,  // Incremented
              commitment: "sha256:new",
              policyInputsHash: "sha256:new2",
              policySnapshot,
              effectiveAt: new Date(),
              supersededAt: null,
              correlationId: null,
              createdAt: new Date(),
            }),
          },
        });
      });

      const result = await service.captureOrReuse(issuerId, policySnapshot);

      expect(result.version).toBe(6);
    });
  });

  describe("getCurrentCommitment", () => {
    it("should return the active commitment", async () => {
      const issuerId = "issuer-1";
      const commitment = {
        id: "commitment-1",
        issuerId,
        version: 3,
        commitment: "sha256:current",
        policyInputsHash: "sha256:inputs",
        policySnapshot: {},
        effectiveAt: new Date(),
        supersededAt: null,
        correlationId: null,
        createdAt: new Date(),
      };

      (prisma.issuerPolicyCommitment.findFirst as jest.Mock).mockResolvedValue(
        commitment,
      );

      const result = await service.getCurrentCommitment(issuerId);

      expect(result).toEqual(commitment);
      expect(prisma.issuerPolicyCommitment.findFirst).toHaveBeenCalledWith({
        where: {
          issuerId,
          supersededAt: null,
        },
        orderBy: { version: "desc" },
      });
    });

    it("should throw NotFoundException if no active commitment", async () => {
      const issuerId = "issuer-nodata";

      (prisma.issuerPolicyCommitment.findFirst as jest.Mock).mockResolvedValue(
        null,
      );

      await expect(service.getCurrentCommitment(issuerId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getCommitmentById", () => {
    it("should return commitment by ID", async () => {
      const commitment = {
        id: "commitment-1",
        issuerId: "issuer-1",
        version: 1,
        commitment: "sha256:abc",
        policyInputsHash: "sha256:def",
        policySnapshot: {},
        effectiveAt: new Date(),
        supersededAt: null,
        correlationId: null,
        createdAt: new Date(),
      };

      (prisma.issuerPolicyCommitment.findUnique as jest.Mock).mockResolvedValue(
        commitment,
      );

      const result = await service.getCommitmentById(commitment.id);

      expect(result).toEqual(commitment);
      expect(prisma.issuerPolicyCommitment.findUnique).toHaveBeenCalledWith({
        where: { id: commitment.id },
      });
    });

    it("should throw NotFoundException if commitment not found", async () => {
      (prisma.issuerPolicyCommitment.findUnique as jest.Mock).mockResolvedValue(
        null,
      );

      await expect(service.getCommitmentById("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getCommitmentAt", () => {
    it("should return commitment effective at timestamp", async () => {
      const issuerId = "issuer-1";
      const timestamp = new Date("2026-10-15T00:00:00Z");
      const commitment = {
        id: "commitment-1",
        issuerId,
        version: 2,
        commitment: "sha256:historical",
        policyInputsHash: "sha256:hist2",
        policySnapshot: {},
        effectiveAt: new Date("2026-10-10T00:00:00Z"),
        supersededAt: new Date("2026-10-16T00:00:00Z"),
        correlationId: null,
        createdAt: new Date(),
      };

      (prisma.issuerPolicyCommitment.findFirst as jest.Mock).mockResolvedValue(
        commitment,
      );

      const result = await service.getCommitmentAt(issuerId, timestamp);

      expect(result).toEqual(commitment);
    });

    it("should throw NotFoundException if no commitment at timestamp", async () => {
      (prisma.issuerPolicyCommitment.findFirst as jest.Mock).mockResolvedValue(
        null,
      );

      await expect(
        service.getCommitmentAt("issuer-1", new Date()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("listCommitments", () => {
    it("should list all commitments paginated", async () => {
      const issuerId = "issuer-1";
      const commitments = [
        {
          id: "c1",
          issuerId,
          version: 3,
          commitment: "sha256:v3",
          policyInputsHash: "sha256:v3h",
          policySnapshot: {},
          effectiveAt: new Date(),
          supersededAt: null,
          correlationId: null,
          createdAt: new Date(),
        },
        {
          id: "c2",
          issuerId,
          version: 2,
          commitment: "sha256:v2",
          policyInputsHash: "sha256:v2h",
          policySnapshot: {},
          effectiveAt: new Date(),
          supersededAt: new Date(),
          correlationId: null,
          createdAt: new Date(),
        },
      ];

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue({ id: issuerId });
      (prisma.issuerPolicyCommitment.findMany as jest.Mock).mockResolvedValue(
        commitments,
      );
      (prisma.issuerPolicyCommitment.count as jest.Mock).mockResolvedValue(2);

      const result = await service.listCommitments(issuerId, 50, 0);

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.hasMore).toBe(false);
    });

    it("should clamp limit to max 1000", async () => {
      const issuerId = "issuer-1";

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue({ id: issuerId });
      (prisma.issuerPolicyCommitment.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.issuerPolicyCommitment.count as jest.Mock).mockResolvedValue(0);

      await service.listCommitments(issuerId, 10000, 0);

      expect(prisma.issuerPolicyCommitment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: expect.any(Number),
        }),
      );

      const takeArg = (prisma.issuerPolicyCommitment.findMany as jest.Mock)
        .mock.calls[0][0].take;
      expect(takeArg).toBeLessThanOrEqual(1001);
    });

    it("should throw NotFoundException if issuer not found", async () => {
      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.listCommitments("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("assertCanReadCommitments", () => {
    it("should allow access for same organization", async () => {
      const issuerId = "issuer-1";
      const organizationId = "org-1";

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue({
        organizationId,
      });

      await expect(
        service.assertCanReadCommitments(issuerId, organizationId),
      ).resolves.toBeUndefined();
    });

    it("should deny access for different organization", async () => {
      const issuerId = "issuer-1";
      const organizationId = "org-1";
      const otherOrgId = "org-2";

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue({
        organizationId: otherOrgId,
      });

      await expect(
        service.assertCanReadCommitments(issuerId, organizationId),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should throw NotFoundException if issuer not found", async () => {
      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.assertCanReadCommitments("nonexistent", "org-1"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("deterministic hashing", () => {
    it("should produce identical hashes for identical policies", async () => {
      // This is a behavior test: verify that two identical policy snapshots
      // produce the same commitment hash. The actual hash computation is tested
      // via the crypto module, but we verify the service uses it correctly.

      const policySnapshot: IssuerPolicySnapshotInput = {
        signingKeyVersionId: "key-v1",
        stellarAddress: "GTEST123",
        publicMetadata: { name: "Test", version: 1 },
        status: ResourceStatus.ACTIVE,
      };

      (prisma.issuerPolicyCommitment.findFirst as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      // Mock transaction to capture created commitment
      let createdCommitment: any;
      (prisma.$transaction as jest.Mock).mockImplementation((cb) => {
        const tx = {
          issuerPolicyCommitment: {
            findFirst: jest.fn().mockResolvedValue(null),
            updateMany: jest.fn(),
            create: jest.fn().mockImplementation((data) => {
              createdCommitment = {
                ...data,
                id: "c1",
                createdAt: new Date(),
              };
              return createdCommitment;
            }),
          },
        };
        return cb(tx);
      });

      const result1 = await service.captureOrReuse("issuer-1", policySnapshot);

      // Now try same policy again
      (prisma.issuerPolicyCommitment.findFirst as jest.Mock).mockResolvedValueOnce(
        createdCommitment,
      );

      const result2 = await service.captureOrReuse("issuer-1", policySnapshot);

      // Should return the same commitment (reused)
      expect(result2.id).toBe(result1.id);
      expect(result2.commitment).toBe(result1.commitment);
    });
  });
});
