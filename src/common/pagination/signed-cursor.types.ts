/**
 * Signed cursor pagination token types and interfaces.
 *
 * Cursors are opaque, signed tokens that:
 * - Protect against tampering via HMAC-SHA256 signatures
 * - Bind to specific filters to prevent cross-filter pagination
 * - Bind to specific tenants to prevent cross-tenant data leaks
 * - Include expiry timestamps for security
 * - Support key rotation through versioning
 *
 * Format: base64url(json({version, signature, expiresAt, filterId, tenantId, cursorId}))
 */

/**
 * Failure reasons for cursor validation, chosen to be stable and deterministic
 * across all validation contexts (no data leaks, no timing oracles).
 */
export enum SignedCursorFailureReason {
  /** Cursor is missing, malformed, or cannot be decoded. */
  MALFORMED = "MALFORMED",
  /** Cursor signature version is unsupported or not loaded. */
  UNSUPPORTED_VERSION = "UNSUPPORTED_VERSION",
  /** Cursor signature does not match payload (tampering detected). */
  SIGNATURE_INVALID = "SIGNATURE_INVALID",
  /** Cursor has expired and is no longer valid. */
  EXPIRED = "EXPIRED",
  /** Cursor is bound to a different filter ID (cross-filter attempt detected). */
  FILTER_MISMATCH = "FILTER_MISMATCH",
  /** Cursor is bound to a different tenant ID (cross-tenant attempt detected). */
  TENANT_MISMATCH = "TENANT_MISMATCH",
  /** Cursor format is valid but required fields are missing. */
  MISSING_FIELDS = "MISSING_FIELDS",
}

/**
 * Result of cursor validation: either valid with decoded data or failed with reason.
 */
export type SignedCursorValidationResult =
  | { ok: true; data: SignedCursorPayload }
  | { ok: false; reason: SignedCursorFailureReason };

/**
 * The signed envelope that wraps a cursor ID.
 * Versioned for key rotation and format evolution.
 */
export interface SignedCursorEnvelope {
  /** Envelope format version (currently "1"). Allows format evolution. */
  version: string;
  /** HMAC-SHA256 signature of the payload (hex-encoded). */
  signature: string;
  /** Unix milliseconds when this cursor expires. */
  expiresAt: number;
  /** Hash of the filter context to prevent cross-filter pagination. */
  filterId: string;
  /** Tenant/organization ID to prevent cross-tenant data leaks. */
  tenantId: string;
  /** The actual cursor ID from Prisma (e.g., the last item's ID). */
  cursorId: string;
}

/**
 * Decoded, validated payload from a signed cursor token.
 * This is what services receive after validation.
 */
export interface SignedCursorPayload {
  cursorId: string;
  filterId: string;
  tenantId: string;
  expiresAt: number;
}

/**
 * Parameters for signing a new cursor.
 */
export interface SignCursorParams {
  /** The actual cursor ID (e.g., the last item's ID from Prisma). */
  cursorId: string;
  /** Tenant/organization ID to bind the cursor to. */
  tenantId: string;
  /** Hash of the filter context (query parameters, status filters, etc.). */
  filterId: string;
  /** Cursor lifetime in seconds (typically 5-15 minutes). */
  ttlSeconds?: number;
}

/**
 * Parameters for verifying a signed cursor token.
 */
export interface VerifySignedCursorParams {
  /** The signed cursor token (base64url-encoded). */
  token: string;
  /** Expected tenant ID. Mismatches are rejected. */
  tenantId: string;
  /** Expected filter ID. Mismatches are rejected. */
  filterId: string;
  /** Current time for expiry check (injectable for testing). Defaults to Date.now(). */
  nowMs?: number;
}
