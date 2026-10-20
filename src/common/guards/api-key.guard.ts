import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiKeyUsageOutcome } from "@prisma/client";
import { Request } from "express";
import { ApiKeyService } from "../../api-keys/api-key.service";
import { ApiKeyUsageService } from "../../api-keys/api-key-usage.service";
import { ApiKeyContext } from "../../api-keys/api-key.types";

/**
 * API Key Authentication Guard
 *
 * Authenticates requests bearing an API key in the Authorization header.
 * Format: Authorization: Bearer <key>
 *
 * Usage recording:
 *   recordUsage() is called WITHOUT await after authentication succeeds.
 *   This ensures usage tracking never adds latency to request authorisation.
 *   Only SUCCESS is recorded here; FORBIDDEN is the responsibility of
 *   ScopesGuard if scope checks are needed.
 *
 * Response strategy (stable failure responses):
 * - All authentication failures return 401 Unauthorized.
 * - Uniform response masks whether the key doesn't exist, is revoked, or expired.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly apiKeyUsageService: ApiKeyUsageService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { apiKeyContext?: ApiKeyContext }>();

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Invalid API key");
    }

    const presentedKey = authHeader.slice("Bearer ".length);

    if (!/^[A-Za-z0-9_-]{43}$/.test(presentedKey)) {
      throw new UnauthorizedException("Invalid API key");
    }

    const prefix = presentedKey.substring(0, 8);

    const organizationId = this.extractOrganizationId(request);
    if (!organizationId) {
      throw new UnauthorizedException("Invalid API key");
    }

    try {
      const apiKey = await this.apiKeyService.lookupAndVerifyKey(
        prefix,
        presentedKey,
        organizationId,
      );

      if (!apiKey) {
        throw new UnauthorizedException("Invalid API key");
      }

      const apiKeyContext: ApiKeyContext = {
        keyId: apiKey.id,
        prefix: apiKey.prefix,
        organizationId: apiKey.organizationId,
        scopes: apiKey.scopeAssignments.map((sa) => sa.scope),
        createdAt: apiKey.createdAt,
      };

      request.apiKeyContext = apiKeyContext;

      // Fire-and-forget: do NOT await. Usage tracking must never delay auth.
      const category = ApiKeyUsageService.categoryFromPath(
        request.path ?? request.url ?? "/",
      );
      void this.apiKeyUsageService.recordUsage(
        apiKey.id,
        category,
        ApiKeyUsageOutcome.SUCCESS,
      );

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException("Invalid API key");
    }
  }

  private extractOrganizationId(request: Request): string | null {
    const orgIdHeader = request.headers["x-organization-id"];
    if (typeof orgIdHeader === "string") {
      return orgIdHeader;
    }
    return null;
  }
}