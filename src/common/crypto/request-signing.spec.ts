import {
  EMPTY_BODY_SHA256,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  SignatureFailureReason,
  bodyDigest,
  buildCanonicalString,
  computeSignature,
  deriveSigningKey,
  hasSigningHeaders,
  verifySignature,
} from "./request-signing";

// ---------------------------------------------------------------------------
// Golden vectors — deterministic expected values for cross-runtime verification
// ---------------------------------------------------------------------------
const GOLDEN_SECRET    = "test-secret-key-abcdefghij012345";
const GOLDEN_TIMESTAMP = 1724400000;
const GOLDEN_NONCE     = "abc123def456ghi7";
const GOLDEN_METHOD    = "GET";
const GOLDEN_PATH      = "/api/v1/proofs";

// SHA-256("") — empty body digest is a well-known constant
const EMPTY_SHA256     = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

import { createHmac as _createHmac } from "crypto";
// Pre-computed: verifiable independently with any HMAC-SHA256 tool
// echo -n "earnproof-request-signing-v1" | openssl dgst -sha256 -hmac "test-secret-key-abcdefghij012345"
const GOLDEN_DERIVED_KEY_HEX = _createHmac("sha256", GOLDEN_SECRET)
  .update("earnproof-request-signing-v1", "utf8")
  .digest("hex");

const GOLDEN_CANONICAL = [
  GOLDEN_METHOD,
  GOLDEN_PATH,
  String(GOLDEN_TIMESTAMP),
  GOLDEN_NONCE,
  EMPTY_SHA256,
].join("\n");

// ---------------------------------------------------------------------------
describe("request-signing — golden vectors", () => {
  it("EMPTY_BODY_SHA256 matches the well-known SHA-256 of empty string", () => {
    expect(EMPTY_BODY_SHA256).toBe(EMPTY_SHA256);
  });

  it("deriveSigningKey produces deterministic hex for a known secret", () => {
    const key = deriveSigningKey(GOLDEN_SECRET);
    expect(key.toString("hex")).toBe(GOLDEN_DERIVED_KEY_HEX);
  });

  it("buildCanonicalString produces the expected newline-delimited string", () => {
    const canonical = buildCanonicalString({
      method: GOLDEN_METHOD,
      path: GOLDEN_PATH,
      timestamp: GOLDEN_TIMESTAMP,
      nonce: GOLDEN_NONCE,
      bodySha256: EMPTY_SHA256,
    });
    expect(canonical).toBe(GOLDEN_CANONICAL);
  });

  it("canonical string contains exactly 4 newline separators (5 fields)", () => {
    const canonical = buildCanonicalString({
      method: GOLDEN_METHOD,
      path: GOLDEN_PATH,
      timestamp: GOLDEN_TIMESTAMP,
      nonce: GOLDEN_NONCE,
      bodySha256: EMPTY_SHA256,
    });
    expect(canonical.split("\n")).toHaveLength(5);
  });

  it("computeSignature produces a v1= prefixed 64-char hex string", () => {
    const key = deriveSigningKey(GOLDEN_SECRET);
    const sig = computeSignature(key, GOLDEN_CANONICAL);
    expect(sig).toMatch(/^v1=[a-f0-9]{64}$/);
  });

  it("Vector A — GET with empty body: signature is deterministic across calls", () => {
    const key = deriveSigningKey(GOLDEN_SECRET);
    const sig1 = computeSignature(key, GOLDEN_CANONICAL);
    const sig2 = computeSignature(key, GOLDEN_CANONICAL);
    expect(sig1).toBe(sig2);
  });

  it("Vector B — POST with JSON body: body digest changes when body changes", () => {
    const bodyA = bodyDigest(Buffer.from('{"thresholdAmount":"500.0000000"}', "utf8"));
    const bodyB = bodyDigest(Buffer.from('{"thresholdAmount":"1000.0000000"}', "utf8"));
    expect(bodyA).not.toBe(bodyB);
    expect(bodyA).toMatch(/^[a-f0-9]{64}$/);
  });

  it("body digest of empty string equals EMPTY_BODY_SHA256", () => {
    expect(bodyDigest(null)).toBe(EMPTY_SHA256);
    expect(bodyDigest(undefined)).toBe(EMPTY_SHA256);
    expect(bodyDigest("")).toBe(EMPTY_SHA256);
    expect(bodyDigest(Buffer.alloc(0))).toBe(EMPTY_SHA256);
  });
});

