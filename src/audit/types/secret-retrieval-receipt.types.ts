/**
 * Types and enums for secret retrieval receipts.
 *
 * A receipt is immutable evidence that a one-time secret (API key, webhook signing secret,
 * or export token) was revealed to a user or client at a specific time, without storing
 * the secret itself. The acknowledgement hash is deterministic and cannot be reversed
 * to recover the secret.
 */

/** Type of secret being revealed. */
export enum SecretType {
  API_KEY = "api_key",
  WEBHOOK = "webhook",
  EXPORT = "export",
}

/** How the secret was delivered to the recipient. */
export enum DeliveryChannel {
  HTTP_RESPONSE = "http_response",
  DOWNLOAD_URL = "download_url",
  EMAIL = "email",
}

/** Lifecycle status of a receipt. */
export enum ReceiptStatus {
  ACTIVE = "ACTIVE",
  EXPIRED = "EXPIRED",
  REVOKED = "REVOKED",
}

/** Input for creating a secret retrieval receipt. */
export interface CreateSecretRetrievalReceiptInput {
  /** Organization that owns the secret. */
  organizationId: string;

  /** Type of secret (api_key, webhook, export). */
  secretType: SecretType;

  /** ID of the resource (API key ID, webhook ID, export job ID). */
  resourceId: string;

  /** Optional human-readable identifier for user reference (e.g., API key prefix, webhook URL). */
  resourceReference?: string | null;

  /** Who received the secret (user ID, API key prefix, or null for capability URLs). */
  recipientId?: string | null;

  /** How the secret was delivered. */
  deliveryChannel?: DeliveryChannel;

  /** Exact timestamp when the secret was revealed. */
  revealedAt: Date;

  /** When the receipt itself expires (independent of secret expiry). */
  expiresAt?: Date | null;

  /** Optional metadata (IP, user agent, reason, etc.). */
  metadata?: Record<string, unknown>;
}

/** Output: created receipt with acknowledgement hash and computed fields. */
export interface SecretRetrievalReceiptDto {
  id: string;
  organizationId: string;
  secretType: string;
  resourceId: string;
  resourceReference: string | null;
  recipientId: string | null;
  deliveryChannel: string;
  revealedAt: Date;
  acknowledgementHash: string;
  status: string;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Audit log entry for receipt creation. */
export interface SecretRetrievalReceiptAuditEntry {
  action: "secret_retrieval_receipt.created";
  secretType: SecretType;
  resourceId: string;
  resourceReference?: string | null;
  recipientId?: string | null;
  deliveryChannel: DeliveryChannel;
  revealedAt: Date;
  receiptId: string;
  acknowledgementHash: string;
}
