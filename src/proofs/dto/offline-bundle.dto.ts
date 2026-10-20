import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ProofType, RevocationReasonCode } from "@prisma/client";
import { SignedCredentialDto } from "./proof-created.dto";

/**
 * Scope definition for an offline bundle, stating what proofs and operations are authorized.
 *
 * @example
 * {
 *   "proofIds": ["clx1abc2def3ghi4"],
 *   "operations": ["verify"],
 *   "organizationId": "org_abc123"
 * }
 */
export class OfflineBundleScopeDto {
  @ApiProperty({
    description: "Proof IDs explicitly included in the bundle.",
    type: [String],
    example: ["clx1abc2def3ghi4"],
  })
  proofIds!: string[];

  @ApiProperty({
    description: "Authorized operations for the bundle.",
    type: [String],
    enum: ["verify", "audit"],
    example: ["verify"],
  })
  operations!: string[];

  @ApiPropertyOptional({
    description: "Organization ID that requested and owns this bundle.",
    example: "org_abc123",
  })
  organizationId?: string;
}

/**
 * Verification key included in the bundle for signature verification.
 *
 * @example
 * {
 *   "keyId": "credential-key-0",
 *   "type": "Ed25519",
 *   "algorithm": "EdDSA",
 *   "publicKey": {
 *     "kty": "OKP",
 *     "crv": "Ed25519",
 *     "x": "..."
 *   },
 *   "version": 0,
 *   "validFrom": "2025-09-01T00:00:00.000Z",
 *   "validUntil": "2025-12-31T23:59:59.999Z"
 * }
 */
export class VerificationKeyDto {
  @ApiProperty({
    description: "Non-secret key identifier (e.g., credential-key-0).",
    example: "credential-key-0",
  })
  keyId!: string;

  @ApiProperty({
    description: "Key type (e.g., Ed25519).",
    example: "Ed25519",
  })
  type!: string;

  @ApiProperty({
    description: "Cryptographic algorithm (e.g., EdDSA).",
    example: "EdDSA",
  })
  algorithm!: string;

  @ApiProperty({
    description: "Public key material in JWK format.",
    example: {
      kty: "OKP",
      crv: "Ed25519",
      x: "...",
    },
  })
  publicKey!: Record<string, unknown>;

  @ApiProperty({
    description: "Key version number.",
    example: 0,
  })
  version!: number;

  @ApiPropertyOptional({
    description: "ISO-8601 UTC timestamp when the key became valid.",
    example: "2025-09-01T00:00:00.000Z",
  })
  validFrom?: string;

  @ApiPropertyOptional({
    description: "ISO-8601 UTC timestamp when the key expires.",
    example: "2025-12-31T23:59:59.999Z",
  })
  validUntil?: string;
}

/**
 * Revocation checkpoint included in the bundle for offline state verification.
 *
 * @example
 * {
 *   "proofId": "clx1abc2def3ghi4",
 *   "version": 1,
 *   "observedAt": "2025-10-15T14:25:00.000Z",
 *   "status": "active",
 *   "revocationHash": "sha256:abc123...",
 *   "contractAddress": "0x...",
 *   "txnHash": "0x..."
 * }
 */
export class CheckpointSummaryDto {
  @ApiProperty({
    description: "Proof ID this checkpoint observes.",
    example: "clx1abc2def3ghi4",
  })
  proofId!: string;

  @ApiProperty({
    description: "Checkpoint version number.",
    example: 1,
  })
  version!: number;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp when the checkpoint was observed/created.",
    example: "2025-10-15T14:25:00.000Z",
  })
  observedAt!: string;

  @ApiProperty({
    description: "Status of the proof at this checkpoint (active, expired, revoked, invalid).",
    example: "active",
  })
  status!: string;

  @ApiPropertyOptional({
    description: "Hash of the revocation status (sha256:none if not revoked).",
    example: "sha256:abc123...",
  })
  revocationHash?: string;

  @ApiPropertyOptional({
    description: "Contract address where the proof is anchored.",
    example: "0x...",
  })
  contractAddress?: string;

  @ApiPropertyOptional({
    description: "Transaction hash of the anchoring transaction.",
    example: "0x...",
  })
  txnHash?: string;
}

