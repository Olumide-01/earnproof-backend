import { Test, TestingModule } from "@nestjs/testing";
import { ResourceStatus } from "@prisma/client";
import { SupportedAssetsController } from "./supported-assets.controller";
import { SupportedAssetsService } from "./supported-assets.service";
import { CreateSupportedAssetDto } from "./dto/create-supported-asset.dto";
import { UpdateSupportedAssetDto } from "./dto/update-supported-asset.dto";
import { UpdateAssetStatusDto } from "./dto/update-asset-status.dto";
import { ListSupportedAssetsDto } from "./dto/list-supported-assets.dto";

describe("SupportedAssetsController", () => {
  let controller: SupportedAssetsController;
  let service: SupportedAssetsService;

  const mockService = {
    createAsset: jest.fn(),
    updateAsset: jest.fn(),
    updateAssetStatus: jest.fn(),
    deleteAsset: jest.fn(),
    getAsset: jest.fn(),
    listAssets: jest.fn(),
  };

  const mockUser = {
    id: "user-123",
    walletAddress: "GUSER123",
    walletHash: "user-hash",
    role: "ADMIN" as const,
  };

  const mockAssetResponse = {
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
      controllers: [SupportedAssetsController],
      providers: [
        {
          provide: SupportedAssetsService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<SupportedAssetsController>(
      SupportedAssetsController,
    );
    service = module.get<SupportedAssetsService>(SupportedAssetsService);

    jest.clearAllMocks();
  });

  describe("createAsset", () => {
    it("should create a new asset", async () => {
      const createDto: CreateSupportedAssetDto = {
        organizationId: "org-123",
        code: "USDC",
        issuer: "GISSUER123",
        network: "testnet",
        decimals: 7,
      };

      mockService.createAsset.mockResolvedValue(mockAssetResponse);

      const result = await controller.createAsset(mockUser, createDto);

      expect(result).toEqual(mockAssetResponse);
      expect(service.createAsset).toHaveBeenCalledWith(mockUser, createDto);
    });
  });

  describe("listAssets", () => {
    it("should return paginated list of assets", async () => {
      const query: ListSupportedAssetsDto = {
        organizationId: "org-123",
        page: 1,
        limit: 20,
      };

      const expectedResponse = {
        items: [mockAssetResponse],
        total: 1,
        page: 1,
        limit: 20,
      };

      mockService.listAssets.mockResolvedValue(expectedResponse);

      const result = await controller.listAssets(mockUser, query);

      expect(result).toEqual(expectedResponse);
      expect(service.listAssets).toHaveBeenCalledWith(mockUser, query);
    });
  });

  describe("getAsset", () => {
    it("should return asset details", async () => {
      mockService.getAsset.mockResolvedValue(mockAssetResponse);

      const result = await controller.getAsset(mockUser, "asset-123");

      expect(result).toEqual(mockAssetResponse);
      expect(service.getAsset).toHaveBeenCalledWith(mockUser, "asset-123");
    });
  });

  describe("updateAsset", () => {
    it("should update asset metadata", async () => {
      const updateDto: UpdateSupportedAssetDto = {
        expectedRevision: 0,
        decimals: 6,
      };

      const updatedAsset = { ...mockAssetResponse, decimals: 6, revision: 1 };
      mockService.updateAsset.mockResolvedValue(updatedAsset);

      const result = await controller.updateAsset(
        mockUser,
        "asset-123",
        updateDto,
      );

      expect(result.decimals).toBe(6);
      expect(service.updateAsset).toHaveBeenCalledWith(
        mockUser,
        "asset-123",
        updateDto,
      );
    });
  });

  describe("updateAssetStatus", () => {
    it("should update asset status", async () => {
      const statusDto: UpdateAssetStatusDto = {
        expectedRevision: 0,
        status: ResourceStatus.SUSPENDED,
      };

      const updatedAsset = {
        ...mockAssetResponse,
        status: ResourceStatus.SUSPENDED,
        revision: 1,
      };
      mockService.updateAssetStatus.mockResolvedValue(updatedAsset);

      const result = await controller.updateAssetStatus(
        mockUser,
        "asset-123",
        statusDto,
      );

      expect(result.status).toBe(ResourceStatus.SUSPENDED);
      expect(service.updateAssetStatus).toHaveBeenCalledWith(
        mockUser,
        "asset-123",
        statusDto,
      );
    });
  });

  describe("deleteAsset", () => {
    it("should soft delete asset", async () => {
      const deletedAsset = {
        ...mockAssetResponse,
        status: ResourceStatus.DELETED,
      };
      mockService.deleteAsset.mockResolvedValue(deletedAsset);

      const result = await controller.deleteAsset(mockUser, "asset-123");

      expect(result.status).toBe(ResourceStatus.DELETED);
      expect(service.deleteAsset).toHaveBeenCalledWith(mockUser, "asset-123");
    });
  });
});
