import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  HttpStatus,
  Query,
  UseGuards,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Optional,
  Req,
} from "@nestjs/common";
import { Request } from "express";
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiParam,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from "@nestjs/swagger";
import { ApiKeyScope } from "@prisma/client";
import { AuthGuard } from "../common/guards/auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { AuthenticatedUser } from "../auth/auth.types";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import { ApiKeyService } from "./api-key.service";
import { ApiKeyUsageService } from "./api-key-usage.service";
import { ApiKeyUsageSummaryDto } from "./dto/api-key-usage-summary.dto";
import { RecentAuthGuard, RequireRecentAuth } from "../common/guards/recent-auth.guard";
import { RecentAuthService, DESTRUCTIVE_ACTIONS } from "../auth/recent-auth.service";
import { PrismaService } from "../database/prisma.service";
import {
  CreateApiKeyDto,
  ListApiKeysQueryDto,
  OrganizationApiKeysQueryDto,
} from "./dto/api-key-request.dto";
import {
  ApiKeyQuotaResponseDto,
  SetApiKeyQuotasDto,
} from "./dto/api-key-quota.dto";
import { ApiKeyQuotaService } from "./api-key-quota.service";
import { ApiKeyRotationService } from "./api-key-rotation.service";
import {
  CutoverApiKeyDto,
  RevokeApiKeyDto,
  RotateApiKeyDto,
} from "./dto/rotate-api-key.dto";

