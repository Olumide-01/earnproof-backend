import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ApiKeyScope } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { ApiKeysController } from "./api-keys.controller";

type ApiKeyServiceMock = {
  createKey: jest.Mock;
  rotateKey: jest.Mock;
  revokeKey: jest.Mock;
  listKeysForOrganization: jest.Mock;
};

type PrismaServiceMock = {
  organization: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
  };
};

describe("ApiKeysController - Authorization", () => {
  let controller: ApiKeysController;
  let apiKeyService: ApiKeyServiceMock;
  let prismaService: PrismaServiceMock;

  const adminUser: AuthenticatedUser = {
    id: "user_admin_123",
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
    walletHash: "hash_admin_123",
    role: "ADMIN",
  };

  const creatorUser: AuthenticatedUser = {
    id: "user_creator_456",
    walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2",
    walletHash: "hash_creator_456",
    role: "DEVELOPER",
  };

  const outsiderUser: AuthenticatedUser = {
    id: "user_outsider_789",
    walletAddress: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3",
    walletHash: "hash_outsider_789",
    role: "WORKER",
  };

  const organizationId = "org_test_789";

  beforeEach(() => {
    apiKeyService = {
      createKey: jest.fn(),
      rotateKey: jest.fn(),
      revokeKey: jest.fn(),
      listKeysForOrganization: jest.fn(),
    };
    prismaService = {
      organization: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
    };
    controller = new ApiKeysController(
      apiKeyService as never,
      {
        getSummary: jest.fn().mockResolvedValue([]),
        freezeOnRevocation: jest.fn().mockResolvedValue(undefined),
        recordUsage: jest.fn().mockResolvedValue(undefined),
      } as never,
      { consume: jest.fn().mockResolvedValue({ userId: 'user_1' }), issue: jest.fn().mockResolvedValue({ token: 'tok', expiresAt: new Date() }) } as never,
      prismaService as never,
    );
  });

  function allowSingleOrganization(id = organizationId) {
    prismaService.organization.findMany.mockResolvedValueOnce([{ id }]);
  }

  function denyOrganizations() {
    prismaService.organization.findMany.mockResolvedValueOnce([]);
  }

  function allowRequestedOrganization(id = organizationId) {
    prismaService.organization.findFirst.mockResolvedValueOnce({ id });
  }

  function apiKeyResponse(prefix = "test_se") {
    return {
      secret: "test_secret_key_123456789",
      apiKey: {
        id: "key_123",
        prefix,
        name: "Test Key",
        status: "ACTIVE",
        scopes: [ApiKeyScope.PROOF_VERIFY],
        createdAt: new Date("2027-01-01T00:00:00.000Z"),
        expiresAt: null,
      },
    };
  }

  describe("organization authorization helper behavior", () => {
    it("infers an organization only when exactly one manageable organization exists", async () => {
      allowSingleOrganization();
      apiKeyService.listKeysForOrganization.mockResolvedValueOnce({
        data: [],
        pageInfo: { hasMore: false, nextCursor: null },
      });

      await controller.listKeys(adminUser);

      expect(apiKeyService.listKeysForOrganization).toHaveBeenCalledWith(
        organizationId,
        { cursor: undefined, limit: undefined },
      );
    });

    it("fails closed when organizationId is omitted and more than one organization is manageable", async () => {
      prismaService.organization.findMany.mockResolvedValueOnce([
        { id: "org_1" },
        { id: "org_2" },
      ]);

      await expect(controller.listKeys(adminUser)).rejects.toThrow(
        BadRequestException,
      );
      expect(apiKeyService.listKeysForOrganization).not.toHaveBeenCalled();
    });

    it("checks explicit organization ownership for non-admin callers", async () => {
      allowRequestedOrganization();
      apiKeyService.listKeysForOrganization.mockResolvedValueOnce({
        data: [],
        pageInfo: { hasMore: false, nextCursor: null },
      });

      await controller.listKeys(creatorUser, { organizationId });

      // Deleted organizations never resolve; archived ones are resolved so
      // the caller can tell "archived" apart from "not yours".
      expect(prismaService.organization.findFirst).toHaveBeenCalledWith({
        where: {
          id: organizationId,
          deletedAt: null,
          createdById: creatorUser.id,
        },
        select: {
          id: true,
          archivedAt: true,
        },
      });
    });

    it("checks explicit organization existence for global admins", async () => {
      allowRequestedOrganization();
      apiKeyService.listKeysForOrganization.mockResolvedValueOnce({
        data: [],
        pageInfo: { hasMore: false, nextCursor: null },
      });

      await controller.listKeys(adminUser, { organizationId });

      expect(prismaService.organization.findFirst).toHaveBeenCalledWith({
        where: {
          id: organizationId,
          deletedAt: null,
        },
        select: {
          id: true,
          archivedAt: true,
        },
      });
    });
  });

  describe("createKey", () => {
    it("allows an authorized user to create an API key", async () => {
      allowSingleOrganization();
      apiKeyService.createKey.mockResolvedValueOnce(apiKeyResponse());

      const result = await controller.createKey(adminUser, {
        name: "Test Key",
        scopes: [ApiKeyScope.PROOF_VERIFY],
      });

      expect(result.secret).toBeDefined();
      expect(result.apiKey.name).toBe("Test Key");
      expect(apiKeyService.createKey).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId,
          createdBy: adminUser.id,
        }),
      );
    });

    it("rejects unauthorized users with 403 Forbidden", async () => {
      denyOrganizations();

      await expect(
        controller.createKey(outsiderUser, {
          name: "Unauthorized Key",
          scopes: [ApiKeyScope.PROOF_VERIFY],
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(apiKeyService.createKey).not.toHaveBeenCalled();
    });

    it("checks authorization before calling the service", async () => {
      denyOrganizations();

      await expect(
        controller.createKey(outsiderUser, {
          name: "Test",
          scopes: [ApiKeyScope.PROOF_VERIFY],
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(apiKeyService.createKey).not.toHaveBeenCalled();
    });

    it("validates scopes after authorization but before persistence", async () => {
      allowSingleOrganization();

      await expect(
        controller.createKey(adminUser, {
          name: "Test Key",
          scopes: ["INVALID_SCOPE" as ApiKeyScope],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(apiKeyService.createKey).not.toHaveBeenCalled();
    });
  });

  describe("listKeys", () => {
    it("allows an authorized user to list API keys", async () => {
      allowSingleOrganization();
      apiKeyService.listKeysForOrganization.mockResolvedValueOnce({
        data: [
          {
            id: "key_1",
            prefix: "prefix1",
            name: "Key 1",
            status: "ACTIVE",
            scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
            createdAt: new Date("2027-01-01T00:00:00.000Z"),
            rotatedAt: null,
            revokedAt: null,
            expiresAt: null,
            lastUsedAt: null,
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      });

      const result = await controller.listKeys(adminUser);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.name).toBe("Key 1");
      expect(apiKeyService.listKeysForOrganization).toHaveBeenCalledWith(
        organizationId,
        { cursor: undefined, limit: undefined },
      );
    });

    it("rejects unauthorized users before listing keys", async () => {
      denyOrganizations();

      await expect(controller.listKeys(outsiderUser)).rejects.toThrow(
        ForbiddenException,
      );
      expect(apiKeyService.listKeysForOrganization).not.toHaveBeenCalled();
    });
  });

  describe("rotateKey", () => {
    it("allows an authorized user to rotate an API key", async () => {
      allowSingleOrganization();
      apiKeyService.rotateKey.mockResolvedValueOnce(apiKeyResponse("new_se"));

      const result = await controller.rotateKey(adminUser, "key_123");

      expect(result.secret).toBeDefined();
      expect(result.apiKey.prefix).toBe("new_se");
      expect(apiKeyService.rotateKey).toHaveBeenCalledWith(
        "key_123",
        organizationId,
        adminUser.id,
      );
    });

    it("rejects unauthorized users before rotating keys", async () => {
      denyOrganizations();

      await expect(
        controller.rotateKey(outsiderUser, "key_123"),
      ).rejects.toThrow(ForbiddenException);
      expect(apiKeyService.rotateKey).not.toHaveBeenCalled();
    });

    it("maps cross-organization service errors to Forbidden", async () => {
      allowSingleOrganization();
      apiKeyService.rotateKey.mockRejectedValueOnce(
        new Error("Key does not belong to this organization"),
      );

      await expect(
        controller.rotateKey(adminUser, "key_foreign"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("revokeKey", () => {
    it("allows an authorized user to revoke an API key", async () => {
      allowSingleOrganization();
      apiKeyService.revokeKey.mockResolvedValueOnce(undefined);

      const result = await controller.revokeKey(adminUser, "key_123");

      expect(result).toBeUndefined();
      expect(apiKeyService.revokeKey).toHaveBeenCalledWith(
        "key_123",
        organizationId,
        adminUser.id,
      );
    });

    it("rejects unauthorized users before revoking keys", async () => {
      denyOrganizations();

      await expect(
        controller.revokeKey(outsiderUser, "key_123"),
      ).rejects.toThrow(ForbiddenException);
      expect(apiKeyService.revokeKey).not.toHaveBeenCalled();
    });

    it("maps missing keys to Forbidden to avoid identifier discovery", async () => {
      allowSingleOrganization();
      apiKeyService.revokeKey.mockRejectedValueOnce(new Error("Key not found"));

      await expect(
        controller.revokeKey(adminUser, "key_nonexistent"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("all operations", () => {
    it("authorized users can execute create, list, rotate, and revoke", async () => {
      prismaService.organization.findMany.mockResolvedValue([{ id: organizationId }]);
      apiKeyService.createKey.mockResolvedValueOnce(apiKeyResponse("prefix1"));
      apiKeyService.listKeysForOrganization.mockResolvedValueOnce({
        data: [],
        pageInfo: { hasMore: false, nextCursor: null },
      });
      apiKeyService.rotateKey.mockResolvedValueOnce(apiKeyResponse("prefix2"));
      apiKeyService.revokeKey.mockResolvedValueOnce(undefined);

      await expect(
        controller.createKey(adminUser, { name: "Key 1" }),
      ).resolves.toBeDefined();
      await expect(controller.listKeys(adminUser)).resolves.toBeDefined();
      await expect(
        controller.rotateKey(adminUser, "key_1"),
      ).resolves.toBeDefined();
      await expect(
        controller.revokeKey(adminUser, "key_1"),
      ).resolves.toBeUndefined();

      expect(apiKeyService.createKey).toHaveBeenCalledTimes(1);
      expect(apiKeyService.listKeysForOrganization).toHaveBeenCalledTimes(1);
      expect(apiKeyService.rotateKey).toHaveBeenCalledTimes(1);
      expect(apiKeyService.revokeKey).toHaveBeenCalledTimes(1);
    });

    it("unauthorized users are rejected from create, list, rotate, and revoke", async () => {
      prismaService.organization.findMany.mockResolvedValue([]);

      await expect(
        controller.createKey(outsiderUser, { name: "Key" }),
      ).rejects.toThrow(ForbiddenException);
      await expect(controller.listKeys(outsiderUser)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        controller.rotateKey(outsiderUser, "key_1"),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.revokeKey(outsiderUser, "key_1"),
      ).rejects.toThrow(ForbiddenException);

      expect(apiKeyService.createKey).not.toHaveBeenCalled();
      expect(apiKeyService.listKeysForOrganization).not.toHaveBeenCalled();
      expect(apiKeyService.rotateKey).not.toHaveBeenCalled();
      expect(apiKeyService.revokeKey).not.toHaveBeenCalled();
    });
  });

  describe("inspectRotation & earlyCutover", () => {
    let mockRotationService: any;
    let mockRecentAuth: any;

    beforeEach(() => {
      mockRotationService = {
        inspectRotation: jest.fn().mockResolvedValue({ familyId: "fam_1", status: "IN_OVERLAP" }),
        earlyCutover: jest.fn().mockResolvedValue({
          rotation: { familyId: "fam_1", status: "CUTOVER" },
          cutoverReceipt: { id: "rec_1", receiptHash: "sha256:123" },
        }),
      };
      mockRecentAuth = {
        consume: jest.fn().mockResolvedValue({ userId: adminUser.id }),
      };
      controller = new ApiKeysController(
        apiKeyService as never,
        {} as never,
        {} as never,
        mockRecentAuth as never,
        prismaService as never,
        mockRotationService as never,
      );
    });

    it("allows authorized admin to inspect rotation", async () => {
      allowSingleOrganization();
      const res = await controller.inspectRotation(adminUser, "key_1");
      expect(res.familyId).toBe("fam_1");
      expect(mockRotationService.inspectRotation).toHaveBeenCalledWith("key_1", organizationId);
    });

    it("rejects unauthorized user from inspecting rotation", async () => {
      denyOrganizations();
      await expect(controller.inspectRotation(outsiderUser, "key_1")).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockRotationService.inspectRotation).not.toHaveBeenCalled();
    });

    it("allows authorized admin to execute early cutover and consumes recent-auth token", async () => {
      allowSingleOrganization();
      const mockReq = {
        headers: {
          "x-recent-auth": "assert_tok_123",
          origin: "https://dashboard.earnproof.com",
        },
      } as any;

      const res = await controller.earlyCutover(adminUser, "key_1", {}, mockReq);
      expect(res.rotation.status).toBe("CUTOVER");
      expect(mockRecentAuth.consume).toHaveBeenCalledWith({
        token: "assert_tok_123",
        action: "key:cutover",
        resourceId: "key_1",
        origin: "https://dashboard.earnproof.com",
      });
      expect(mockRotationService.earlyCutover).toHaveBeenCalledWith(
        "key_1",
        organizationId,
        adminUser.id,
      );
    });

    it("rejects unauthorized user from early cutover", async () => {
      denyOrganizations();
      await expect(controller.earlyCutover(outsiderUser, "key_1")).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockRotationService.earlyCutover).not.toHaveBeenCalled();
    });
  });
});
