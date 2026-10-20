import { NotFoundException } from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { AuthTokenService } from "../auth/auth-token.service";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { IssuersController } from "./issuers.controller";
import { IssuersService } from "./issuers.service";

describe("IssuersController", () => {
  let controller: IssuersController;
  let service: IssuersService;

  const mockUser = {
    id: "user-1",
    walletAddress: "G1111111111111111111111111111111111111111111111111111111",
    walletHash: "sha256:hash1",
    role: "ADMIN",
  };

  const mockIssuer = {
    id: "issuer-1",
    organizationId: "org-1",
    stellarAddress:
      "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTBTQUGS7SEEDS23ABC123DEF45",
    status: ResourceStatus.PENDING,
    metadataHash: "hash123",
    publicMetadata: { name: "Test Issuer" },
    contractSyncState: "PENDING",
    contractTransactionHash: null,
    contractSyncedAt: null,
    revision: 0,
    verifiedAt: null,
    suspendedAt: null,
    revokedAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const mockPublicIssuer = {
    id: "issuer-1",
    stellarAddress:
      "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTBTQUGS7SEEDS23ABC123DEF45",
    trustStatus: "PENDING" as const,
    publicMetadata: {
      name: "Test Issuer",
      description: "A test issuer",
    },
    createdAt: new Date("2026-01-01"),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [IssuersController],
      providers: [
        {
          provide: IssuersService,
          useValue: {
            createIssuer: jest.fn(),
            updateIssuerMetadata: jest.fn(),
            updateIssuerStatus: jest.fn(),
            syncIssuerStatus: jest.fn(),
            getIssuer: jest.fn(),
            getIssuerPublic: jest.fn(),
            listIssuers: jest.fn(),
            listIssuersPublic: jest.fn(),
          },
        },
        {
          provide: AuthTokenService,
          useValue: {
            verify: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .overrideGuard(RoleGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get<IssuersController>(IssuersController);
    service = module.get<IssuersService>(IssuersService);
  });

  describe("createIssuer", () => {
    it("should call service and return result", async () => {
      const input = {
        organizationId: "org-1",
        stellarAddress:
          "GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTBTQUGS7SEEDS23ABC123DEF45",
        publicMetadata: { name: "Test Issuer" },
      };

      jest.spyOn(service, "createIssuer").mockResolvedValue(mockIssuer);

      const result = await controller.createIssuer(mockUser, input);

      expect(result).toEqual(mockIssuer);
      expect(service.createIssuer).toHaveBeenCalledWith(mockUser, input);
    });
  });

  describe("updateIssuerMetadata", () => {
    it("should call service and return result", async () => {
      const input = {
        publicMetadata: {
          name: "Updated Issuer",
          description: "Updated description",
          logoUrl: "https://example.com/logo.png",
        },
        expectedRevision: 0,
      };

      jest.spyOn(service, "updateIssuerMetadata").mockResolvedValue({
        ...mockIssuer,
        metadataHash: "newhash",
      });

      const result = await controller.updateIssuerMetadata(
        mockUser,
        "issuer-1",
        input,
      );

      expect(result.metadataHash).toBe("newhash");
      expect(service.updateIssuerMetadata).toHaveBeenCalledWith(
        mockUser,
        "issuer-1",
        input,
      );
    });
  });

  describe("updateIssuerStatus", () => {
    it("should call service and return result", async () => {
      const input = { status: ResourceStatus.ACTIVE, expectedRevision: 0 };

      jest.spyOn(service, "updateIssuerStatus").mockResolvedValue({
        ...mockIssuer,
        status: ResourceStatus.ACTIVE,
        verifiedAt: new Date(),
      });

      const result = await controller.updateIssuerStatus(
        mockUser,
        "issuer-1",
        input,
      );

      expect(result.status).toBe(ResourceStatus.ACTIVE);
      expect(service.updateIssuerStatus).toHaveBeenCalledWith(
        mockUser,
        "issuer-1",
        input,
      );
    });
  });

  describe("syncIssuerStatus", () => {
    it("should call service and return result", async () => {
      const response = {
        issuerId: "issuer-1",
        synced: true,
        state: "SYNCED" as const,
        transactionHash: "tx123",
        currentStatus: ResourceStatus.ACTIVE,
      };

      jest.spyOn(service, "syncIssuerStatus").mockResolvedValue(response);

      const result = await controller.syncIssuerStatus(mockUser, "issuer-1");

      expect(result).toEqual(response);
      expect(service.syncIssuerStatus).toHaveBeenCalledWith(
        mockUser,
        "issuer-1",
      );
    });

    it("should handle sync failures gracefully", async () => {
      const response = {
        issuerId: "issuer-1",
        synced: false,
        state: "FAILED" as const,
        reason: "failed",
        error: "Network error",
        currentStatus: ResourceStatus.PENDING,
      };

      jest.spyOn(service, "syncIssuerStatus").mockResolvedValue(response);

      const result = await controller.syncIssuerStatus(mockUser, "issuer-1");

      expect(result.synced).toBe(false);
      expect(result.error).toBe("Network error");
    });
  });

  describe("getIssuer", () => {
    it("should return admin issuer details", async () => {
      jest.spyOn(service, "getIssuer").mockResolvedValue(mockIssuer);

      const result = await controller.getIssuer("issuer-1");

      expect(result).toEqual(mockIssuer);
      expect(service.getIssuer).toHaveBeenCalledWith("issuer-1");
    });

    it("should handle 404", async () => {
      jest
        .spyOn(service, "getIssuer")
        .mockRejectedValue(new NotFoundException());

      await expect(controller.getIssuer("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getIssuerPublic", () => {
    it("should return public issuer details with redacted metadata", async () => {
      jest
        .spyOn(service, "getIssuerPublic")
        .mockResolvedValue(mockPublicIssuer);

      const result = await controller.getIssuerPublic("issuer-1");

      expect(result).toEqual(mockPublicIssuer);
      expect(service.getIssuerPublic).toHaveBeenCalledWith("issuer-1");
    });
  });

  describe("listIssuersPublic", () => {
    it("should return paginated public list", async () => {
      const response = {
        items: [mockPublicIssuer],
        total: 1,
        limit: 20,
        pageInfo: { hasMore: false, nextCursor: null },
      };

      jest.spyOn(service, "listIssuersPublic").mockResolvedValue(response);

      const result = await controller.listIssuersPublic({});

      expect(result).toEqual(response);
      expect(service.listIssuersPublic).toHaveBeenCalledWith(
        expect.any(Object),
      );
    });
  });

  describe("listIssuersAdmin", () => {
    it("should return paginated admin list", async () => {
      const response = {
        items: [mockIssuer],
        total: 1,
        limit: 20,
        pageInfo: { hasMore: false, nextCursor: null },
      };

      jest.spyOn(service, "listIssuers").mockResolvedValue(response);

      const result = await controller.listIssuersAdmin({});

      expect(result).toEqual(response);
      expect(service.listIssuers).toHaveBeenCalledWith(expect.any(Object));
    });
  });
});
