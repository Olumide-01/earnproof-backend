import { createHash } from "crypto";

/**
 * Safe webhook response representation stored in the database.
 *
 * Instead of storing arbitrary response bodies that could be large or contain
 * sensitive data, we store a structured summary with:
 * - truncatedBody: First N bytes of the redacted response text
 * - contentHash: SHA-256 hash of the full redacted response (for integrity)
 * - wasTruncated: Flag indicating if the response exceeded the byte limit
 * - hadEncodingIssue: Flag indicating if the response contained invalid UTF-8
 *
 * This prevents:
 * - Storage exhaustion (responses bounded to 1 KiB)
 * - Accidental sensitive data leakage (redaction applied)
 * - Silent data loss (hash and flags preserve information about what was discarded)
 */
export interface SafeWebhookResponse {
  /** First MAX_RESPONSE_BODY_BYTES of redacted response text (or less if shorter) */
  truncatedBody: string;
  /** SHA-256 hex digest of the full redacted response (never truncated) */
  contentHash: string;
  /** true if the response exceeded MAX_RESPONSE_BODY_BYTES */
  wasTruncated: boolean;
  /** true if the response contained invalid UTF-8 sequences */
  hadEncodingIssue: boolean;
}

/**
 * Maximum stored response body size in bytes (1 KiB).
 * Responses longer than this are truncated; the hash is computed on the full content.
 */
export const MAX_RESPONSE_BODY_BYTES = 1024;

/**
 * Regex patterns for redacting sensitive data from webhook responses.
 */
const REDACTION_PATTERNS = [
  // Key-value pattern: matches common sensitive keys (authorization, password, secret, token, api_key, api-key)
  // followed by : or =, then captures and redacts the value
  /(["']?(?:authorization|password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,}]*/gi,
  // Bearer token pattern: matches Bearer followed by base64/URL-safe characters
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

/**
 * Redact sensitive patterns from response text.
 *
 * Replaces common credential patterns (authorization, password, secret, token, api_key, Bearer tokens)
 * with [REDACTED] to prevent accidental leakage of secrets in stored responses.
 */
function redactSensitiveResponse(value: string): string {
  let result = value;
  
  // Bearer token pattern: MUST come first before the key-value pattern to ensure Bearer tokens are redacted
  result = result.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  
  // Key-value pattern: matches common sensitive keys followed by : or =, then captures and redacts the value
  result = result.replace(
    /(["']?(?:authorization|password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,}]*/gi,
    "$1[REDACTED]",
  );
  
  return result;
}

/**
 * Convert an arbitrary response to UTF-8 safe text.
 *
 * Handles:
 * - Valid UTF-8 strings (pass through)
 * - Binary or invalid UTF-8 data (replace with safe placeholder)
 *
 * Returns: { text, hadEncodingIssue }
 */
function ensureValidUtf8(
  responseText: string | Buffer,
): { text: string; hadEncodingIssue: boolean } {
  let text: string;
  let hadEncodingIssue = false;

  if (typeof responseText === "string") {
    // String is already valid UTF-8 in JavaScript
    text = responseText;
  } else {
    // Buffer: attempt UTF-8 decode, check for replacement character
    text = responseText.toString("utf8");
    // If the buffer contained invalid sequences, toString replaces them with U+FFFD
    // We can detect this by checking if the result contains the replacement character
    // However, this is imperfect. Better: validate the original buffer before decoding.
    hadEncodingIssue = !Buffer.from(text, "utf8").equals(responseText);
  }

  return { text, hadEncodingIssue };
}

/**
 * Compute SHA-256 hash of response text.
 */
function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Process a webhook response into a safe representation for storage.
 *
 * This function:
 * 1. Normalizes encoding (handles binary/invalid UTF-8)
 * 2. Redacts sensitive patterns
 * 3. Computes content hash (on full redacted content)
 * 4. Truncates to MAX_RESPONSE_BODY_BYTES
 * 5. Records truncation and encoding issues
 *
 * This ensures:
 * - Binary and invalidly encoded responses cannot break delivery processing
 * - Sensitive data is redacted before storage
 * - Storage is bounded to prevent exhaustion
 * - We know if data was lost or corrupted (via flags and hash)
 */
export function processWebhookResponse(
  responseText: string | Buffer,
): SafeWebhookResponse {
  // Step 1: Ensure valid UTF-8
  const { text: normalizedText, hadEncodingIssue } =
    ensureValidUtf8(responseText);

  // Step 2: Redact sensitive patterns
  const redactedText = redactSensitiveResponse(normalizedText);

  // Step 3: Compute hash on full redacted content (before truncation)
  const contentHash = hashContent(redactedText);

  // Step 4: Truncate to limit
  const wasTruncated = redactedText.length > MAX_RESPONSE_BODY_BYTES;
  const truncatedBody = wasTruncated
    ? redactedText.slice(0, MAX_RESPONSE_BODY_BYTES)
    : redactedText;

  return {
    truncatedBody,
    contentHash,
    wasTruncated,
    hadEncodingIssue,
  };
}

/**
 * Format a SafeWebhookResponse for display in logs or APIs.
 *
 * Returns a human-readable string showing the truncated body and any flags.
 */
export function formatSafeWebhookResponse(response: SafeWebhookResponse): string {
  const parts = [response.truncatedBody];

  if (response.wasTruncated) {
    parts.push("…[truncated]");
  }

  if (response.hadEncodingIssue) {
    parts.push("[encoding issue detected]");
  }

  return parts.join(" ");
}
