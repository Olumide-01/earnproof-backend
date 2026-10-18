import { ApprovalIntentReceiptV1 } from "./approval-intent-receipt-v1.dto";

/**
 * Response DTO for a signed approval intent receipt.
 *
 * Contains the canonical receipt data, the EdDSA signature, key ID, and hashes
 * for verification. No signing secrets or private material.
 */
export class ApprovalIntentReceiptResponseDto {
  /** Unique receipt identifier. */
  id: string;

  /** Receipt schema version (e.g., "v1"). */
  schemaVersion: string;

  /** The complete canonical receipt data (JSON object). */
  receiptData: ApprovalIntentReceiptV1;

  /** Deterministic hash of the canonical receipt. Format: "sha256:<hex>". */
  receiptHash: string;

  /** Non-secret key ID used to sign this receipt. */
  signingKeyId: string;

  /** EdDSA signature over the canonical receipt. Format: "ed25519:<base64url>". */
  signature: string;

  /** Hash of the signed payload. Format: "sha256:<hex>". */
  credentialHash: string;

  /** Timestamp when the receipt was issued. */
  issuedAt: Date;

  /** Timestamp when the receipt was persisted. */
  createdAt: Date;

  constructor(partial?: Partial<ApprovalIntentReceiptResponseDto>) {
    Object.assign(this, partial);
  }
}
