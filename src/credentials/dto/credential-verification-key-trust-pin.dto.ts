import { IsString, IsNotEmpty, IsOptional, IsObject, IsISO8601, ValidateIf } from "class-validator";

/**
 * Trusted key material snapshot at pin decision time.
 * Immutable; preserves exact state for verification even if live keys change.
 */
export interface TrustedKeySnapshot {
  /** Ed25519 signing algorithm */
  alg: "EdDSA";
  /** Elliptic curve */
  crv: "Ed25519";
  /** Key ID from the issuer */
  kid: string;
  /** Key type: Octet Key Pair */
  kty: "OKP";
  /** Base64url-encoded public key material (never private keys) */
  x: string;
  /** Signature use: always "sig" for verification */
  use: "sig";
  /** Key lifecycle: "active" or "retired" */
  status: "active" | "retired";
}

/**
 * Audit context: who made the trust decision and why.
 */
export interface TrustDecisionMetadata {
  /** Actor who made the decision (user ID) */
  decidedBy: string;
  /** Reason for the trust decision */
  reason?: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

/**
 * Create a trust pin for an issuer verification key.
 */
export class CreateCredentialVerificationKeyTrustPinDto {
  /** Organization ID owning this trust decision */
  @IsString()
  @IsNotEmpty()
  organizationId: string;

  /** Issuer ID this pin is scoped to */
  @IsString()
  @IsNotEmpty()
  issuerId: string;

  /** Network the issuer operates on */
  @IsString()
  @IsNotEmpty()
  network: string;

  /** Key ID being pinned */
  @IsString()
  @IsNotEmpty()
  keyId: string;

  /** Immutable snapshot of trusted key material */
  @IsObject()
  @IsNotEmpty()
  trustedKeySnapshot: TrustedKeySnapshot;

  /** When this pin becomes effective (usually now, can be backdated) */
  @IsISO8601()
  effectiveAt: string;

  /** When this pin expires (null for perpetual) */
  @IsOptional()
  @ValidateIf((o) => o.expiresAt !== null)
  @IsISO8601()
  expiresAt?: string | null;

  /** Audit metadata: who decided and why */
  @IsOptional()
  @IsObject()
  decisionMetadata?: TrustDecisionMetadata;
}

/**
 * Update trust pin status (retire or revoke).
 */
export class UpdateCredentialVerificationKeyTrustPinStatusDto {
  /** New status: ACTIVE, RETIRED, or REVOKED */
  @IsString()
  @IsNotEmpty()
  status: "ACTIVE" | "RETIRED" | "REVOKED";

  /** Expected revision for optimistic concurrency (required for REVOKED) */
  @IsOptional()
  @IsNotEmpty()
  expectedRevision?: number;

  /** Revocation reason (required if status=REVOKED) */
  @ValidateIf((o) => o.status === "REVOKED")
  @IsString()
  @IsNotEmpty()
  revocationReason?: string;

  /** Who revoked (required if status=REVOKED, typically the actor ID) */
  @ValidateIf((o) => o.status === "REVOKED")
  @IsString()
  @IsNotEmpty()
  revokedBy?: string;
}

/**
 * Response DTO for a trust pin.
 */
export class CredentialVerificationKeyTrustPinResponseDto {
  id: string;
  organizationId: string;
  issuerId: string;
  network: string;
  keyId: string;
  trustedKeySnapshot: TrustedKeySnapshot;
  effectiveAt: string;
  expiresAt?: string | null;
  status: string;
  decisionMetadata?: TrustDecisionMetadata;
  revision: number;
  revokedAt?: string | null;
  revokedBy?: string | null;
  revocationReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * List trust pins response.
 */
export class ListCredentialVerificationKeyTrustPinsResponseDto {
  pins: CredentialVerificationKeyTrustPinResponseDto[];
  total: number;
  page: number;
  pageSize: number;
}
