import { createHash, createHmac, timingSafeEqual } from "crypto";

/**
 * Canonical request signing for EarnProof integrations.
 *
 * ## Signing scheme  (version "v1")
 *
 * Canonical string — five fields joined with newlines:
 *   METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256
 *
 * Where:
 *   METHOD      = uppercase HTTP verb (GET, POST, PATCH, DELETE, …)
 *   PATH        = percent-encoded path without query string (/api/v1/proofs/minimum-income)
 *   TIMESTAMP   = Unix seconds as a decimal string ("1724400000")
 *   NONCE       = opaque string supplied by the caller (16–64 URL-safe chars)
 *   BODY_SHA256 = lowercase hex SHA-256 of the raw request body bytes,
 *                 or the SHA-256 of the empty string when the body is absent
 *
 * HMAC key:  HMAC-SHA256(rawApiKeySecret, "earnproof-request-signing-v1") — a
 *   one-way derivation that isolates signing material from identity material.
 *
 * Signature:  HMAC-SHA256(derivedKey, canonicalString) hex-encoded, prefixed "v1=".
 *
 * ## Headers
 *   X-EarnProof-Signature  : v1=<hex>
 *   X-EarnProof-Timestamp  : <unix-seconds>
 *   X-EarnProof-Nonce      : <opaque-string>
 *
 * ## Golden vectors  (cross-runtime reproducibility)
 *
 * Vector A — GET with empty body:
 *   secret    = "test-secret-key-abcdefghij012345"
 *   method    = "GET"
 *   path      = "/api/v1/proofs"
 *   timestamp = 1724400000
 *   nonce     = "abc123def456ghi7"
 *   bodyHex   = SHA-256("") = "e3b0c44298fc1c149afbf4c8996fb924…"
 *   canonical = "GET\n/api/v1/proofs\n1724400000\nabc123def456ghi7\ne3b0c44298fc1c149afbf4c8996fb924…"
 *   signature = computed by GOLDEN_VECTOR_A in the spec file
 *
 * Vector B — POST with JSON body:
 *   body      = '{"thresholdAmount":"500.0000000"}'
 *   (all other fields change accordingly)
 *
 * ## Migration policy  (bearer-only compatibility)
 *
 * Signing is OPTIONAL. When none of the three signature headers are present
 * the guard treats the request as bearer-only and passes it through unchanged.
 * This lets existing integrations continue working without modification.
 *
 * Signing becomes enforceable per-route via the @RequireSigning() decorator
 * (applied by the route handler, checked by RequestSigningGuard).
 *
 * Operators who want to mandate signing globally can set
 * REQUIRE_REQUEST_SIGNING=true, which makes ApiKeyGuard reject bearer-only
 * requests on all API-key-protected routes.
 */

export const SIGNING_VERSION = "v1";

// Header names
export const HEADER_SIGNATURE  = "x-earnproof-signature";
export const HEADER_TIMESTAMP  = "x-earnproof-timestamp";
export const HEADER_NONCE      = "x-earnproof-nonce";

// Nonce constraints
export const NONCE_MIN_LEN = 16;
export const NONCE_MAX_LEN = 128;
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

// Clock skew window (seconds each direction)
export const DEFAULT_CLOCK_WINDOW_SECONDS = 300;

// HKDF-style label for key derivation
const SIGNING_LABEL = "earnproof-request-signing-v1";

/** SHA-256 of the empty string — used as the body digest for requests with no body. */
export const EMPTY_BODY_SHA256 = createHash("sha256").update("").digest("hex");

// ── Key derivation ──────────────────────────────────────────────────────────

/**
 * Derive a signing key from the raw API key secret.
 * Using HMAC(secret, label) isolates signing material from bearer-identity material.
 * Both sides (client and server) derive the same key from the same secret.
 */
export function deriveSigningKey(rawSecret: string): Buffer {
  return Buffer.from(
    createHmac("sha256", rawSecret).update(SIGNING_LABEL, "utf8").digest(),
  );
}

// ── Canonicalization ────────────────────────────────────────────────────────

/**
 * Build the canonical string that is signed.
 *
 * Fields are separated by "\n" (U+000A). None of the fields contain newlines,
 * so the boundary is unambiguous and the format is reproducible in any runtime.
 */
export function buildCanonicalString(params: {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  bodySha256: string;
}): string {
  return [
    params.method.toUpperCase(),
    params.path,
    String(params.timestamp),
    params.nonce,
    params.bodySha256,
  ].join("\n");
}

/**
 * Compute the SHA-256 digest of a raw request body.
 * Pass an empty Buffer (or call with no argument) for GET / DELETE requests.
 */
export function bodyDigest(body: Buffer | string | null | undefined): string {
  if (!body || (typeof body === "string" && body.length === 0)) {
    return EMPTY_BODY_SHA256;
  }
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (buf.length === 0) return EMPTY_BODY_SHA256;
  return createHash("sha256").update(buf).digest("hex");
}