/**
 * Manifest of an offline verification bundle.
 * Covers the bundle's scope, contents, expiry, and freshness constraints.
 * The signature covers the entire manifest (excluding the signature field itself).
 *
 * @example
 * {
 *   "bundleId": "obb_abc123def456",
 *   "issuedAt": "2025-10-15T14:30:00.000Z",
 *   "expiresAt": "2025-10-15T15:00:00.000Z",
 *   "maxFreshnessSeconds": 1800,
 *   "issuer": "earnproof",
 *   "scope": {...},
 *   "contentsHash": "sha256:xyz789...",
 *   "signature": "hmac-sha256:v1=..."
 * }
 */
export class OfflineBundleManifestDto {
  @ApiProperty({
    description: "Unique bundle identifier (user-facing).",
    example: "obb_abc123def456",
  })
  bundleId!: string;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp when the bundle was created.",
    example: "2025-10-15T14:30:00.000Z",
  })
  issuedAt!: string;

  @ApiProperty({
    description:
      "ISO-8601 UTC timestamp when the bundle expires. " +
      "After this time, the bundle must not be used for verification.",
    example: "2025-10-15T15:00:00.000Z",
  })
  expiresAt!: string;

  @ApiProperty({
    description:
      "Maximum age in seconds that revocation checkpoints in this bundle may be treated as current. " +
      "A checkpoint older than this value is considered stale for offline verification.",
    example: 1800,
  })
  maxFreshnessSeconds!: number;

  @ApiProperty({
    description: "Issuer identity (always 'earnproof').",
    example: "earnproof",
  })
  issuer!: string;

  @ApiProperty({
    description: "Scope of the bundle (authorized proofs and operations).",
    type: () => OfflineBundleScopeDto,
  })
  scope!: OfflineBundleScopeDto;

  @ApiProperty({
    description: "SHA-256 hash of the contents object (hex-encoded, 'sha256:' prefix).",
    example: "sha256:abc123def456...",
  })
  contentsHash!: string;

  @ApiProperty({
    description: "HMAC-SHA256 signature of the manifest (versioned, 'hmac-sha256:v1=' prefix).",
    example: "hmac-sha256:v1=xyz789...",
  })
  signature!: string;
}

/**
 * Contents of an offline verification bundle.
 * Includes only authorized credentials, verification keys, and checkpoints.
 *
 * @example
 * {
 *   "credentials": [...],
 *   "verificationKeys": [...],
 *   "checkpoints": [...]
 * }
 */
export class OfflineBundleContentsDto {
  @ApiProperty({
    description: "Authorized credentials for offline verification.",
    type: [SignedCredentialDto],
  })
  credentials!: SignedCredentialDto[];

  @ApiProperty({
    description: "Verification keys needed to verify credential signatures.",
    type: [VerificationKeyDto],
  })
  verificationKeys!: VerificationKeyDto[];

  @ApiProperty({
    description: "Revocation checkpoints for state verification.",
    type: [CheckpointSummaryDto],
  })
  checkpoints!: CheckpointSummaryDto[];
}

/**
 * Bounded offline verification bundle.
 * A signed, time-limited bundle containing authorized disclosures and verification material.
 *
 * The bundle enables offline verification of proofs within the specified bounds:
 * - Valid until `manifest.expiresAt` (exclusive boundary; expired if `now >= expiresAt`)
 * - Checkpoints are stale if older than `manifest.maxFreshnessSeconds`
 * - Only proofs listed in `manifest.scope.proofIds` are included
 * - Signature covers the entire manifest for tamper detection
 *
 * @example
 * {
 *   "version": "earnproof.offline-bundle.v1",
 *   "bundleId": "obb_abc123def456",
 *   "manifest": {...},
 *   "contents": {...},
 *   "generatedAt": "2025-10-15T14:30:00.000Z"
 * }
 */
export class OfflineBundleDto {
  @ApiProperty({
    description: "Bundle format version (enables schema evolution).",
    example: "earnproof.offline-bundle.v1",
  })
  version!: string;

  @ApiProperty({
    description: "Unique bundle identifier (user-facing, for reference and audit).",
    example: "obb_abc123def456",
  })
  bundleId!: string;

  @ApiProperty({
    description: "Bundle manifest (scope, expiry, freshness, signature).",
    type: () => OfflineBundleManifestDto,
  })
  manifest!: OfflineBundleManifestDto;

  @ApiProperty({
    description: "Bundle contents (credentials, keys, checkpoints).",
    type: () => OfflineBundleContentsDto,
  })
  contents!: OfflineBundleContentsDto;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp when the bundle was generated (server time).",
    example: "2025-10-15T14:30:00.000Z",
  })
  generatedAt!: string;
}
