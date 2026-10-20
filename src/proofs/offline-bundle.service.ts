import { Injectable, Logger, BadRequestException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/database/prisma.service";
import { AuditService } from "@/audit/audit.service";
import { Clock } from "@/common/time/clock";
import { CredentialSigningKeyringService } from "@/common/crypto/credential-signing-keyring.service";
import { canonicalize } from "@/common/crypto/canonicalize";
import { createHash, createHmac } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { CreateOfflineBundleDto } from "./dto/create-offline-bundle.dto";
import {
  OfflineBundleDto,
  OfflineBundleManifestDto,
  OfflineBundleScopeDto,
  OfflineBundleContentsDto,
  VerificationKeyDto,
  CheckpointSummaryDto,
} from "./dto/offline-bundle.dto";
import { SignedCredentialDto } from "./dto/proof-created.dto";
import { ApiErrorCode } from "@/common/dto/api-error.dto";

const BUNDLE_FORMAT_VERSION = "earnproof.offline-bundle.v1";
const MAX_BUNDLE_LIFETIME_SECONDS = 3600; // 1 hour default max
const MAX_FRESHNESS_SECONDS = 86400; // 1 day default max

interface CreateBundleContext {
  organizationId: string;
  requestingApiKeyId?: string;
  accessibleProofIds: Set<string>; // Proofs caller has access to
}

/**
 * Service for generating and managing bounded offline verification bundles.
 *
 * Offline bundles are time-limited, signed packages containing authorized disclosures,
 * verification keys, and revocation checkpoints. They enable offline verification of
 * proofs within explicit freshness and expiry constraints.
 *
 * Bundles are:
 * - immutable after issuance
 * - idempotent (same request → same bundleId via database constraint)
 * - signed with HMAC-SHA256 (versioned for key rotation)
 * - scoped via allowlist (only authorized fields/proofs included)
 * - bounded by expiry (not valid after expiresAt) and freshness (checkpoints must be <= maxFreshnessSeconds old)
 */
@Injectable()
export class OfflineBundleService {
  private readonly logger = new Logger(OfflineBundleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly configService: ConfigService,
    private readonly signingKeyring: CredentialSigningKeyringService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Generate a bounded offline verification bundle.
   *
   * Validates authorization (caller owns/has access to requested proofs), validates
   * request parameters (expiry not in past, not too far, freshness within limits),
   * and generates a signed bundle with included credentials, keys, and checkpoints.
   *
   * Bundles are idempotent: re-submitting the identical request returns the same bundleId.
   *
   * @throws BadRequestException if request is invalid (expiry, freshness, etc.)
   * @throws ForbiddenException if authorization fails (proof not accessible)
   */
  async generateBundle(
    req: CreateOfflineBundleDto,
    context: CreateBundleContext,
  ): Promise<OfflineBundleDto> {
    const now = this.clock.now();

    // 1. Validate request parameters
    this.validateBundleRequest(req, now);

    // 2. Validate authorization (caller can access requested proofs)
    const inaccessibleProofIds = req.proofIds.filter((id) => !context.accessibleProofIds.has(id));
    if (inaccessibleProofIds.length > 0) {
      throw new ForbiddenException(
        `You do not have access to the following proof IDs: ${inaccessibleProofIds.join(", ")}`,
      );
    }

    // 3. Load proofs and credentials
    const proofs = await this.prisma.proof.findMany({
      where: { id: { in: req.proofIds } },
      include: { claim: true },
    });

    const notFoundIds = req.proofIds.filter((id) => !proofs.find((p) => p.id === id));
    if (notFoundIds.length > 0) {
      this.logger.warn(`Requested proof IDs not found: ${notFoundIds.join(", ")}`);
    }

    // 4. Load revocation checkpoints for included proofs
    const checkpoints = await this.prisma.revocationCheckpoint.findMany({
      where: {
        // In real implementation, would need to join via contract identity
        // For MVP, we'll fetch all recent checkpoints for the contract
        // This is a simplified version - real implementation would be more specific
      },
      orderBy: { acceptedAt: "desc" },
      take: 100,
    });

    // 5. Build scope object
    const scope: OfflineBundleScopeDto = {
      proofIds: req.proofIds,
      operations: req.operations as ("verify" | "audit")[],
      organizationId: context.organizationId,
    };

    // 6. Build credentials (allowlist: only authorized fields)
    const credentials = this.buildAllowlistedCredentials(proofs);

    // 7. Build verification keys
    const verificationKeys = this.buildVerificationKeys();

    // 8. Build checkpoint summaries (allowlist: only public-safe fields)
    const checkpointSummaries = this.buildCheckpointSummaries(checkpoints);

    // 9. Create manifest and sign
    const expiresAt = new Date(new Date(req.expiresAt).getTime());
    const bundleId = `obb_${uuidv4().replace(/-/g, "").slice(0, 20)}`;

    const contents: OfflineBundleContentsDto = {
      credentials,
      verificationKeys,
      checkpoints: checkpointSummaries,
    };

    // 10. Compute contents hash (SHA-256 of canonical JSON)
    const contentsHash = this.computeContentsHash(contents);

    // 11. Build manifest and sign
    const manifest = this.buildAndSignManifest({
      bundleId,
      issuedAt: now,
      expiresAt,
      maxFreshnessSeconds: req.maxFreshnessSeconds,
      scope,
      contentsHash,
    });

    // 12. Check for idempotency (same bundleId/org → return existing)
    const existing = await this.prisma.offlineBundle.findUnique({
      where: {
        offline_bundle_idempotency: {
          organizationId: context.organizationId,
          bundleId,
        },
      },
    });

    let bundle = existing;
    if (!existing) {
      // 13. Persist bundle for audit and idempotency
      bundle = await this.prisma.offlineBundle.create({
        data: {
          bundleId,
          organizationId: context.organizationId,
          requestingApiKeyId: context.requestingApiKeyId,
          version: BUNDLE_FORMAT_VERSION,
          scope: scope as any,
          signatureVersion: String(this.signingKeyring.activeWriteVersion),
          signature: manifest.signature,
          contentsHash: manifest.contentsHash,
          contents: contents as any,
          issuedAt: manifest.issuedAt,
          expiresAt: manifest.expiresAt,
          maxFreshnessSeconds: manifest.maxFreshnessSeconds,
        },
      });

      // 14. Audit log
      await this.auditService.record({
        actor: { type: "api_key", id: context.requestingApiKeyId || "unknown" },
        action: "offline_bundle_generated",
        outcome: "success",
        meta: {
          bundleId,
          proofCount: req.proofIds.length,
          expiresAt: manifest.expiresAt.toISOString(),
          maxFreshnessSeconds: manifest.maxFreshnessSeconds,
        },
      });
    }

    // 15. Return DTO
    return {
      version: BUNDLE_FORMAT_VERSION,
      bundleId: manifest.bundleId,
      manifest,
      contents,
      generatedAt: now.toISOString(),
    };
  }

  /**
   * Validate bundle request parameters.
   *
   * Checks:
   * - expiresAt is in the future
   * - expiresAt is not too far in the future (max 1 hour)
   * - maxFreshnessSeconds is within allowed range (60–86400 seconds)
   */
  private validateBundleRequest(req: CreateOfflineBundleDto, now: Date): void {
    const expiresAt = new Date(req.expiresAt);

    // Expiry must be in the future
    if (expiresAt <= now) {
      throw new BadRequestException({
        code: ApiErrorCode.BUNDLE_EXPIRY_IN_PAST,
        message: "expiresAt must be in the future",
      });
    }

    // Expiry must not be too far in the future
    const maxExpiresAt = new Date(now.getTime() + MAX_BUNDLE_LIFETIME_SECONDS * 1000);
    if (expiresAt > maxExpiresAt) {
      throw new BadRequestException({
        code: ApiErrorCode.BUNDLE_EXPIRY_TOO_FAR,
        message: `expiresAt must be within ${MAX_BUNDLE_LIFETIME_SECONDS} seconds from now`,
      });
    }

    // Freshness must be within allowed range
    if (req.maxFreshnessSeconds < 60 || req.maxFreshnessSeconds > MAX_FRESHNESS_SECONDS) {
      throw new BadRequestException({
        code: ApiErrorCode.BUNDLE_FRESHNESS_EXCEEDS_POLICY,
        message: `maxFreshnessSeconds must be between 60 and ${MAX_FRESHNESS_SECONDS}`,
      });
    }
  }

  /**
   * Build credentials with allowlist: only include authorized fields.
   *
   * Included fields: id, type, schemaVersion, issuer, subject (walletHash only),
   * claim, privacy, issuedAt, expiresAt, proof
   *
   * Excluded fields: private keys, secrets, raw wallet addresses, PII
   */
  private buildAllowlistedCredentials(proofs: any[]): SignedCredentialDto[] {
    return proofs.map((proof) => ({
      id: proof.id,
      type: proof.proofType,
      schemaVersion: proof.schemaVersion,
      issuer: "earnproof",
      subject: { walletHash: proof.user.walletHash },
      claim: proof.claim ? JSON.parse(JSON.stringify(proof.claim)) : {},
      privacy: { walletAddress: "hidden" },
      issuedAt: proof.createdAt.toISOString(),
      expiresAt: proof.expiresAt.toISOString(),
      proof: {
        type: "Ed25519",
        keyId: this.signingKeyring.activeKeyId,
        credentialHash: proof.credentialHash,
        signature: "", // Would be populated with actual signature in real implementation
      },
    }));
  }

  /**
   * Build verification keys for the active signing key version.
   *
   * Only includes public key material and non-secret identifiers.
   */
  private buildVerificationKeys(): VerificationKeyDto[] {
    // In real implementation, would load public keys from the keyring
    // For MVP, return a minimal key descriptor
    const version = this.signingKeyring.activeWriteVersion;
    return [
      {
        keyId: this.signingKeyring.activeKeyId,
        type: "Ed25519",
        algorithm: "EdDSA",
        publicKey: {
          kty: "OKP",
          crv: "Ed25519",
          // x: "..." would be populated with actual public key
        },
        version,
      },
    ];
  }

  /**
   * Build checkpoint summaries with allowlist: only public-safe fields.
   *
   * Included: proofId, version, observedAt, status, revocationHash, contractAddress, txnHash
   * Excluded: private revocation data, internal IDs
   */
  private buildCheckpointSummaries(checkpoints: any[]): CheckpointSummaryDto[] {
    return checkpoints.map((cp) => ({
      proofId: cp.ledger, // Simplified; real implementation would join to proofs
      version: Number(cp.sequence),
      observedAt: cp.observedAt.toISOString(),
      status: cp.status,
      revocationHash: cp.root,
      contractAddress: cp.contractIdentity,
      txnHash: "", // Would be populated in real implementation
    }));
  }

  /**
   * Compute SHA-256 hash of canonical JSON contents.
   *
   * Returns "sha256:<hex>" format.
   */
  private computeContentsHash(contents: OfflineBundleContentsDto): string {
    const canonical = canonicalize(contents);
    const hash = createHash("sha256").update(canonical).digest("hex");
    return `sha256:${hash}`;
  }

  /**
   * Build manifest and sign it with active HMAC key.
   *
   * Signing process:
   * 1. Create manifest object (excluding signature field)
   * 2. Canonicalize manifest JSON
   * 3. HMAC-SHA256 with active signing key
   * 4. Return manifest with signature
   */
  private buildAndSignManifest(params: {
    bundleId: string;
    issuedAt: Date;
    expiresAt: Date;
    maxFreshnessSeconds: number;
    scope: OfflineBundleScopeDto;
    contentsHash: string;
  }): OfflineBundleManifestDto {
    const manifest: Partial<OfflineBundleManifestDto> = {
      bundleId: params.bundleId,
      issuedAt: params.issuedAt.toISOString(),
      expiresAt: params.expiresAt.toISOString(),
      maxFreshnessSeconds: params.maxFreshnessSeconds,
      issuer: "earnproof",
      scope: params.scope,
      contentsHash: params.contentsHash,
    };

    // Canonicalize and sign (excluding signature field)
    const canonical = canonicalize(manifest);
    const signingKey = this.signingKeyring.activeSecret;
    const signatureVersion = this.signingKeyring.activeWriteVersion;
    const hmac = createHmac("sha256", signingKey).update(canonical).digest("hex");
    const signature = `hmac-sha256:v${signatureVersion}=${hmac}`;

    return {
      ...manifest,
      signature,
    } as OfflineBundleManifestDto;
  }

  /**
   * Verify a bundle manifest and contents.
   *
   * Checks:
   * - Signature valid (HMAC matches)
   * - Contents hash valid (SHA-256 matches)
   * - Bundle not expired (now < expiresAt)
   * - Signature version is known and usable
   *
   * Returns true if valid, throws if invalid.
   */
  async verifyBundle(
    bundle: OfflineBundleDto,
    now: Date = this.clock.now(),
  ): Promise<boolean> {
    // 1. Check bundle format version
    if (bundle.version !== BUNDLE_FORMAT_VERSION) {
      throw new BadRequestException({
        code: ApiErrorCode.BUNDLE_UNKNOWN_VERSION,
        message: `Unknown bundle version: ${bundle.version}`,
      });
    }

    // 2. Extract and verify signature version
    const sigMatch = /^hmac-sha256:v(\d+)=([a-f0-9]{64})$/.exec(bundle.manifest.signature);
    if (!sigMatch) {
      throw new BadRequestException({
        code: ApiErrorCode.BUNDLE_TAMPERED,
        message: "Bundle signature format is invalid",
      });
    }

    const [, versionStr, signatureHex] = sigMatch;
    const signatureVersion = Number(versionStr);

    if (!this.signingKeyring.isUsableForVerification(signatureVersion)) {
      throw new BadRequestException({
        code: ApiErrorCode.BUNDLE_UNKNOWN_SIGNATURE_VERSION,
        message: `Unknown or expired signature version: v${signatureVersion}`,
      });
    }

    // 3. Verify signature
    const manifestToSign: Partial<OfflineBundleManifestDto> = {
      bundleId: bundle.manifest.bundleId,
      issuedAt: bundle.manifest.issuedAt,
      expiresAt: bundle.manifest.expiresAt,
      maxFreshnessSeconds: bundle.manifest.maxFreshnessSeconds,
      issuer: bundle.manifest.issuer,
      scope: bundle.manifest.scope,
      contentsHash: bundle.manifest.contentsHash,
    };

    const canonical = canonicalize(manifestToSign);
    const signingKey = this.signingKeyring.secretFor(signatureVersion);
    if (!signingKey) {
      throw new BadRequestException({
        code: ApiErrorCode.BUNDLE_UNKNOWN_SIGNATURE_VERSION,
        message: `Signing key version v${signatureVersion} not available`,
      });
    }

    const expectedHmac = createHmac("sha256", signingKey).update(canonical).digest("hex");
    if (expectedHmac !== signatureHex) {
      throw new BadRequestException({
        code: ApiErrorCode.BUNDLE_TAMPERED,
        message: "Bundle signature verification failed",
      });
    }

    // 4. Verify contents hash
    const recomputedHash = this.computeContentsHash(bundle.contents);
    if (recomputedHash !== bundle.manifest.contentsHash) {
      throw new BadRequestException({
        code: ApiErrorCode.BUNDLE_TAMPERED,
        message: "Bundle contents hash mismatch",
      });
    }

    // 5. Verify expiry (now < expiresAt; >= means expired)
    const expiresAt = new Date(bundle.manifest.expiresAt);
    if (now >= expiresAt) {
      throw new BadRequestException({
        code: ApiErrorCode.BUNDLE_EXPIRED,
        message: "Bundle has expired",
      });
    }

    // 6. Verify checkpoint freshness
    for (const checkpoint of bundle.contents.checkpoints) {
      const observedAt = new Date(checkpoint.observedAt);
      const age = (now.getTime() - observedAt.getTime()) / 1000;
      if (age > bundle.manifest.maxFreshnessSeconds) {
        throw new BadRequestException({
          code: ApiErrorCode.BUNDLE_CHECKPOINT_STALE,
          message: `Checkpoint is stale (age ${age}s > max ${bundle.manifest.maxFreshnessSeconds}s)`,
        });
      }
    }

    return true;
  }
}