// ── Signing ─────────────────────────────────────────────────────────────────

/**
 * Compute the signature header value.
 *
 * @param signingKey  Derived signing key (from deriveSigningKey).
 * @param canonical   Canonical string (from buildCanonicalString).
 * @returns           "v1=<hex>" string ready to put in X-EarnProof-Signature.
 */
export function computeSignature(signingKey: Buffer, canonical: string): string {
  const hex = createHmac("sha256", signingKey)
    .update(canonical, "utf8")
    .digest("hex");
  return `${SIGNING_VERSION}=${hex}`;
}

// ── Verification ─────────────────────────────────────────────────────────────

export type SignatureVerificationResult =
  | { ok: true }
  | { ok: false; reason: SignatureFailureReason };

export enum SignatureFailureReason {
  MISSING_HEADERS       = "MISSING_HEADERS",
  MALFORMED_TIMESTAMP   = "MALFORMED_TIMESTAMP",
  STALE_TIMESTAMP       = "STALE_TIMESTAMP",
  MALFORMED_NONCE       = "MALFORMED_NONCE",
  MALFORMED_SIGNATURE   = "MALFORMED_SIGNATURE",
  BODY_MISMATCH         = "BODY_MISMATCH",
  SIGNATURE_INVALID     = "SIGNATURE_INVALID",
}

export interface VerifySignatureParams {
  /** Raw API key secret (the value presented in Authorization: Bearer). */
  rawSecret: string;
  method: string;
  path: string;
  /** Value of X-EarnProof-Timestamp header. */
  timestampHeader: string;
  /** Value of X-EarnProof-Nonce header. */
  nonceHeader: string;
  /** Value of X-EarnProof-Signature header. */
  signatureHeader: string;
  /** Raw request body bytes. */
  body: Buffer | string | null | undefined;
  /** Current Unix time in seconds (injectable for testing). Defaults to Date.now()/1000. */
  nowSeconds?: number;
  /** Allowed clock skew in each direction (seconds). Defaults to DEFAULT_CLOCK_WINDOW_SECONDS. */
  clockWindowSeconds?: number;
}

/**
 * Verify an inbound request signature.
 *
 * Returns { ok: true } on success or { ok: false, reason } on any failure.
 * Never throws — all error paths return a typed failure reason.
 */
export function verifySignature(params: VerifySignatureParams): SignatureVerificationResult {
  const {
    rawSecret,
    method,
    path,
    timestampHeader,
    nonceHeader,
    signatureHeader,
    body,
    nowSeconds = Math.floor(Date.now() / 1000),
    clockWindowSeconds = DEFAULT_CLOCK_WINDOW_SECONDS,
  } = params;

  // 1. Validate timestamp
  const ts = Number(timestampHeader);
  if (!Number.isInteger(ts) || String(ts) !== timestampHeader.trim()) {
    return { ok: false, reason: SignatureFailureReason.MALFORMED_TIMESTAMP };
  }
  if (Math.abs(nowSeconds - ts) > clockWindowSeconds) {
    return { ok: false, reason: SignatureFailureReason.STALE_TIMESTAMP };
  }

  // 2. Validate nonce
  if (!NONCE_PATTERN.test(nonceHeader)) {
    return { ok: false, reason: SignatureFailureReason.MALFORMED_NONCE };
  }

  // 3. Validate signature format  ("v1=<64-char hex>")
  if (!/^v1=[a-f0-9]{64}$/.test(signatureHeader)) {
    return { ok: false, reason: SignatureFailureReason.MALFORMED_SIGNATURE };
  }

  // 4. Build canonical string and compute expected signature
  const digest = bodyDigest(body);
  const canonical = buildCanonicalString({
    method,
    path,
    timestamp: ts,
    nonce: nonceHeader,
    bodySha256: digest,
  });

  const signingKey = deriveSigningKey(rawSecret);
  const expected = computeSignature(signingKey, canonical);

  // 5. Constant-time comparison
  try {
    const match = timingSafeEqual(
      Buffer.from(signatureHeader, "utf8"),
      Buffer.from(expected, "utf8"),
    );
    if (!match) {
      return { ok: false, reason: SignatureFailureReason.SIGNATURE_INVALID };
    }
  } catch {
    return { ok: false, reason: SignatureFailureReason.SIGNATURE_INVALID };
  }

  return { ok: true };
}

/**
 * Return true if any of the three signing headers are present on the request.
 * Used to distinguish "bearer-only" requests from "signed" requests.
 */
export function hasSigningHeaders(headers: Record<string, string | string[] | undefined>): boolean {
  return (
    headers[HEADER_SIGNATURE] !== undefined ||
    headers[HEADER_TIMESTAMP] !== undefined ||
    headers[HEADER_NONCE] !== undefined
  );
}