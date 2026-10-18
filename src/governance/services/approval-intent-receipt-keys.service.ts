import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { CredentialSigningKeyringService } from "../../common/crypto/credential-signing-keyring.service";
import { ReceiptVerificationKey, ReceiptVerificationKeySetDto } from "../dto/receipt-verification-key.dto";

/**
 * Service for publishing and managing verification keys for approval intent receipts.
 *
 * Keys are published in JWK Set format with support for key rotation. Active keys
 * are always available; retired keys are available until their explicit expiry deadline.
 *
 * The ETag is computed from the sorted key set for cache efficiency.
 */
@Injectable()
export class ApprovalIntentReceiptKeysService {
  private cachedKeySet: ReceiptVerificationKeySetDto | null = null;
  private cachedEtag: string | null = null;

  constructor(private readonly signingKeyring: CredentialSigningKeyringService) {}

  /**
   * Get the current JWK Set of verification keys.
   *
   * Returns all currently usable keys: active keys and non-expired retired keys.
   * Keys are sorted by kid for deterministic output.
   *
   * @returns JWK Set with verification keys
   */
  getPublicKeySet(): ReceiptVerificationKeySetDto {
    const keys: ReceiptVerificationKey[] = [];

    // Collect all loaded key versions
    for (const version of this.signingKeyring.loadedVersions) {
      if (!this.signingKeyring.isUsableForVerification(version)) {
        continue;
      }

      // In a full implementation, we would fetch the public key from the keyring.
      // For now, we'll create a placeholder that would be filled in with actual keys.
      const keyId = `earnproof-v${version}`;
      const isActive = version === this.signingKeyring.activeWriteVersion;

      const key: ReceiptVerificationKey = {
        alg: "EdDSA",
        crv: "Ed25519",
        kid: keyId,
        kty: "OKP",
        use: "sig",
        status: isActive ? "active" : "retired",
        x: this.extractPublicKeyForVersion(version), // Placeholder
      };

      keys.push(key);
    }

    return new ReceiptVerificationKeySetDto(keys);
  }

  /**
   * Get the ETag for the current key set.
   *
   * ETag is computed from the canonical representation of the sorted key set,
   * allowing clients to cache efficiently and skip verification when unchanged.
   *
   * @returns ETag string (e.g., '"abc123..."')
   */
  getEtag(): string {
    const keySet = this.getPublicKeySet();
    const canonical = JSON.stringify(keySet);
    const hash = createHash("sha256").update(canonical).digest("hex");
    return `"${hash}"`;
  }

  /**
   * Extract the public key for a given key version.
   *
   * In a full implementation, this would use CredentialVerificationKeyService
   * or similar to extract the actual Ed25519 public key.
   *
   * @param version - Key version
   * @returns Base64url-encoded public key (placeholder)
   */
  private extractPublicKeyForVersion(version: number): string {
    // Placeholder: In reality, we would:
    // 1. Get the secret for this version from the keyring
    // 2. Derive the Ed25519 public key using the same algorithm as signing
    // 3. Return the base64url-encoded x-coordinate

    // For now, return a dummy value that would be replaced in actual implementation
    return `placeholder-public-key-v${version}`;
  }

  /**
   * Check if a key version is valid and usable for verification.
   *
   * A key must be loaded and either be the active version or not have an expired
   * verify-until deadline.
   *
   * @param keyId - Key ID (e.g., "earnproof-v0")
   * @returns true if usable
   */
  isKeyUsable(keyId: string): boolean {
    const version = this.versionFromKeyId(keyId);
    if (version === null) {
      return false;
    }
    return this.signingKeyring.isUsableForVerification(version);
  }

  /**
   * Get version from a key ID string.
   *
   * @param keyId - Key ID (e.g., "earnproof-v0")
   * @returns Version number, or null if malformed
   */
  private versionFromKeyId(keyId: string): number | null {
    const match = /^earnproof-v(\d+)$/.exec(keyId);
    if (!match) {
      return null;
    }
    return Number(match[1]);
  }
}
