import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../database/prisma.service";
import { IssuerRegistryService } from "./issuer-registry.service";
import { IssuersService } from "./issuers.service";

describe("IssuersService", () => {
  let service: IssuersService;
  let prisma: PrismaService;
  let issuerRegistry: IssuerRegistryService;

  const mockUser = {
    id: "user-1",
    walletAddress: "G1111111111111111111111111111111111111111111111111111111",
    walletHash: "sha256:hash1",
    role: "ADMIN",
  };

  const mockNonAdminUser = {
    id: "user-2",
    walletAddress: "G2222222222222222222222222222222222222222222222222222222",
    walletHash: "sha256:hash2",
    role: "ISSUER",
  };

  const mockOrganization = {
    id: "org-1",
    name: "Test Organization",
    slug: "test-org",
    website: "https://example.com",
    status: ResourceStatus.PENDING,
    revision: 0,
    createdById: mockUser.id,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    archivedAt: null,
    legalHoldAt: null,
    legalHoldReference: null,
    deletedAt: null,
  };

  const mockIssuer = {
    id: "issuer-1",
    organizationId: "org-1",
    stellarAddress: "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ",
    status: ResourceStatus.PENDING,
    metadataHash: "hash123",
    publicMetadata: { name: "Test Issuer" },
    contractSyncState: "PENDING",
    contractSyncedStatus: null,
    contractTransactionHash: null,
    contractSyncedAt: null,
    contractSyncError: null,
    revision: 0,
    verifiedAt: null,
    suspendedAt: null,
    revokedAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssuersService,
        {
          provide: PrismaService,
          useValue: {
            organization: {
              findUnique: jest.fn(),
            },
            issuer: {
              create: jest.fn(),
              update: jest.fn(),
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
              findUnique: jest.fn(),
              findUniqueOrThrow: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
            },
            issuerAddressRotation: {
              findUnique: jest.fn().mockResolvedValue(null),
            },
            issuerAddressHistory: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
            auditLog: {
              create: jest.fn(),
            },
          },
        },
        {
          provide: IssuerRegistryService,
          useValue: {
            sync: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<IssuersService>(IssuersService);
    prisma = module.get<PrismaService>(PrismaService);
    issuerRegistry = module.get<IssuerRegistryService>(IssuerRegistryService);
  });

  describe("createIssuer", () => {
    it("should create issuer when admin", async () => {
      const input = {
        organizationId: "org-1",
        stellarAddress:
          "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ",
        publicMetadata: { name: "Test Issuer" },
      };

      jest
        .spyOn(prisma.organization, "findUnique")
        .mockResolvedValue(mockOrganization);
      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(null);
      jest.spyOn(prisma.issuer, "create").mockResolvedValue(mockIssuer);
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const result = await service.createIssuer(mockUser, input);

      expect(result.id).toBe(mockIssuer.id);
      expect(result.status).toBe(ResourceStatus.PENDING);
      expect(prisma.issuer.create).toHaveBeenCalled();
    });

    it.each([
      ["the target of an open address rotation", "issuerAddressRotation", "findUnique"],
      ["an address an issuer used to hold", "issuerAddressHistory", "findFirst"],
    ] as const)("should reject registering %s", async (_label, table, method) => {
      jest
        .spyOn(prisma.organization, "findUnique")
        .mockResolvedValue(mockOrganization);
      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(null);
      jest
        .spyOn(prisma[table] as never, method as never)
        .mockResolvedValue({ id: "reserved" } as never);

      await expect(
        service.createIssuer(mockUser, {
          organizationId: "org-1",
          stellarAddress: mockIssuer.stellarAddress,
        }),
      ).rejects.toThrow("reserved by an issuer address rotation");
      expect(prisma.issuer.create).not.toHaveBeenCalled();
    });

    it("should reject when user is not admin", async () => {
      const input = {
        organizationId: "org-1",
        stellarAddress:
          "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTBTQUGS7SEEDS23ABC123DEF45",
      };

      await expect(
        service.createIssuer(mockNonAdminUser, input),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject duplicate stellar address", async () => {
      const input = {
        organizationId: "org-1",
        stellarAddress:
          "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ",
      };

      jest
        .spyOn(prisma.organization, "findUnique")
        .mockResolvedValue(mockOrganization);
      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(mockIssuer);

      await expect(service.createIssuer(mockUser, input)).rejects.toThrow(
        ConflictException,
      );
    });

    it("should reject invalid stellar address format", async () => {
      const input = {
        organizationId: "org-1",
        stellarAddress: "INVALID_ADDRESS",
      };

      jest
        .spyOn(prisma.organization, "findUnique")
        .mockResolvedValue(mockOrganization);
      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(null);

      await expect(service.createIssuer(mockUser, input)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject when organization not found", async () => {
      const input = {
        organizationId: "nonexistent",
        stellarAddress:
          "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ",
      };

      jest.spyOn(prisma.organization, "findUnique").mockResolvedValue(null);

      await expect(service.createIssuer(mockUser, input)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("updateIssuerStatus", () => {
    it("should transition from PENDING to ACTIVE", async () => {
      const input = { status: ResourceStatus.ACTIVE, expectedRevision: 0 };

      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(mockIssuer);
      jest.spyOn(prisma.issuer, "updateMany").mockResolvedValue({ count: 1 });
      jest.spyOn(prisma.issuer, "findUniqueOrThrow").mockResolvedValue({
        ...mockIssuer,
        status: ResourceStatus.ACTIVE,
        verifiedAt: new Date(),
      });
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const result = await service.updateIssuerStatus(
        mockUser,
        "issuer-1",
        input,
      );

      expect(result.status).toBe(ResourceStatus.ACTIVE);
      expect(prisma.issuer.updateMany).toHaveBeenCalled();
    });

    it("should reject invalid status transition", async () => {
      const input = { status: ResourceStatus.PENDING, expectedRevision: 0 };
      const activeIssuer = { ...mockIssuer, status: ResourceStatus.ACTIVE };

      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(activeIssuer);

      await expect(
        service.updateIssuerStatus(mockUser, "issuer-1", input),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject when user is not admin", async () => {
      const input = { status: ResourceStatus.ACTIVE, expectedRevision: 0 };

      await expect(
        service.updateIssuerStatus(mockNonAdminUser, "issuer-1", input),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should set verifiedAt when transitioning to ACTIVE", async () => {
      const input = { status: ResourceStatus.ACTIVE, expectedRevision: 0 };

      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(mockIssuer);
      jest.spyOn(prisma.issuer, "updateMany").mockResolvedValue({ count: 1 });
      jest.spyOn(prisma.issuer, "findUniqueOrThrow").mockResolvedValue({
        ...mockIssuer,
        status: ResourceStatus.ACTIVE,
        verifiedAt: new Date(),
      });
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      await service.updateIssuerStatus(mockUser, "issuer-1", input);

      expect(prisma.issuer.updateMany).toHaveBeenCalledWith({
        where: { id: "issuer-1", revision: 0 },
        data: expect.objectContaining({
          status: ResourceStatus.ACTIVE,
          verifiedAt: expect.any(Date),
        }),
      });
    });

    it("should set suspendedAt when transitioning to SUSPENDED", async () => {
      const input = { status: ResourceStatus.SUSPENDED, expectedRevision: 0 };
      const activeIssuer = { ...mockIssuer, status: ResourceStatus.ACTIVE };

      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(activeIssuer);
      jest.spyOn(prisma.issuer, "updateMany").mockResolvedValue({ count: 1 });
      jest.spyOn(prisma.issuer, "findUniqueOrThrow").mockResolvedValue({
        ...activeIssuer,
        status: ResourceStatus.SUSPENDED,
        suspendedAt: new Date(),
      });
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      await service.updateIssuerStatus(mockUser, "issuer-1", input);

      expect(prisma.issuer.updateMany).toHaveBeenCalledWith({
        where: { id: "issuer-1", revision: 0 },
        data: expect.objectContaining({
          status: ResourceStatus.SUSPENDED,
          suspendedAt: expect.any(Date),
        }),
      });
    });

    it("should set revokedAt when transitioning to REVOKED", async () => {
      const input = { status: ResourceStatus.REVOKED, expectedRevision: 0 };
      const activeIssuer = { ...mockIssuer, status: ResourceStatus.ACTIVE };

      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(activeIssuer);
      jest.spyOn(prisma.issuer, "updateMany").mockResolvedValue({ count: 1 });
      jest.spyOn(prisma.issuer, "findUniqueOrThrow").mockResolvedValue({
        ...activeIssuer,
        status: ResourceStatus.REVOKED,
        revokedAt: new Date(),
      });
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      await service.updateIssuerStatus(mockUser, "issuer-1", input);

      expect(prisma.issuer.updateMany).toHaveBeenCalledWith({
        where: { id: "issuer-1", revision: 0 },
        data: expect.objectContaining({
          status: ResourceStatus.REVOKED,
          revokedAt: expect.any(Date),
        }),
      });
    });
  });

  describe("syncIssuerStatus", () => {
    it("should sync issuer status to contract", async () => {
      const activeIssuer = {
        ...mockIssuer,
        status: ResourceStatus.ACTIVE,
        verifiedAt: new Date(),
      };

      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(activeIssuer);
      jest.spyOn(issuerRegistry, "sync").mockResolvedValue({
        state: "synced",
        transactionHash: "tx123",
        operation: "register_issuer",
      });
      jest.spyOn(prisma.issuer, "update").mockResolvedValue(activeIssuer);
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const result = await service.syncIssuerStatus(mockUser, "issuer-1");

      expect(result.synced).toBe(true);
      expect(result.state).toBe("SYNCED");
      expect(result.transactionHash).toBe("tx123");
      expect(issuerRegistry.sync).toHaveBeenCalled();
    });

    it("should handle sync failure gracefully", async () => {
      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(mockIssuer);
      jest.spyOn(issuerRegistry, "sync").mockResolvedValue({
        state: "failed",
        reason: "failed",
        error: "Network error",
      });
      jest.spyOn(prisma.issuer, "update").mockResolvedValue(mockIssuer);
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const result = await service.syncIssuerStatus(mockUser, "issuer-1");

      expect(result.synced).toBe(false);
      expect(result.reason).toBe("failed");
      expect(result.error).toBe("Network error");
    });

    it("should reject when user is not admin", async () => {
      await expect(
        service.syncIssuerStatus(mockNonAdminUser, "issuer-1"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("listIssuersPublic", () => {
    it("should list only active issuers", async () => {
      jest.spyOn(prisma.issuer, "findMany").mockResolvedValue([mockIssuer]);
      jest.spyOn(prisma.issuer, "count").mockResolvedValue(1);

      const result = await service.listIssuersPublic({});

      expect(result.items).toHaveLength(1);
      expect(prisma.issuer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: ResourceStatus.ACTIVE,
          }),
        }),
      );
    });

    it("should filter by organization", async () => {
      jest.spyOn(prisma.issuer, "findMany").mockResolvedValue([mockIssuer]);
      jest.spyOn(prisma.issuer, "count").mockResolvedValue(1);

      await service.listIssuersPublic({
        organizationId: "org-1",
      });

      expect(prisma.issuer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: "org-1",
          }),
        }),
      );
    });

    it("should compute trust status correctly", async () => {
      const trustedIssuer = {
        ...mockIssuer,
        status: ResourceStatus.ACTIVE,
        verifiedAt: new Date(),
      };

      jest.spyOn(prisma.issuer, "findMany").mockResolvedValue([trustedIssuer]);
      jest.spyOn(prisma.issuer, "count").mockResolvedValue(1);

      const result = await service.listIssuersPublic({});

      expect(result.items[0].trustStatus).toBe("TRUSTED");
    });

    it("should expose only allowlisted public metadata", async () => {
      jest.spyOn(prisma.issuer, "findMany").mockResolvedValue([
        {
          ...mockIssuer,
          status: ResourceStatus.ACTIVE,
          publicMetadata: {
            name: "Test Issuer",
            description: "Public description",
            logoUrl: "https://example.com/logo.png",
            supportEmail: "private@example.com",
            internalNotes: "do not expose",
          },
        },
      ]);
      jest.spyOn(prisma.issuer, "count").mockResolvedValue(1);

      const result = await service.listIssuersPublic({});

      expect(result.items[0].publicMetadata).toEqual({
        name: "Test Issuer",
        description: "Public description",
        logoUrl: "https://example.com/logo.png",
      });
      expect(JSON.stringify(result)).not.toContain("private@example.com");
      expect(JSON.stringify(result)).not.toContain("internalNotes");
    });

    it("returns a deterministic page with cursor-based pagination", async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({
        ...mockIssuer,
        id: `issuer-${i}`,
        createdAt: new Date(`2026-01-${String(i + 1).padStart(2, "0")}`),
      })).reverse();
      jest.spyOn(prisma.issuer, "findMany").mockResolvedValue(rows);
      jest.spyOn(prisma.issuer, "count").mockResolvedValue(50);

      const result = await service.listIssuersPublic({ limit: 10 });

      expect(result.limit).toBe(10);
      expect(result.items).toHaveLength(10);
      expect(result.pageInfo.hasMore).toBe(true);
      expect(result.pageInfo.nextCursor).not.toBeNull();
      expect(prisma.issuer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 11,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
      );
    });

    it("rejects an invalid cursor without querying the database", async () => {
      const findMany = jest.spyOn(prisma.issuer, "findMany");

      await expect(
        service.listIssuersPublic({ cursor: "not-a-valid-cursor" }),
      ).rejects.toThrow(BadRequestException);
      expect(findMany).not.toHaveBeenCalled();
    });
  });

  describe("computeTrustStatus", () => {
    it("should return REVOKED when revokedAt is set", () => {
      const issuer = { ...mockIssuer, status: ResourceStatus.REVOKED };
      // Access private method via service instance for testing
      const result = (service as any).computeTrustStatus(issuer);
      expect(result).toBe("REVOKED");
    });

    it("should return SUSPENDED when suspendedAt is set", () => {
      const issuer = { ...mockIssuer, status: ResourceStatus.SUSPENDED };
      const result = (service as any).computeTrustStatus(issuer);
      expect(result).toBe("SUSPENDED");
    });

    it("should return TRUSTED when verifiedAt is set", () => {
      const issuer = {
        ...mockIssuer,
        status: ResourceStatus.ACTIVE,
        verifiedAt: new Date(),
      };
      const result = (service as any).computeTrustStatus(issuer);
      expect(result).toBe("TRUSTED");
    });

    it("should return PENDING when no timestamps are set", () => {
      const result = (service as any).computeTrustStatus(mockIssuer);
      expect(result).toBe("PENDING");
    });
  });
});
