import { Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "crypto";
import {
  SignedCursorEnvelope,
  SignedCursorFailureReason,
  SignedCursorPayload,
  SignedCursorValidationResult,
  SignCursorParams,
  VerifySignedCursorParams,
} from "./signed-cursor.types";
import { SignedCursorKeyringService, versionFromCursorKeyId } from "./signed-cursor-keyring.service";
import { sha256 } from "../crypto/hash";

/**
 * Default cursor lifetime: 15 minutes.
 * This balances user experience (pagination across a session) with security
 * (limits window for token compromise, brute-force, or replay attacks).
 */
const DEFAULT_CURSOR_TTL_SECONDS = 15 * 60;

/**
 * Signed cursor pagination service.
 *
 * Provides tamper-proof cursor tokens with:
 * - HMAC-SHA256 signatures for integrity
 * - Expiry timestamps for time-bound validity
 * - Filter binding to prevent cross-filter pagination
 * - Tenant binding to prevent cross-tenant data leaks
 * - Versioned key rotation support
 *
 * ## Signing process
 *
 * 1. Build a payload: { version, expiresAt, filterId, tenantId, cursorId }
 * 2. Compute HMAC-SHA256(signingKey, canonicalPayload)
 * 3. Base64url-encode the full envelope (payload + signature)
 * 4. Return the encoded token to the client
 *
 * ## Validation process
 *
 * 1. Base64url-decode the token to get the envelope
 * 2. Parse the JSON payload
 * 3. Verify the version is loaded and usable
 * 4. Verify expiry hasn't passed
 * 5. Verify tenant ID matches (reject on mismatch — cross-tenant attempt)
 * 6. Verify filter ID matches (reject on mismatch — cross-filter attempt)
 * 7. Verify HMAC signature with constant-time comparison
 * 8. Return payload or failure reason
 *
 * Validation never throws — all failures return { ok: false, reason } for
 * consistent error handling and to avoid leaking information through exceptions.
 */
@Injectable()
export class SignedCursorService {
  constructor(private readonly keyring: SignedCursorKeyringService) {}

  /**
   * Create a signed cursor token from a cursor ID, tenant, and filter context.
   *
   * @param params Cursor ID, tenant ID, and filter context
   * @returns Base64url-encoded signed token
   * @throws If the active signing key is not configured
   */
  sign(params: SignCursorParams): string {
    const { cursorId, tenantId, filterId, ttlSeconds = DEFAULT_CURSOR_TTL_SECONDS } = params;

    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    const envelope: SignedCursorEnvelope = {
      version: "1",
      expiresAt,
      filterId,
      tenantId,
      cursorId,
      signature: "", // Placeholder; computed below
    };

    // Build canonical payload for signing (deterministic JSON, no spaces)
    const canonical = this.buildCanonical(envelope);

    // Sign with active key
    const activeSecret = this.keyring.activeSecret;
    const signature = this.computeSignature(activeSecret, canonical);

    envelope.signature = signature;

    // Encode to base64url
    const json = JSON.stringify(envelope);
    const token = Buffer.from(json, "utf8").toString("base64url");

    return token;
  }

  /**
   * Verify a signed cursor token and extract its payload.
   *
   * @param params Token, tenant ID, and expected filter ID
   * @returns Either valid payload or failure reason (never throws)
   */
  verify(params: VerifySignedCursorParams): SignedCursorValidationResult {
    const { token, tenantId, filterId, nowMs = Date.now() } = params;

    // 1. Decode token
    let envelope: SignedCursorEnvelope;
    try {
      const json = Buffer.from(token, "base64url").toString("utf8");
      envelope = JSON.parse(json);
    } catch {
      return { ok: false, reason: SignedCursorFailureReason.MALFORMED };
    }

    // 2. Validate required fields
    if (
      !envelope ||
      typeof envelope !== "object" ||
      typeof envelope.version !== "string" ||
      typeof envelope.signature !== "string" ||
      typeof envelope.expiresAt !== "number" ||
      typeof envelope.filterId !== "string" ||
      typeof envelope.tenantId !== "string" ||
      typeof envelope.cursorId !== "string"
    ) {
      return { ok: false, reason: SignedCursorFailureReason.MISSING_FIELDS };
    }

    // 3. Verify version is supported
    if (envelope.version !== "1") {
      return { ok: false, reason: SignedCursorFailureReason.UNSUPPORTED_VERSION };
    }

    // 4. Verify expiry
    if (nowMs > envelope.expiresAt) {
      return { ok: false, reason: SignedCursorFailureReason.EXPIRED };
    }

    // 5. Verify tenant binding (cross-tenant detection)
    if (envelope.tenantId !== tenantId) {
      return { ok: false, reason: SignedCursorFailureReason.TENANT_MISMATCH };
    }

    // 6. Verify filter binding (cross-filter detection)
    if (envelope.filterId !== filterId) {
      return { ok: false, reason: SignedCursorFailureReason.FILTER_MISMATCH };
    }

    // 7. Verify signature (constant-time comparison to prevent timing oracle)
    const result = this.verifySignature(envelope);
    if (!result.ok) {
      return result;
    }

    // 8. Return decoded payload
    const payload: SignedCursorPayload = {
      cursorId: envelope.cursorId,
      filterId: envelope.filterId,
      tenantId: envelope.tenantId,
      expiresAt: envelope.expiresAt,
    };

    return { ok: true, data: payload };
  }

  /**
   * Build a canonical string representation of the cursor payload for signing.
   * This is deterministic and reproducible across all runtimes.
   *
   * Format: JSON stringified with keys in sorted order, no whitespace.
   */
  private buildCanonical(envelope: Omit<SignedCursorEnvelope, "signature">): string {
    // Sort keys deterministically to ensure reproducible signing
    const obj = {
      cursorId: envelope.cursorId,
      expiresAt: envelope.expiresAt,
      filterId: envelope.filterId,
      tenantId: envelope.tenantId,
      version: envelope.version,
    };
    return JSON.stringify(obj);
  }

  /**
   * Compute the HMAC-SHA256 signature of the canonical payload.
   */
  private computeSignature(secret: string, canonical: string): string {
    return createHmac("sha256", secret)
      .update(canonical, "utf8")
      .digest("hex");
  }

  /**
   * Verify the HMAC signature of an envelope.
   * Uses constant-time comparison to prevent timing oracles.
   */
  private verifySignature(envelope: SignedCursorEnvelope): SignedCursorValidationResult {
    const { signature, ...payloadFields } = envelope;
    const canonical = this.buildCanonical(payloadFields as any);

    // Get the signing key version from the envelope
    // For now, we try to verify with all usable versions (backwards compatibility)
    // In a more sophisticated implementation, we could store the version in the envelope
    let verified = false;

    for (const version of this.keyring.loadedVersions) {
      if (!this.keyring.isUsableForVerification(version)) {
        continue;
      }

      const secret = this.keyring.secretFor(version);
      if (!secret) {
        continue;
      }

      const expected = this.computeSignature(secret, canonical);

      try {
        const match = timingSafeEqual(
          Buffer.from(signature, "utf8"),
          Buffer.from(expected, "utf8"),
        );
        if (match) {
          verified = true;
          break;
        }
      } catch {
        // timingSafeEqual throws if buffers are different lengths
        // Continue to next version
      }
    }

    if (!verified) {
      return { ok: false, reason: SignedCursorFailureReason.SIGNATURE_INVALID };
    }

    return { ok: true, data: {} as any }; // Placeholder, not used
  }
}
