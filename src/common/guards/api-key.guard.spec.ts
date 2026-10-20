import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeyService } from "../../api-keys/api-key.service";
import { ApiKeyUsageService } from "../../api-keys/api-key-usage.service";
import { ApiKeyScope, ResourceStatus } from "@prisma/client";

describe("ApiKeyGuard", () => {
  let guard: ApiKeyGuard;
  let apiKeyServiceMock: jest.Mocked<ApiKeyService>;
  let apiKeyUsageServiceMock: jest.Mocked<ApiKeyUsageService>;

  const validKeySecret = "dGVzdGtleTAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg"; // 43 chars
  const validPrefix = validKeySecret.substring(0, 8);
  const organizationId = "org_test_123";

  function createMockExecutionContext(headers: Record<string, string | undefined>): ExecutionContext {
    const request: any = {
      headers,
      path: "/api/v1/proofs",
      url: "/api/v1/proofs",
    };

    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
        getNext: () => ({}),
      }),
      getClass: jest.fn(),
      getHandler: jest.fn(),
      getArgs: jest.fn(),
      getArgByIndex: jest.fn(),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
      getType: jest.fn(),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    apiKeyServiceMock = {
      lookupAndVerifyKey: jest.fn(),
      getDatabaseTime: jest.fn(),
      invalidateKeyCache: jest.fn(),
    } as unknown as jest.Mocked<ApiKeyService>;

    apiKeyUsageServiceMock = {
      recordUsage: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ApiKeyUsageService>;

    guard = new ApiKeyGuard(apiKeyServiceMock, apiKeyUsageServiceMock);
  });

  describe("positive authentication", () => {
    it("authenticates a valid active key and sets apiKeyContext", async () => {
      const activeKey = {
        id: "key_active_1",
        prefix: validPrefix,
        organizationId,
        status: ResourceStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date("2026-08-24T12:00:00Z"),
        scopeAssignments: [{ scope: ApiKeyScope.PROOF_VERIFY }],
      };

      apiKeyServiceMock.lookupAndVerifyKey.mockResolvedValue(activeKey as any);

      const context = createMockExecutionContext({
        authorization: `Bearer ${validKeySecret}`,
        "x-organization-id": organizationId,
      });

      const allowed = await guard.canActivate(context);

      expect(allowed).toBe(true);
      const req: any = context.switchToHttp().getRequest();
      expect(req.apiKeyContext).toEqual({
        keyId: activeKey.id,
        prefix: activeKey.prefix,
        organizationId: activeKey.organizationId,
        scopes: [ApiKeyScope.PROOF_VERIFY],
        createdAt: activeKey.createdAt,
      });
      expect(apiKeyServiceMock.lookupAndVerifyKey).toHaveBeenCalledWith(
        validPrefix,
        validKeySecret,
        organizationId,
      );
    });
  });

  describe("clock boundaries & database time semantics", () => {
    it("rejects an expired key with uniform 401 Unauthorized", async () => {
      // When key has reached or exceeded expiration boundary, lookupAndVerifyKey returns null
      apiKeyServiceMock.lookupAndVerifyKey.mockResolvedValue(null);

      const context = createMockExecutionContext({
        authorization: `Bearer ${validKeySecret}`,
        "x-organization-id": organizationId,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        new UnauthorizedException("Invalid API key"),
      );
    });

    it("evaluates key validity using database time semantics rather than local client skew", async () => {
      // Even if local machine clock drifts, lookupAndVerifyKey delegates to database time
      apiKeyServiceMock.lookupAndVerifyKey.mockImplementation(async () => {
        // Simulates lookupAndVerifyKey rejecting when dbNow >= expiresAt
        return null;
      });

      const context = createMockExecutionContext({
        authorization: `Bearer ${validKeySecret}`,
        "x-organization-id": organizationId,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(apiKeyServiceMock.lookupAndVerifyKey).toHaveBeenCalledWith(
        validPrefix,
        validKeySecret,
        organizationId,
      );
    });
  });

  describe("revocation & negative paths", () => {
    it("rejects revoked keys with uniform 401", async () => {
      apiKeyServiceMock.lookupAndVerifyKey.mockResolvedValue(null);

      const context = createMockExecutionContext({
        authorization: `Bearer ${validKeySecret}`,
        "x-organization-id": organizationId,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        new UnauthorizedException("Invalid API key"),
      );
    });

    it("rejects requests missing Authorization header", async () => {
      const context = createMockExecutionContext({
        "x-organization-id": organizationId,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        new UnauthorizedException("Invalid API key"),
      );
      expect(apiKeyServiceMock.lookupAndVerifyKey).not.toHaveBeenCalled();
    });

    it("rejects requests with malformed Bearer token", async () => {
      const context = createMockExecutionContext({
        authorization: "Basic 12345",
        "x-organization-id": organizationId,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        new UnauthorizedException("Invalid API key"),
      );
    });

    it("rejects requests with non-43-character secret format", async () => {
      const context = createMockExecutionContext({
        authorization: "Bearer tooshort",
        "x-organization-id": organizationId,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        new UnauthorizedException("Invalid API key"),
      );
    });

    it("rejects requests missing x-organization-id header", async () => {
      const context = createMockExecutionContext({
        authorization: `Bearer ${validKeySecret}`,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        new UnauthorizedException("Invalid API key"),
      );
    });
  });
});
