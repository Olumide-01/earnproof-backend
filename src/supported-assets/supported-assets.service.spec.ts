import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { ConflictException } from "../common/exceptions/domain.exceptions";
import { SupportedAssetsService } from "./supported-assets.service";
import { CreateSupportedAssetDto } from "./dto/create-supported-asset.dto";
import { UpdateSupportedAssetDto } from "./dto/update-supported-asset.dto";
import { UpdateAssetStatusDto } from "./dto/update-asset-status.dto";

describe("SupportedAssetsService", () => {
  let service: SupportedAssetsService;

  const mockPrismaService = {
    organization: {
      findUnique: jest.fn(),
    },
    organizationMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    supportedAsset: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  };

  const mockAdminUser = {
    id: "admin-user-id",
    walletAddress: "GADMIN",
    walletHash: "admin-hash",
    role: "ADMIN" as const,
  };

  const mockOrgOwnerUser = {
    id: "owner-user-id",
    walletAddress: "GOWNER",
    walletHash: "owner-hash",
    role: "DEVELOPER" as const,
  };

  const mockOrgAdminUser = {
    id: "admin-member-id",
    walletAddress: "GMEMBER",
    walletHash: "member-hash",
    role: "DEVELOPER" as const,
  };

  const mockOrganization = {
    id: "org-123",
    name: "Test Org",
    slug: "test-org",
    status: ResourceStatus.ACTIVE,
    createdById: "owner-user-id",
  };

  const mockAsset = {
    id: "asset-123",
    organizationId: "org-123",
    assetKey: "testnet:USDC:GISSUER123",
    code: "USDC",
    issuer: "GISSUER123",
    network: "testnet",
    decimals: 7,
    status: ResourceStatus.ACTIVE,
    revision: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportedAssetsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<SupportedAssetsService>(SupportedAssetsService);

    // Reset all mocks
    jest.clearAllMocks();
  });

  describe("createAsset", () => {
    const createDto: CreateSupportedAssetDto = {
      organizationId: "org-123",
      code: "USDC",
      issuer: "GISSUER123",
      network: "testnet",
      decimals: 7,
    };

    it("should create asset with valid inputs as admin", async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue(
        mockOrganization,
      );
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(null);
      mockPrismaService.supportedAsset.create.mockResolvedValue(mockAsset);
      mockPrismaService.auditLog.create.mockResolvedValue({});

      const result = await service.createAsset(mockAdminUser, createDto);

      expect(result).toMatchObject({
        id: "asset-123",
        code: "USDC",
        issuer: "GISSUER123",
        network: "testnet",
        decimals: 7,
      });
      expect(mockPrismaService.supportedAsset.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: "org-123",
          assetKey: "testnet:USDC:GISSUER123",
          code: "USDC",
          issuer: "GISSUER123",
          network: "testnet",
          decimals: 7,
          status: ResourceStatus.ACTIVE,
          revision: 0,
        }),
      });
    });

    it("should create asset as organization owner", async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue(
        mockOrganization,
      );
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "owner-user-id",
        role: "OWNER",
        status: ResourceStatus.ACTIVE,
      });
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(null);
      mockPrismaService.supportedAsset.create.mockResolvedValue(mockAsset);
      mockPrismaService.auditLog.create.mockResolvedValue({});

      const result = await service.createAsset(mockOrgOwnerUser, createDto);

      expect(result.code).toBe("USDC");
    });

    it("should create asset with null issuer for native XLM", async () => {
      const nativeDto = {
        ...createDto,
        code: "XLM",
        issuer: null,
      };

      mockPrismaService.organization.findUnique.mockResolvedValue(
        mockOrganization,
      );
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(null);
      mockPrismaService.supportedAsset.create.mockResolvedValue({
        ...mockAsset,
        code: "XLM",
        issuer: null,
        assetKey: "testnet:XLM:native",
      });
      mockPrismaService.auditLog.create.mockResolvedValue({});

      const result = await service.createAsset(mockOrgOwnerUser, nativeDto);

      expect(result).toBeDefined();

      expect(mockPrismaService.supportedAsset.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          assetKey: "testnet:XLM:native",
          code: "XLM",
          issuer: null,
        }),
      });
    });

    it("should reject duplicate asset in same organization", async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue(
        mockOrganization,
      );
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(mockAsset);

      await expect(
        service.createAsset(mockAdminUser, createDto),
      ).rejects.toThrow(ConflictException);
    });

    it("should reject if organization does not exist", async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue(null);

      await expect(
        service.createAsset(mockAdminUser, createDto),
      ).rejects.toThrow(NotFoundException);
    });

    it("should reject non-admin without organization membership", async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue(
        mockOrganization,
      );
      mockPrismaService.organizationMember.findUnique.mockResolvedValue(null);

      await expect(
        service.createAsset(mockOrgOwnerUser, createDto),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject organization member without admin rights", async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue(
        mockOrganization,
      );
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "owner-user-id",
        role: "MEMBER",
        status: ResourceStatus.ACTIVE,
      });

      await expect(
        service.createAsset(mockOrgOwnerUser, createDto),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("updateAsset", () => {
    const updateDto: UpdateSupportedAssetDto = {
      expectedRevision: 0,
      decimals: 6,
    };

    it("should update asset metadata", async () => {
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(mockAsset);
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "admin-member-id",
        role: "ADMIN",
        status: ResourceStatus.ACTIVE,
      });
      mockPrismaService.supportedAsset.updateMany.mockResolvedValue({
        count: 1,
      });
      mockPrismaService.supportedAsset.findUniqueOrThrow.mockResolvedValue({
        ...mockAsset,
        decimals: 6,
        revision: 1,
      });
      mockPrismaService.auditLog.create.mockResolvedValue({});

      const result = await service.updateAsset(
        mockOrgAdminUser,
        "asset-123",
        updateDto,
      );

      expect(result.decimals).toBe(6);
      expect(result.revision).toBe(1);
    });

    it("should handle optimistic lock conflict", async () => {
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(mockAsset);
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "admin-member-id",
        role: "ADMIN",
        status: ResourceStatus.ACTIVE,
      });
      mockPrismaService.supportedAsset.updateMany.mockResolvedValue({
        count: 0,
      });

      await expect(
        service.updateAsset(mockOrgAdminUser, "asset-123", updateDto),
      ).rejects.toThrow(ConflictException);
    });

    it("should reject if asset does not exist", async () => {
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(null);

      await expect(
        service.updateAsset(mockOrgAdminUser, "asset-123", updateDto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("updateAssetStatus", () => {
    const statusDto: UpdateAssetStatusDto = {
      expectedRevision: 0,
      status: ResourceStatus.SUSPENDED,
    };

    it("should update asset status with valid transition", async () => {
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(mockAsset);
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "admin-member-id",
        role: "ADMIN",
        status: ResourceStatus.ACTIVE,
      });
      mockPrismaService.supportedAsset.updateMany.mockResolvedValue({
        count: 1,
      });
      mockPrismaService.supportedAsset.findUniqueOrThrow.mockResolvedValue({
        ...mockAsset,
        status: ResourceStatus.SUSPENDED,
        revision: 1,
      });
      mockPrismaService.auditLog.create.mockResolvedValue({});

      const result = await service.updateAssetStatus(
        mockOrgAdminUser,
        "asset-123",
        statusDto,
      );

      expect(result.status).toBe(ResourceStatus.SUSPENDED);
      expect(result.revision).toBe(1);
    });

    it("should reject invalid status transition", async () => {
      const revokedAsset = { ...mockAsset, status: ResourceStatus.REVOKED };
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(
        revokedAsset,
      );
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "admin-member-id",
        role: "ADMIN",
        status: ResourceStatus.ACTIVE,
      });

      await expect(
        service.updateAssetStatus(mockOrgAdminUser, "asset-123", {
          expectedRevision: 0,
          status: ResourceStatus.ACTIVE,
        }),
      ).rejects.toThrow("Invalid status transition");
    });
  });

  describe("deleteAsset", () => {
    it("should soft delete asset as owner", async () => {
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(mockAsset);
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "owner-user-id",
        role: "OWNER",
        status: ResourceStatus.ACTIVE,
      });
      mockPrismaService.supportedAsset.update.mockResolvedValue({
        ...mockAsset,
        status: ResourceStatus.DELETED,
        revision: 1,
      });
      mockPrismaService.auditLog.create.mockResolvedValue({});

      const result = await service.deleteAsset(mockOrgOwnerUser, "asset-123");

      expect(result.status).toBe(ResourceStatus.DELETED);
    });

    it("should reject delete by non-owner", async () => {
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(mockAsset);
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "admin-member-id",
        role: "ADMIN",
        status: ResourceStatus.ACTIVE,
      });

      await expect(
        service.deleteAsset(mockOrgAdminUser, "asset-123"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("getAsset", () => {
    it("should return asset details for authorized user", async () => {
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(mockAsset);
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "owner-user-id",
        role: "MEMBER",
        status: ResourceStatus.ACTIVE,
      });

      const result = await service.getAsset(mockOrgOwnerUser, "asset-123");

      expect(result.id).toBe("asset-123");
      expect(result.code).toBe("USDC");
    });

    it("should reject unauthorized access", async () => {
      mockPrismaService.supportedAsset.findUnique.mockResolvedValue(mockAsset);
      mockPrismaService.organizationMember.findUnique.mockResolvedValue(null);

      await expect(
        service.getAsset(mockOrgOwnerUser, "asset-123"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("listAssets", () => {
    it("should list assets for organization", async () => {
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "owner-user-id",
        role: "MEMBER",
        status: ResourceStatus.ACTIVE,
      });
      mockPrismaService.supportedAsset.findMany.mockResolvedValue([mockAsset]);
      mockPrismaService.supportedAsset.count.mockResolvedValue(1);

      const result = await service.listAssets(mockOrgOwnerUser, {
        organizationId: "org-123",
      });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0].code).toBe("USDC");
    });

    it("should list all assets for admin without filter", async () => {
      mockPrismaService.supportedAsset.findMany.mockResolvedValue([mockAsset]);
      mockPrismaService.supportedAsset.count.mockResolvedValue(1);

      const result = await service.listAssets(mockAdminUser, {});

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it("should filter by network", async () => {
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "owner-user-id",
        role: "MEMBER",
        status: ResourceStatus.ACTIVE,
      });
      mockPrismaService.supportedAsset.findMany.mockResolvedValue([mockAsset]);
      mockPrismaService.supportedAsset.count.mockResolvedValue(1);

      const result = await service.listAssets(mockOrgOwnerUser, {
        organizationId: "org-123",
        network: "testnet",
      });

      expect(result.items).toHaveLength(1);
      expect(mockPrismaService.supportedAsset.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            network: "testnet",
          }),
        }),
      );
    });

    it("should filter by status", async () => {
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "owner-user-id",
        role: "MEMBER",
        status: ResourceStatus.ACTIVE,
      });
      mockPrismaService.supportedAsset.findMany.mockResolvedValue([mockAsset]);
      mockPrismaService.supportedAsset.count.mockResolvedValue(1);

      const result = await service.listAssets(mockOrgOwnerUser, {
        organizationId: "org-123",
        status: ResourceStatus.ACTIVE,
      });

      expect(result.items).toHaveLength(1);
      expect(mockPrismaService.supportedAsset.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: ResourceStatus.ACTIVE,
          }),
        }),
      );
    });

    it("should paginate results", async () => {
      mockPrismaService.organizationMember.findUnique.mockResolvedValue({
        organizationId: "org-123",
        userId: "owner-user-id",
        role: "MEMBER",
        status: ResourceStatus.ACTIVE,
      });
      mockPrismaService.supportedAsset.findMany.mockResolvedValue([mockAsset]);
      mockPrismaService.supportedAsset.count.mockResolvedValue(50);

      const result = await service.listAssets(mockOrgOwnerUser, {
        organizationId: "org-123",
        page: 2,
        limit: 10,
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(50);
      expect(mockPrismaService.supportedAsset.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
        }),
      );
    });
  });
});
