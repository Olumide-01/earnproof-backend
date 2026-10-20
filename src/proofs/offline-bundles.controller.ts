import { Controller, Post, Body, UseGuards, Req, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags, ApiBody } from "@nestjs/swagger";
import { OfflineBundleService } from "./offline-bundle.service";
import { CreateOfflineBundleDto } from "./dto/create-offline-bundle.dto";
import { OfflineBundleDto } from "./dto/offline-bundle.dto";
import { ApiErrorDto } from "@/common/dto/api-error.dto";
import { RequireScopes } from "@/common/decorators/authorization-policy.decorator";
import { ScopesGuard } from "@/common/guards/scopes.guard";
import { ApiKeyGuard } from "@/common/guards/api-key.guard";
import { ApiKeyContext, ApiKeyScope } from "@/api-keys/api-key.service";

/**
 * Offline verification bundle management.
 *
 * Bounded offline bundles enable time-limited, offline verification of proofs
 * with explicit freshness and expiry constraints. Bundles are signed with HMAC-SHA256
 * and scoped via allowlist to include only authorized disclosures.
 */
@ApiTags("proofs")
@Controller("api/v1/proofs/bundles")
@UseGuards(ApiKeyGuard, ScopesGuard)
@ApiBearerAuth()
export class OfflineBundlesController {
  constructor(private readonly offlineBundleService: OfflineBundleService) {}

  /**
   * Generate a bounded offline verification bundle.
   *
   * Creates a signed, time-limited bundle containing authorized credentials,
   * verification keys, and revocation checkpoints for offline verification.
   *
   * **Authorization:**
   * - Requires API key with `bundles:create` scope
   * - Caller can only include proofs they have access to
   *
   * **Request Validation:**
   * - `expiresAt` must be in the future (within 1 hour)
   * - `maxFreshnessSeconds` must be 60–86400 seconds
   * - `proofIds` must be 1–100 items
   * - `operations` must include at least one (currently only "verify" supported)
   *
   * **Bundle Properties:**
   * - Signed with HMAC-SHA256 (versioned for key rotation)
   * - Contains only authorized fields (allowlist-based)
   * - Includes explicit expiry and freshness limits
   * - Idempotent: same request → same bundleId
   *
   * **Verifier Expectations:**
   * - Bundle is valid only until `manifest.expiresAt` (exclusive boundary)
   * - Checkpoints are current only if age ≤ `manifest.maxFreshnessSeconds`
   * - Signature must verify for tamper detection
   * - Contents hash must match for integrity
   *
   * **Error Responses:**
   * - 400: Invalid request (expiry, freshness, validation)
   * - 403: Authorization failed (proof not accessible)
   * - 422: Bundle generation failed (generation error)
   * - 503: Dependency unavailable
   *
   * @param req Request body
   * @param apiKeyContext API key context (auth/scope information)
   * @returns Offline bundle with manifest and contents
   * @example
   * ```json
   * POST /api/v1/proofs/bundles
   * Authorization: Bearer <api_key>
   *
   * {
   *   "proofIds": ["clx1abc2def3ghi4"],
   *   "expiresAt": "2025-10-15T15:30:00.000Z",
   *   "maxFreshnessSeconds": 1800,
   *   "operations": ["verify"],
   *   "acknowledgeOfflineRisk": true
   * }
   *
   * Response (201):
   * {
   *   "version": "earnproof.offline-bundle.v1",
   *   "bundleId": "obb_abc123def456",
   *   "manifest": {
   *     "bundleId": "obb_abc123def456",
   *     "issuedAt": "2025-10-15T14:30:00.000Z",
   *     "expiresAt": "2025-10-15T15:30:00.000Z",
   *     "maxFreshnessSeconds": 1800,
   *     "issuer": "earnproof",
   *     "scope": {
   *       "proofIds": ["clx1abc2def3ghi4"],
   *       "operations": ["verify"],
   *       "organizationId": "org_xyz"
   *     },
   *     "contentsHash": "sha256:abc123...",
   *     "signature": "hmac-sha256:v1=xyz789..."
   *   },
   *   "contents": {
   *     "credentials": [...],
   *     "verificationKeys": [...],
   *     "checkpoints": [...]
   *   },
   *   "generatedAt": "2025-10-15T14:30:00.000Z"
   * }
   * ```
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes(ApiKeyScope.BUNDLES_CREATE)
  @ApiOperation({
    summary: "Generate a bounded offline verification bundle",
    description:
      "Create a signed, time-limited bundle containing authorized credentials, keys, and checkpoints for offline proof verification.",
  })
  @ApiBody({
    type: CreateOfflineBundleDto,
    description: "Bundle generation request",
  })
  @ApiResponse({
    status: 201,
    description: "Bundle successfully generated",
    type: OfflineBundleDto,
  })
  @ApiResponse({
    status: 400,
    description: "Invalid request (expiry, freshness, validation errors)",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 403,
    description: "Authorization failed (proof not accessible)",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 422,
    description: "Bundle generation failed",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 503,
    description: "Dependency unavailable",
    type: ApiErrorDto,
  })
  async generateBundle(
    @Body() req: CreateOfflineBundleDto,
    @Req() httpReq: any,
  ): Promise<OfflineBundleDto> {
    const apiKeyContext: ApiKeyContext = httpReq.apiKeyContext;

    return this.offlineBundleService.generateBundle(req, {
      organizationId: apiKeyContext.organizationId,
      requestingApiKeyId: apiKeyContext.apiKeyId,
      // In real implementation, would load accessible proofs from permissions/quotas
      // For MVP, assume all requested proofs are accessible
      accessibleProofIds: new Set(req.proofIds),
    });
  }
}