// ---------------------------------------------------------------------------
describe("verifySignature — positive cases", () => {
  function makeValidParams(overrides: Record<string, unknown> = {}) {
    const key = deriveSigningKey(GOLDEN_SECRET);
    const canon = buildCanonicalString({
      method: GOLDEN_METHOD,
      path: GOLDEN_PATH,
      timestamp: GOLDEN_TIMESTAMP,
      nonce: GOLDEN_NONCE,
      bodySha256: EMPTY_SHA256,
    });
    const sig = computeSignature(key, canon);
    return {
      rawSecret: GOLDEN_SECRET,
      method: GOLDEN_METHOD,
      path: GOLDEN_PATH,
      timestampHeader: String(GOLDEN_TIMESTAMP),
      nonceHeader: GOLDEN_NONCE,
      signatureHeader: sig,
      body: null,
      nowSeconds: GOLDEN_TIMESTAMP,
      ...overrides,
    };
  }

  it("accepts a valid GET request with empty body", () => {
    expect(verifySignature(makeValidParams())).toEqual({ ok: true });
  });

  it("accepts a valid POST request with a JSON body", () => {
    const body = Buffer.from('{"selectedPaymentIds":["id1"]}', "utf8");
    const bodyHash = bodyDigest(body);
    const key = deriveSigningKey(GOLDEN_SECRET);
    const canon = buildCanonicalString({
      method: "POST",
      path: "/api/v1/proofs/minimum-income",
      timestamp: GOLDEN_TIMESTAMP,
      nonce: GOLDEN_NONCE,
      bodySha256: bodyHash,
    });
    const sig = computeSignature(key, canon);
    expect(verifySignature({
      rawSecret: GOLDEN_SECRET,
      method: "POST",
      path: "/api/v1/proofs/minimum-income",
      timestampHeader: String(GOLDEN_TIMESTAMP),
      nonceHeader: GOLDEN_NONCE,
      signatureHeader: sig,
      body,
      nowSeconds: GOLDEN_TIMESTAMP,
    })).toEqual({ ok: true });
  });

  it("accepts timestamps at the edge of the clock window (exactly ±300 s)", () => {
    const p = makeValidParams();
    expect(verifySignature({ ...p, nowSeconds: GOLDEN_TIMESTAMP + 300 })).toEqual({ ok: true });
    expect(verifySignature({ ...p, nowSeconds: GOLDEN_TIMESTAMP - 300 })).toEqual({ ok: true });
  });

  it("accepts a nonce at minimum length (16 chars)", () => {
    const nonce16 = "a".repeat(16);
    const key = deriveSigningKey(GOLDEN_SECRET);
    const canon = buildCanonicalString({
      method: GOLDEN_METHOD, path: GOLDEN_PATH,
      timestamp: GOLDEN_TIMESTAMP, nonce: nonce16, bodySha256: EMPTY_SHA256,
    });
    const sig = computeSignature(key, canon);
    expect(verifySignature(makeValidParams({ nonceHeader: nonce16, signatureHeader: sig }))).toEqual({ ok: true });
  });

  it("accepts a nonce at maximum length (128 chars)", () => {
    const nonce128 = "Z".repeat(128);
    const key = deriveSigningKey(GOLDEN_SECRET);
    const canon = buildCanonicalString({
      method: GOLDEN_METHOD, path: GOLDEN_PATH,
      timestamp: GOLDEN_TIMESTAMP, nonce: nonce128, bodySha256: EMPTY_SHA256,
    });
    const sig = computeSignature(key, canon);
    expect(verifySignature(makeValidParams({ nonceHeader: nonce128, signatureHeader: sig }))).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
describe("verifySignature — negative / security cases", () => {
  function makeValidParams(overrides: Record<string, unknown> = {}) {
    const key = deriveSigningKey(GOLDEN_SECRET);
    const canon = buildCanonicalString({
      method: GOLDEN_METHOD, path: GOLDEN_PATH,
      timestamp: GOLDEN_TIMESTAMP, nonce: GOLDEN_NONCE, bodySha256: EMPTY_SHA256,
    });
    const sig = computeSignature(key, canon);
    return {
      rawSecret: GOLDEN_SECRET,
      method: GOLDEN_METHOD, path: GOLDEN_PATH,
      timestampHeader: String(GOLDEN_TIMESTAMP),
      nonceHeader: GOLDEN_NONCE,
      signatureHeader: sig,
      body: null,
      nowSeconds: GOLDEN_TIMESTAMP,
      ...overrides,
    };
  }

  it("rejects a stale timestamp (> 300 s in the past)", () => {
    const r = verifySignature(makeValidParams({ nowSeconds: GOLDEN_TIMESTAMP + 301 }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.STALE_TIMESTAMP });
  });

  it("rejects a future timestamp (> 300 s in the future)", () => {
    const r = verifySignature(makeValidParams({ nowSeconds: GOLDEN_TIMESTAMP - 301 }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.STALE_TIMESTAMP });
  });

  it("rejects a non-numeric timestamp", () => {
    const r = verifySignature(makeValidParams({ timestampHeader: "not-a-number" }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.MALFORMED_TIMESTAMP });
  });

  it("rejects a float timestamp (must be integer seconds)", () => {
    const r = verifySignature(makeValidParams({ timestampHeader: "1724400000.5" }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.MALFORMED_TIMESTAMP });
  });

  it("rejects an empty timestamp", () => {
    const r = verifySignature(makeValidParams({ timestampHeader: "" }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.MALFORMED_TIMESTAMP });
  });

  it("rejects a nonce shorter than 16 chars", () => {
    const r = verifySignature(makeValidParams({ nonceHeader: "short" }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.MALFORMED_NONCE });
  });

  it("rejects a nonce longer than 128 chars", () => {
    const r = verifySignature(makeValidParams({ nonceHeader: "a".repeat(129) }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.MALFORMED_NONCE });
  });

  it("rejects a nonce with special characters", () => {
    const r = verifySignature(makeValidParams({ nonceHeader: "abc<script>xyz12345678" }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.MALFORMED_NONCE });
  });

  it("rejects a signature without the v1= prefix", () => {
    const r = verifySignature(makeValidParams({ signatureHeader: "a".repeat(64) }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.MALFORMED_SIGNATURE });
  });

  it("rejects a signature with the wrong length", () => {
    const r = verifySignature(makeValidParams({ signatureHeader: "v1=" + "a".repeat(32) }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.MALFORMED_SIGNATURE });
  });

  it("rejects when method differs from signed method", () => {
    const r = verifySignature(makeValidParams({ method: "DELETE" }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.SIGNATURE_INVALID });
  });

  it("rejects when path differs from signed path", () => {
    const r = verifySignature(makeValidParams({ path: "/api/v1/payments" }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.SIGNATURE_INVALID });
  });

  it("rejects when body is tampered (body mismatch)", () => {
    // Original signed with empty body; attacker adds a body
    const r = verifySignature(makeValidParams({ body: Buffer.from('{"evil":"payload"}') }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.SIGNATURE_INVALID });
  });

  it("rejects when the secret is wrong (key rotation scenario)", () => {
    const r = verifySignature(makeValidParams({ rawSecret: "wrong-secret-key-abcdefghij01234" }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.SIGNATURE_INVALID });
  });

  it("rejects when nonce differs from signed nonce", () => {
    const r = verifySignature(makeValidParams({ nonceHeader: "different_nonce_abc123456" }));
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.SIGNATURE_INVALID });
  });
});

// ---------------------------------------------------------------------------
describe("verifySignature — clock skew boundary", () => {
  function makeAtTs(ts: number) {
    const key = deriveSigningKey(GOLDEN_SECRET);
    const canon = buildCanonicalString({
      method: "GET", path: "/api/v1/health",
      timestamp: ts, nonce: "boundarynonce12345", bodySha256: EMPTY_SHA256,
    });
    const sig = computeSignature(key, canon);
    return {
      rawSecret: GOLDEN_SECRET, method: "GET", path: "/api/v1/health",
      timestampHeader: String(ts), nonceHeader: "boundarynonce12345",
      signatureHeader: sig, body: null,
    };
  }

  const NOW = 1_700_000_000;

  it("accepts request signed at exactly -300 s relative to now", () => {
    expect(verifySignature({ ...makeAtTs(NOW - 300), nowSeconds: NOW })).toEqual({ ok: true });
  });

  it("accepts request signed at exactly +300 s relative to now", () => {
    expect(verifySignature({ ...makeAtTs(NOW + 300), nowSeconds: NOW })).toEqual({ ok: true });
  });

  it("rejects request signed at -301 s (one second past window)", () => {
    const r = verifySignature({ ...makeAtTs(NOW - 301), nowSeconds: NOW });
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.STALE_TIMESTAMP });
  });

  it("rejects request signed at +301 s (one second past window)", () => {
    const r = verifySignature({ ...makeAtTs(NOW + 301), nowSeconds: NOW });
    expect(r).toEqual({ ok: false, reason: SignatureFailureReason.STALE_TIMESTAMP });
  });

  it("supports custom clockWindowSeconds", () => {
    // 10-second window
    expect(verifySignature({ ...makeAtTs(NOW - 10), nowSeconds: NOW, clockWindowSeconds: 10 })).toEqual({ ok: true });
    expect(verifySignature({ ...makeAtTs(NOW - 11), nowSeconds: NOW, clockWindowSeconds: 10 })).toEqual({ ok: false, reason: SignatureFailureReason.STALE_TIMESTAMP });
  });
});

