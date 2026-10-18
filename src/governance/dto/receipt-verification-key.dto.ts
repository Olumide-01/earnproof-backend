/**
 * JWK representation of a verification key.
 *
 * Standard JWK format for EdDSA/Ed25519 keys. Keys are published for verification
 * of receipts signed at any point in the past, supporting key rotation with
 * explicit expiry deadlines for staged rotation.
 */
export interface ReceiptVerificationKey {
  /** Algorithm: EdDSA. */
  alg: "EdDSA";

  /** Curve: Ed25519. */
  crv: "Ed25519";

  /** Key ID (non-secret identifier). */
  kid: string;

  /** Key type: OKP (Octet Key Pair). */
  kty: "OKP";

  /** Use: sig (signing). */
  use: "sig";

  /** Key status: "active" or "retired". */
  status: "active" | "retired";

  /** Public key (base64url encoded). */
  x: string;

  /** Optional expiry instant (ISO-8601). Only set for retired keys with staged rotation. */
  expiresAt?: string;
}

/**
 * JWK Set response for receipt verification keys.
 *
 * Published at GET /governance/approval-receipts/keys. Contains all currently
 * usable keys (active and non-expired retired keys) sorted by kid.
 */
export class ReceiptVerificationKeySetDto {
  /** Array of verification keys, sorted by kid. */
  keys: ReceiptVerificationKey[];

  constructor(keys?: ReceiptVerificationKey[]) {
    this.keys = (keys ?? []).sort((a, b) => a.kid.localeCompare(b.kid));
  }
}

/**
 * Result of receipt verification.
 *
 * Reports whether the receipt's signature is valid and includes the verified
 * receipt data. No secrets or private material included.
 */
export class ReceiptVerificationResultDto {
  /** Whether the signature verified successfully. */
  valid: boolean;

  /** The verified receipt data (only if valid === true). */
  receiptData?: Record<string, unknown>;

  /** Error message if verification failed (only if valid === false). */
  error?: string;

  constructor(partial?: Partial<ReceiptVerificationResultDto>) {
    Object.assign(this, partial);
  }
}