/**
 * API Keys Controller - Machine-to-machine integration credential management.
 *
 * Access control:
 * - All endpoints require wallet authentication (AuthGuard) + organization admin role
 * - Organization isolation enforced at query level (cannot manage other orgs' keys)
 * - Organization admin currently means global ADMIN or organization creator.
 *   Multi-admin memberships require a future OrganizationMember model.
 *
 * Response behavior:
 * - Creation: returns raw secret EXACTLY ONCE (never retrievable again)
 * - Listing: returns metadata only (id, prefix, name, status, scopes, dates)
 * - Rotation: returns new raw secret EXACTLY ONCE, invalidates old secret immediately
 * - Revocation: marks key REVOKED, takes effect immediately (no cache window)
 *
 * One-time secret display:
 * - Clients must save the returned secret immediately
 * - No code path allows retrieving or reconstructing the secret later
 * - If secret is lost, client must rotate the key to get a new one
 */
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@AuthenticatedRoute({ roles: ["ADMIN"] })
@ApiTags("api-keys")
@UseGuards(AuthGuard)
@Controller("api-keys")
export class ApiKeysController {
  private readonly apiKeyQuotaService: ApiKeyQuotaService;
  private readonly recentAuthService: RecentAuthService;
  private readonly prisma: PrismaService;
  private readonly apiKeyRotationService?: ApiKeyRotationService;

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly apiKeyUsageService: ApiKeyUsageService,
    @Optional() quotaOrRecentAuth?: ApiKeyQuotaService | RecentAuthService,
    @Optional() recentAuthOrPrisma?: RecentAuthService | PrismaService,
    @Optional() prisma?: PrismaService,
    @Optional() apiKeyRotationService?: ApiKeyRotationService,
  ) {
    if (quotaOrRecentAuth && typeof (quotaOrRecentAuth as any).consume === "function") {
      this.recentAuthService = quotaOrRecentAuth as RecentAuthService;
      this.prisma = recentAuthOrPrisma as PrismaService;
      this.apiKeyQuotaService = {
        getKeyQuotas: async () => [],
        setQuotaConfig: async () => undefined,
        getQuotaConfig: async () => ({
          quotaLimit: null,
          windowSeconds: 3600,
          isUnlimited: true,
          isDisabled: false,
        }),
        deleteKeyQuotas: async () => undefined,
      } as never;
      this.apiKeyRotationService = (apiKeyRotationService ?? prisma) as unknown as ApiKeyRotationService;
    } else {
      this.apiKeyQuotaService = (quotaOrRecentAuth as ApiKeyQuotaService) ?? ({
        getKeyQuotas: async () => [],
        setQuotaConfig: async () => undefined,
        getQuotaConfig: async () => ({
          quotaLimit: null,
          windowSeconds: 3600,
          isUnlimited: true,
          isDisabled: false,
        }),
        deleteKeyQuotas: async () => undefined,
      } as never);
      this.recentAuthService = recentAuthOrPrisma as RecentAuthService;
      this.prisma = prisma as PrismaService;
      this.apiKeyRotationService = apiKeyRotationService;
    }
  }

  /**
   * Create a new API key for an organization.
   *
   * Authorization: Organization admin only
   * Returns: Raw secret (display ONCE), key metadata
   * Note: Secret is never stored again; must be saved by client
   */
  @Post()
  @ApiOperation({
    summary: "Create a new API key",
    description:
      "Generate a new API key for machine-to-machine integrations. The raw secret is returned exactly once and cannot be retrieved later.",
  })
  @ApiResponse({
    status: 201,
    description: "API key created successfully",
    schema: {
      example: {
        secret: "dGVzdGtleTAx_[...base64url encrypted key...]",
        apiKey: {
          id: "key_abc123",
          prefix: "dGVzdGtl",
          name: "GitHub CI",
          status: "ACTIVE",
          scopes: ["PROOF_VERIFY", "PAYMENT_READ"],
          createdAt: "2026-08-24T12:00:00Z",
          expiresAt: null,
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Session token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      "The caller is not an administrator of the organization named in the request.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "`expiresAt` is not in the future, or `scopes` names a scope that does not exist.",
    type: ApiErrorDto,
  })
  async createKey(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: CreateApiKeyDto,
  ) {
    // Authorization: User must be organization admin
    const organizationId = await this.getAuthorizedOrganizationId(
      user,
      body.organizationId,
    );
    if (!organizationId) {
      throw new ForbiddenException(
        "Only organization admins can create API keys. You must be the organization creator or an admin member.",
      );
    }

    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;
    if (expiresAt && expiresAt <= new Date()) {
      throw new BadRequestException("expiresAt must be in the future");
    }

    // Validate scopes if provided
    if (body.scopes) {
      const validScopes = Object.values(ApiKeyScope);
      for (const scope of body.scopes) {
        if (!validScopes.includes(scope)) {
          throw new BadRequestException(`Invalid scope: ${scope}`);
        }
      }
    }

    const result = await this.apiKeyService.createKey({
      organizationId,
      createdBy: user.id,
      name: body.name,
      scopes: body.scopes,
      expiresAt,
    });

    // Important: return includes the raw secret exactly once
    return {
      secret: result.secret,
      apiKey: result.apiKey,
    };
  }

  /**
   * List API keys for user's organization.
   *
   * Authorization: Organization admin only
   * Returns: Metadata only (never includes secrets or hashes)
   */
  @Get()
  @ApiOperation({
    summary: "List API keys for your organization",
    description:
      "A cursor-paginated, deterministically ordered page of API keys for your " +
      "organization (metadata only, no secrets). Pass `pageInfo.nextCursor` from a " +
      "response as the next request's `cursor`.",
  })
  @ApiResponse({
    status: 200,
    description: "A page of API keys, plus pagination metadata.",
    schema: {
      example: {
        data: [
          {
            id: "key_abc123",
            prefix: "dGVzdGtl",
            name: "GitHub CI",
            status: "ACTIVE",
            scopes: ["PROOF_VERIFY", "PAYMENT_READ"],
            createdAt: "2026-08-24T12:00:00Z",
            rotatedAt: null,
            revokedAt: null,
            expiresAt: null,
            lastUsedAt: "2026-08-24T13:30:00Z",
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Session token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      "The caller is not an administrator of the organization named in the request.",
    type: ApiErrorDto,
  })
  async listKeys(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListApiKeysQueryDto = {},
  ) {
    // Authorization: User must be organization admin
    const organizationId = await this.getAuthorizedOrganizationId(
      user,
      query.organizationId,
      { allowArchived: true },
    );
    if (!organizationId) {
      throw new ForbiddenException(
        "Only organization admins can list API keys. You must be the organization creator or an admin member.",
      );
    }

    const { data, pageInfo } = await this.apiKeyService.listKeysForOrganization(
      organizationId,
      { cursor: query.cursor, limit: query.limit },
    );

    return {
      data: data.map((key) => ({
        id: key.id,
        prefix: key.prefix,
        name: key.name,
        status: key.status,
        scopes: key.scopeAssignments.map((sa) => sa.scope),
        createdAt: key.createdAt,
        rotatedAt: key.rotatedAt,
        revokedAt: key.revokedAt,
        expiresAt: key.expiresAt,
        lastUsedAt: key.lastUsedAt,
      })),
      pageInfo,
    };
  }

  /**
   * Rotate an API key: generate new secret, invalidate old immediately.
   *
   * Authorization: Organization admin only
   * Returns: New raw secret (display ONCE), updated key metadata
   * Effect: Old secret stops working immediately
   */
  @Post(":id/rotate")
  @ApiOperation({
    summary: "Rotate an API key",
    description:
      "Generate a new secret for an existing API key. The old secret is invalidated immediately and can never be used again.",
  })
  @ApiResponse({
    status: 200,
    description: "API key rotated successfully",
    schema: {
      example: {
        secret: "bmV3c2VjcmV0MDEy_[...base64url encrypted key...]",
        apiKey: {
          id: "key_abc123",
          prefix: "bmV3c2Vj",
          name: "GitHub CI",
          status: "ACTIVE",
          scopes: ["PROOF_VERIFY", "PAYMENT_READ"],
          rotatedAt: "2026-08-24T14:00:00Z",
        },
      },
    },
  })
  @ApiParam({
    name: "id",
    description: "API key to rotate.",
    example: "ckv8v6h2b0000qzrmn831i7rn",
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Session token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      "The caller is not an administrator of the organization, or the key belongs " +
      "to another organization. The two answer alike so the response cannot be " +
      "used to discover which key identifiers exist.",
    type: ApiErrorDto,
  })
  async rotateKey(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") keyId: string,
    @Query() query: OrganizationApiKeysQueryDto = {},
    @Body() body?: RotateApiKeyDto,
  ) {
    // Authorization: User must be organization admin
    const organizationId = await this.getAuthorizedOrganizationId(
      user,
      query.organizationId,
    );
    if (!organizationId) {
      throw new ForbiddenException(
        "Only organization admins can rotate API keys. You must be the organization creator or an admin member.",
      );
    }

    // Verify the key belongs to this organization (enforced by service)
    try {
      const result = body
        ? await this.apiKeyService.rotateKey(keyId, organizationId, user.id, body)
        : await this.apiKeyService.rotateKey(keyId, organizationId, user.id);

      // Important: return includes the new raw secret exactly once
      return {
        secret: result.secret,
        apiKey: result.apiKey,
        rotationId: result.rotationId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("does not belong to this organization")
      ) {
        throw new ForbiddenException(
          "API key does not belong to your organization",
        );
      }
      throw error;
    }
  }

  /**
   * Inspect an API key rotation family and overlap status.
   * Requires recent authentication assertion.
   */
  @Get(":id/rotation")
  @UseGuards(RecentAuthGuard)
  @RequireRecentAuth(DESTRUCTIVE_ACTIONS.KEY_INSPECT)
  @ApiOperation({
    summary: "Inspect an API key rotation family",
    description:
      "Inspect the active rotation status, overlap deadlines, and old-key usage for an API key family.",
  })
  @ApiParam({
    name: "id",
    description: "API key ID to inspect rotation status for.",
  })
  @ApiResponse({
    status: 200,
    description: "Rotation family status retrieved successfully",
  })
  async inspectRotation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") keyId: string,
    @Query() query: OrganizationApiKeysQueryDto = {},
  ) {
    const organizationId = await this.getAuthorizedOrganizationId(
      user,
      query.organizationId,
    );
    if (!organizationId) {
      throw new ForbiddenException(
        "Only organization admins can inspect API key rotation status.",
      );
    }

    if (!this.apiKeyRotationService) {
      throw new NotFoundException("Rotation service not configured");
    }

    return this.apiKeyRotationService.inspectRotation(keyId, organizationId);
  }

  /**
   * Perform early cutover for an API key rotation, terminating the overlap period immediately.
   * Requires recent authentication assertion.
   */
  @Post(":id/cutover")
  @UseGuards(RecentAuthGuard)
  @RequireRecentAuth(DESTRUCTIVE_ACTIONS.KEY_CUTOVER)
  @ApiOperation({
    summary: "Perform early cutover for an API key rotation",
    description:
      "Immediately end the overlap period for an API key rotation and produce an immutable cutover receipt.",
  })
  @ApiParam({
    name: "id",
    description: "API key ID to cut over.",
  })
  @ApiResponse({
    status: 200,
    description: "API key rotation successfully cut over",
  })
  async earlyCutover(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") keyId: string,
    @Query() query: OrganizationApiKeysQueryDto = {},
    @Req() req?: Request,
    @Body() body?: CutoverApiKeyDto,
  ) {
    void body;
    const organizationId = await this.getAuthorizedOrganizationId(
      user,
      query.organizationId,
    );
    if (!organizationId) {
      throw new ForbiddenException(
        "Only organization admins can execute API key cutover.",
      );
    }

    if (req) {
      const assertionToken = String(req.headers?.["x-recent-auth"] ?? "");
      const origin = String(req.headers?.["origin"] ?? "null");
      if (assertionToken) {
        await this.recentAuthService.consume({
          token: assertionToken,
          action: DESTRUCTIVE_ACTIONS.KEY_CUTOVER,
          resourceId: keyId,
          origin,
        });
      }
    }

    if (!this.apiKeyRotationService) {
      throw new NotFoundException("Rotation service not configured");
    }

    return this.apiKeyRotationService.earlyCutover(keyId, organizationId, user.id);
  }

  /**
   * Revoke an API key: mark as revoked, take effect immediately.
   *
   * Authorization: Organization admin only
   * Returns: 204 No Content
   * Effect: Revoked key is rejected by auth guard immediately
   */
  @UseGuards(RecentAuthGuard)
  @RequireRecentAuth(DESTRUCTIVE_ACTIONS.KEY_REVOKE)
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Revoke an API key",
    description:
      "Revoke an API key. The key is immediately rejected by the authentication system.",
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: "API key revoked successfully",
  })
  @ApiParam({
    name: "id",
    description: "API key to revoke.",
    example: "ckv8v6h2b0000qzrmn831i7rn",
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Session token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      "The caller is not an administrator of the organization, the key belongs to " +
      "another organization, or no such key exists.",
    type: ApiErrorDto,
  })
  async revokeKey(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") keyId: string,
    @Query() query: OrganizationApiKeysQueryDto = {},
    @Req() req?: Request,
    @Body() body?: RevokeApiKeyDto,
  ) {
    const assertionToken = req ? String(req.headers?.["x-recent-auth"] ?? "") : undefined;
    const origin = req ? String(req.headers?.["origin"] ?? "null") : undefined;
    await this.revokeAuthorizedKey(user, keyId, query, assertionToken, origin, body?.reason);
  }

  @Delete(":id/revoke")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiExcludeEndpoint()
  async revokeKeyLegacy(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") keyId: string,
    @Query() query: OrganizationApiKeysQueryDto = {},
    @Req() req?: Request,
    @Body() body?: RevokeApiKeyDto,
  ) {
    const assertionToken = req ? String(req.headers?.["x-recent-auth"] ?? "") : undefined;
    const origin = req ? String(req.headers?.["origin"] ?? "null") : undefined;
    await this.revokeAuthorizedKey(user, keyId, query, assertionToken, origin, body?.reason);
  }

  private async revokeAuthorizedKey(
    user: AuthenticatedUser,
    keyId: string,
    query: OrganizationApiKeysQueryDto,
    assertionToken?: string,
    origin?: string,
    reason?: string,
  ) {
    // Consume the recent-auth assertion (single-use) if provided.
    if (assertionToken) {
      await this.recentAuthService.consume({
        token: assertionToken,
        action: DESTRUCTIVE_ACTIONS.KEY_REVOKE,
        resourceId: keyId,
        origin: origin ?? "null",
      });
    }
    // Authorization: User must be organization admin
    const organizationId = await this.getAuthorizedOrganizationId(
      user,
      query.organizationId,
      { allowArchived: true },
    );
    if (!organizationId) {
      throw new ForbiddenException(
        "Only organization admins can revoke API keys. You must be the organization creator or an admin member.",
      );
    }

    // Verify the key belongs to this organization (enforced by service)
    try {
      if (reason) {
        await this.apiKeyService.revokeKey(
          keyId,
          organizationId,
          user.id, // Pass actor for audit logging
          { reason },
        );
      } else {
        await this.apiKeyService.revokeKey(
          keyId,
          organizationId,
          user.id, // Pass actor for audit logging
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Key not found")) {
        throw new ForbiddenException("API key not found");
      }
      if (
        error instanceof Error &&
        error.message.includes("does not belong to this organization")
      ) {
        throw new ForbiddenException(
          "API key does not belong to your organization",
        );
      }
      throw error;
    }
  }

  /**
   * Get usage summary for an API key.
   *
   * Authorization: Organization admin only
   * Returns: Privacy-safe usage breakdown by category and outcome
   */
  @Get(":id/usage")
  @ApiOperation({
    summary: "Get usage summary for an API key",
    description:
      "Returns a privacy-safe usage breakdown by endpoint category and outcome. " +
      "Never includes IP addresses, request bodies, path parameters, or user-agent strings. " +
      "For revoked keys, returns the final frozen snapshot at time of revocation.",
  })
  @ApiParam({ name: "id", description: "API key ID.", example: "ckv8v6h2b0000qzrmn831i7rn" })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Usage summary for the key.",
    type: ApiKeyUsageSummaryDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Session token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "The caller is not an administrator of the organization the key belongs to.",
    type: ApiErrorDto,
  })
  async getKeyUsage(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") keyId: string,
    @Query() query: OrganizationApiKeysQueryDto = {},
  ): Promise<ApiKeyUsageSummaryDto> {
    const organizationId = await this.getAuthorizedOrganizationId(user, query.organizationId);
    if (!organizationId) {
      throw new ForbiddenException(
        "Only organization admins can view API key usage.",
      );
    }

    // Verify the key belongs to this organization before returning usage data.
    const key = await this.prisma.apiKey.findFirst({
      where: { id: keyId, organizationId },
      select: { id: true },
    });
    if (!key) {
      throw new ForbiddenException("API key not found");
    }

    const buckets = await this.apiKeyUsageService.getSummary(keyId);

    const totalRequests = buckets.reduce(
      (sum, b) => sum + Number(b.requestCount),
      0,
    );

    return {
      keyId,
      buckets: buckets.map((b) => ({
        category: b.category,
        outcome: b.outcome,
        requestCount: Number(b.requestCount),
        lastUsedAt: b.lastUsedAt?.toISOString() ?? null,
        revokedSummaryFrozenAt: b.revokedSummaryFrozenAt?.toISOString() ?? null,
      })),
      totalRequests,
    };
  }

  /**
   * Get quota configurations for an API key.
   *
   * Authorization: Organization admin only
   * Returns: All quota configurations for the key
   */
  @Get(":id/quotas")
  @ApiOperation({
    summary: "Get quota configurations for an API key",
    description: "Returns all quota configurations for the specified API key, organized by scope.",
  })
  @ApiParam({ name: "id", description: "API key ID.", example: "ckv8v6h2b0000qzrmn831i7rn" })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Quota configurations for the key.",
    type: [ApiKeyQuotaResponseDto],
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Session token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "The caller is not an administrator of the organization the key belongs to.",
    type: ApiErrorDto,
  })
  async getKeyQuotas(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") keyId: string,
    @Query() query: OrganizationApiKeysQueryDto = {},
  ): Promise<ApiKeyQuotaResponseDto[]> {
    const organizationId = await this.getAuthorizedOrganizationId(user, query.organizationId);
    if (!organizationId) {
      throw new ForbiddenException(
        "Only organization admins can view API key quotas.",
      );
    }

    // Verify the key belongs to this organization
    const key = await this.prisma.apiKey.findFirst({
      where: { id: keyId, organizationId },
      select: { id: true },
    });
    if (!key) {
      throw new ForbiddenException("API key not found");
    }

    const quotas = await this.apiKeyQuotaService.getKeyQuotas(keyId);

    return quotas.map((quota) => ({
      scope: quota.scope,
      quotaLimit: quota.quotaLimit,
      windowSeconds: quota.windowSeconds,
      updatedAt: quota.updatedAt,
      isUnlimited: quota.quotaLimit === null,
      isDisabled: quota.quotaLimit === 0,
    }));
  }

  /**
   * Set quota configurations for an API key.
   *
   * Authorization: Organization admin only
   * Effect: Updates quota configurations, overwriting existing settings
   */
  @Post(":id/quotas")
  @ApiOperation({
    summary: "Set quota configurations for an API key",
    description: "Set or update quota configurations for the specified API key. Existing quotas for specified scopes are overwritten.",
  })
  @ApiParam({ name: "id", description: "API key ID.", example: "ckv8v6h2b0000qzrmn831i7rn" })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Quota configurations updated successfully.",
    type: [ApiKeyQuotaResponseDto],
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Invalid quota configuration (e.g., negative limits, invalid scope).",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Session token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "The caller is not an administrator of the organization the key belongs to.",
    type: ApiErrorDto,
  })
  async setKeyQuotas(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") keyId: string,
    @Body() body: SetApiKeyQuotasDto,
    @Query() query: OrganizationApiKeysQueryDto = {},
  ): Promise<ApiKeyQuotaResponseDto[]> {
    const organizationId = await this.getAuthorizedOrganizationId(user, query.organizationId);
    if (!organizationId) {
      throw new ForbiddenException(
        "Only organization admins can set API key quotas.",
      );
    }

    // Verify the key belongs to this organization
    const key = await this.prisma.apiKey.findFirst({
      where: { id: keyId, organizationId },
      select: { id: true },
    });
    if (!key) {
      throw new ForbiddenException("API key not found");
    }

    // Validate scopes
    const validScopes = Object.values(ApiKeyScope);
    for (const quotaConfig of body.quotas) {
      if (!validScopes.includes(quotaConfig.scope)) {
        throw new BadRequestException(`Invalid scope: ${quotaConfig.scope}`);
      }
      if (quotaConfig.windowSeconds < 60) {
        throw new BadRequestException("Window must be at least 60 seconds");
      }
    }

    // Update quota configurations
    for (const quotaConfig of body.quotas) {
      await this.apiKeyQuotaService.setQuotaConfig(
        keyId,
        quotaConfig.scope,
        quotaConfig.quotaLimit,
        quotaConfig.windowSeconds,
      );
    }

    // Return updated configurations
    const quotas = await this.apiKeyQuotaService.getKeyQuotas(keyId);

    return quotas.map((quota) => ({
      scope: quota.scope,
      quotaLimit: quota.quotaLimit,
      windowSeconds: quota.windowSeconds,
      updatedAt: quota.updatedAt,
      isUnlimited: quota.quotaLimit === null,
      isDisabled: quota.quotaLimit === 0,
    }));
  }

  /**
   * Helper: Get user's primary organization ID and verify admin access.
   *
   * Returns the organization ID if the user is an admin of the requested
   * organization. If no organization was requested, it only infers one when
   * exactly one manageable organization exists.
   * In this codebase, organization admin is determined by:
   * - User created the organization (createdById == userId), OR
   * - User has ADMIN role (global admin has access to all orgs)
   *
   * @returns organizationId if authorized as admin, null otherwise
   */
  private async getAuthorizedOrganizationId(
    user: AuthenticatedUser,
    requestedOrganizationId?: string,
    options: { allowArchived?: boolean } = {},
  ): Promise<string | null> {
    const accessWhere =
      user.role === "ADMIN" ? {} : { createdById: user.id };

    if (requestedOrganizationId) {
      const org = await this.prisma.organization.findFirst({
        where: {
          id: requestedOrganizationId,
          deletedAt: null,
          ...accessWhere,
        },
        select: {
          id: true,
          archivedAt: true,
        },
      });

      return this.usableOrganizationId(org, options);
    }

    const organizations = await this.prisma.organization.findMany({
      where: { deletedAt: null, ...accessWhere },
      select: {
        id: true,
        archivedAt: true,
      },
      orderBy: {
        createdAt: "asc",
      },
      take: 2,
    });

    if (organizations.length === 0) return null;
    if (organizations.length === 1) {
      return this.usableOrganizationId(organizations[0], options);
    }

    throw new BadRequestException(
      "organizationId is required when you can manage more than one organization",
    );
  }

  /**
   * An archived organization may still list and revoke its keys, so it can be
   * wound down, but may not issue or rotate one.
   */
  private usableOrganizationId(
    org: { id: string; archivedAt?: Date | null } | null | undefined,
    options: { allowArchived?: boolean },
  ): string | null {
    if (!org) return null;
    if (org.archivedAt && !options.allowArchived) {
      throw new ConflictException(
        "Organization is archived; API keys cannot be issued or rotated",
      );
    }
    return org.id;
  }
}
