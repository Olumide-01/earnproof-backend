import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { canonicalize } from "../common/crypto/canonicalize";
import {
  CredentialSigningKeyringService,
  versionFromKeyId,
} from "../common/crypto/credential-signing-keyring.service";
import { safeEqual } from "../common/crypto/timing-safe";
import { PrismaService } from "../database/prisma.service";
import {
  EvidenceBundlePayload,
  MAX_EVIDENCE_BUNDLE_BYTES,
  SignedEvidenceBundle,
  SUPPORTED_BUNDLE_MANIFEST_VERSION,
  VerifyEvidenceBundleResponseDto,
} from "./dto/evidence-bundle.dto";

@Injectable()
export class EvidenceBundleService {
  private readonly logger = new Logger(EvidenceBundleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly keyringService: CredentialSigningKeyringService,
  ) {}

  /**
   * Generates a signed verification evidence bundle for a valid proof.
   *
   * Manifest contains allowed evidence only (hashes, references, network, dates),
   * strictly omitting raw memos, transaction details, or private source records.
   */
  async generateBundle(
    proofId: string,
    targetNetwork?: string,
  ): Promise<SignedEvidenceBundle> {
    const proof = await this.prisma.proof.findUnique({
      where: { id: proofId },
      include: {
        claim: true,
      },
    });

    if (!proof) {
      throw new NotFoundException(`Proof ${proofId} not found`);
    }

    if (proof.status !== "ACTIVE") {
      throw new BadRequestException(`Cannot generate evidence bundle for proof with status ${proof.status}`);
    }

    const now = new Date();
    if (proof.expiresAt.getTime() <= now.getTime()) {
      throw new BadRequestException("Cannot generate evidence bundle for expired proof");
    }

    const network = targetNetwork || proof.network || "testnet";
    const bundleId = `bundle_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const manifest: EvidenceBundlePayload = {
      manifestVersion: "1.0.0",
      bundleId,
      network,
      proofId: proof.id,
      evidence: {
        credentialHash: proof.credentialHash,
        contractTransactionHash: proof.contractTransactionHash,
        commitment: proof.commitment,
        assetCode: proof.assetCode,
        assetIssuer: proof.assetIssuer,
        verifiedAt: proof.createdAt.toISOString(),
        expiresAt: proof.expiresAt.toISOString(),
      },
    };

    const canonicalManifestJson = canonicalize(manifest);

    // Sign with active key from keyring
    const activeKeyId = this.keyringService.activeKeyId;
    const activeSecret = this.keyringService.activeSecret;

    const signature = createHmac("sha256", activeSecret)
      .update(canonicalManifestJson)
      .digest("hex");

    const signedBundle: SignedEvidenceBundle = {
      manifest,
      signing: {
        keyId: activeKeyId,
        algorithm: "hmac-sha256",
        signature,
        signedAt: now.toISOString(),
      },
    };

    const serialized = JSON.stringify(signedBundle);
    if (Buffer.byteLength(serialized, "utf8") > MAX_EVIDENCE_BUNDLE_BYTES) {
      throw new BadRequestException(`Generated evidence bundle exceeds maximum size of ${MAX_EVIDENCE_BUNDLE_BYTES} bytes`);
    }

    return signedBundle;
  }

  /**
   * Verifies an evidence bundle manifest against tampering, unsupported versions,
   * network mismatch, expired evidence, and rotated/retired keys.
   */
  async verifyBundle(
    bundleOrString: SignedEvidenceBundle | string,
    expectedNetwork?: string,
  ): Promise<VerifyEvidenceBundleResponseDto> {
    let bundle: SignedEvidenceBundle;

    // Check raw string size limit before parsing
    if (typeof bundleOrString === "string") {
      if (Buffer.byteLength(bundleOrString, "utf8") > MAX_EVIDENCE_BUNDLE_BYTES) {
        return {
          valid: false,
          reason: `Evidence bundle exceeds maximum allowed size of ${MAX_EVIDENCE_BUNDLE_BYTES} bytes`,
        };
      }
      try {
        bundle = JSON.parse(bundleOrString);
      } catch {
        return { valid: false, reason: "Malformed evidence bundle JSON" };
      }
    } else {
      const serialized = JSON.stringify(bundleOrString);
      if (Buffer.byteLength(serialized, "utf8") > MAX_EVIDENCE_BUNDLE_BYTES) {
        return {
          valid: false,
          reason: `Evidence bundle exceeds maximum allowed size of ${MAX_EVIDENCE_BUNDLE_BYTES} bytes`,
        };
      }
      bundle = bundleOrString;
    }

    // 1. Structure validation
    if (!bundle || !bundle.manifest || !bundle.signing) {
      return { valid: false, reason: "Invalid bundle envelope structure" };
    }

    const { manifest, signing } = bundle;

    // 2. Unsupported manifest version check
    if (manifest.manifestVersion !== SUPPORTED_BUNDLE_MANIFEST_VERSION) {
      return {
        valid: false,
        reason: `Unsupported manifest version '${manifest.manifestVersion}'. Expected '${SUPPORTED_BUNDLE_MANIFEST_VERSION}'`,
      };
    }

    // 3. Network check
    if (expectedNetwork && manifest.network.toLowerCase() !== expectedNetwork.toLowerCase()) {
      return {
        valid: false,
        reason: `Network mismatch: bundle specifies '${manifest.network}' but verification expected '${expectedNetwork}'`,
      };
    }

    // 4. Evidence expiration check
    if (!manifest.evidence || !manifest.evidence.expiresAt) {
      return { valid: false, reason: "Missing evidence expiration timestamp" };
    }

    const expiresAt = new Date(manifest.evidence.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      return { valid: false, reason: "Evidence has expired or has an invalid timestamp" };
    }

    // 5. Key ID and rotation window verification
    if (!signing.keyId) {
      return { valid: false, reason: "Missing signing keyId" };
    }

    const version = versionFromKeyId(signing.keyId);
    if (version === null) {
      return { valid: false, reason: `Malformed signing keyId format: '${signing.keyId}'` };
    }

    if (!this.keyringService.isUsableForVerification(version)) {
      return {
        valid: false,
        reason: `Signing key version '${signing.keyId}' is expired, retired, or not loaded in keyring`,
      };
    }

    const secret = this.keyringService.secretFor(version);
    if (!secret) {
      return { valid: false, reason: `No secret loaded for key version '${signing.keyId}'` };
    }

    // 6. Signature / tampering check (canonical JSON)
    const canonicalManifestJson = canonicalize(manifest);
    const expectedSignature = createHmac("sha256", secret)
      .update(canonicalManifestJson)
      .digest("hex");

    if (!safeEqual(signing.signature, expectedSignature)) {
      return { valid: false, reason: "Signature mismatch: bundle manifest has been tampered with or corrupted" };
    }

    return {
      valid: true,
      bundleId: manifest.bundleId,
      proofId: manifest.proofId,
      keyId: signing.keyId,
    };
  }
}