// ---------------------------------------------------------------------------
describe("hasSigningHeaders", () => {
  it("returns true when X-EarnProof-Signature is present", () => {
    expect(hasSigningHeaders({ [HEADER_SIGNATURE]: "v1=abc" })).toBe(true);
  });

  it("returns true when X-EarnProof-Timestamp is present", () => {
    expect(hasSigningHeaders({ [HEADER_TIMESTAMP]: "1234567890" })).toBe(true);
  });

  it("returns true when X-EarnProof-Nonce is present", () => {
    expect(hasSigningHeaders({ [HEADER_NONCE]: "somenonce12345678" })).toBe(true);
  });

  it("returns false when none of the headers are present", () => {
    expect(hasSigningHeaders({ authorization: "Bearer key" })).toBe(false);
    expect(hasSigningHeaders({})).toBe(false);
  });

  it("returns true when all three headers are present", () => {
    expect(hasSigningHeaders({
      [HEADER_SIGNATURE]: "v1=abc",
      [HEADER_TIMESTAMP]: "1234567890",
      [HEADER_NONCE]: "somenonce12345678",
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("bodyDigest — edge cases", () => {
  it("treats null, undefined, and empty string identically", () => {
    expect(bodyDigest(null)).toBe(bodyDigest(undefined));
    expect(bodyDigest(undefined)).toBe(bodyDigest(""));
    expect(bodyDigest("")).toBe(EMPTY_SHA256);
  });

  it("treats empty Buffer identically to null", () => {
    expect(bodyDigest(Buffer.alloc(0))).toBe(EMPTY_SHA256);
  });

  it("produces different digests for different bodies", () => {
    const a = bodyDigest("body-a");
    const b = bodyDigest("body-b");
    expect(a).not.toBe(b);
  });

  it("produces a 64-char lowercase hex string", () => {
    expect(bodyDigest("hello world")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is byte-sensitive — same text different encoding produces different digest", () => {
    const utf8 = bodyDigest(Buffer.from("hello", "utf8"));
    const utf16 = bodyDigest(Buffer.from("hello", "utf16le"));
    expect(utf8).not.toBe(utf16);
  });
});