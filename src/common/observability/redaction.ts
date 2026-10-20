/**
 * Redaction for operational log output.
 *
 * Logs are the one place where free-form text legitimately reaches an operator,
 * which makes them the place where sensitive values leak. An exception message
 * from Horizon, the Stellar CLI, or Prisma can carry a wallet address, a memo,
 * a signed payload, or a connection string with credentials — none of which the
 * responder needs and all of which the log will retain.
 *
 * This module redacts by *pattern*, not by field name, because the leak
 * normally arrives inside a string that was never a structured field:
 * `"tx failed for GABC…XYZ: insufficient balance 42.5 USDC"`.
 *
 * Redaction is deliberately conservative. It is better to blank an operationally
 * useful figure than to retain an identifier, so an amount-like token is
 * replaced even though amounts are occasionally useful in a diagnosis. The
 * shape of the error — which pattern matched, in what order — survives, and
 * that is what actually drives a runbook.
 */

/** Placeholder written in place of a redacted value. */
const MASK = {
  stellarSecret: "[REDACTED_SECRET]",
  stellarAddress: "[REDACTED_ADDRESS]",
  contractId: "[REDACTED_CONTRACT]",
  hash: "[REDACTED_HASH]",
  url: "[REDACTED_URL]",
  amount: "[REDACTED_AMOUNT]",
  env: "[REDACTED_ENV]",
  jwt: "[REDACTED_TOKEN]",
  base64: "[REDACTED_PAYLOAD]",
} as const;

/**
 * Ordered redaction rules. Order matters: the most specific pattern must run
 * first, or a broader rule will consume the text a narrower one was meant to
 * classify. A Stellar secret seed and a public address are both 56-character
 * base32 strings distinguished only by their leading byte, so the secret rule
 * runs first and the address rule cannot reclassify what it already masked.
 */
const RULES: ReadonlyArray<{ pattern: RegExp; mask: string }> = [
  // Stellar secret seed: S + 55 base32 chars. Must precede the address rule.
  { pattern: /\bS[A-Z2-7]{55}\b/g, mask: MASK.stellarSecret },
  // Stellar public key: G + 55 base32 chars.
  { pattern: /\bG[A-Z2-7]{55}\b/g, mask: MASK.stellarAddress },
  // Muxed account: M + 68 base32 chars.
  { pattern: /\bM[A-Z2-7]{68}\b/g, mask: MASK.stellarAddress },
  // Soroban contract ID: C + 55 base32 chars.
  { pattern: /\bC[A-Z2-7]{55}\b/g, mask: MASK.contractId },
  // JWT-shaped token. Precedes the generic base64 rule.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    mask: MASK.jwt,
  },
  // KEY=VALUE environment leakage, as seen in CLI stderr.
  { pattern: /\b[A-Z][A-Z0-9_]{2,}=\S+/g, mask: MASK.env },
  // URLs, which carry both endpoints and query-string parameters.
  { pattern: /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, mask: MASK.url },
  // Hex digests of 32 bytes or more: proof IDs, credential hashes, tx hashes.
  { pattern: /\b[0-9a-f]{64,}\b/gi, mask: MASK.hash },
  // Long base64 runs: signed payloads, envelopes, signatures.
  { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, mask: MASK.base64 },
  // Decimal amounts, with or without a trailing asset code.
  {
    pattern: /\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:[A-Z]{2,12}\b)?/g,
    mask: MASK.amount,
  },
];

/**
 * Amount redaction would otherwise eat every integer in a message, including
 * the counts and durations an operator needs. These tokens are restored after
 * the amount rule runs.
 */
const SAFE_NUMERIC_CONTEXT =
  /\b(attempt|attempts|retry|retries|count|batch|size|total|page|limit|offset|status|code|ms|seconds?|minutes?|hours?|days?|rows?|records?|deleted|skipped|processed)\b/i;

/** Upper bound on a redacted message, so one pathological error cannot flood the log. */
const MAX_MESSAGE_LENGTH = 512;

/**
 * Redacts sensitive material from a free-form string.
 *
 * Returns a message that is safe to write to an operational log. The result is
 * truncated to {@link MAX_MESSAGE_LENGTH}; truncation is marked so a reader can
 * tell a short message from a clipped one.
 */
export function redact(input: string): string {
  if (!input) return "";

  // Amounts are handled per-token so that a number adjacent to a counting word
  // survives. Applying the rule to the whole string cannot make that
  // distinction, and a log line reading "attempt [REDACTED_AMOUNT] of
  // [REDACTED_AMOUNT]" is useless during an incident.
  let output = input;

  for (const { pattern, mask } of RULES) {
    if (mask === MASK.amount) {
      output = redactAmountsPreservingCounts(output);
      continue;
    }
    output = output.replace(pattern, mask);
  }

  output = output.replace(/\s+/g, " ").trim();

  if (output.length > MAX_MESSAGE_LENGTH) {
    return `${output.slice(0, MAX_MESSAGE_LENGTH)}…[truncated]`;
  }

  return output;
}

/**
 * Masks amount-like tokens while leaving numbers that a counting word governs.
 *
 * "processed 12 records" keeps its 12; "balance 12.5 USDC" does not.
 *
 * Each numeric token is judged against a window of surrounding text rather than
 * on its own, because the same digits mean different things in "attempt 3" and
 * "balance 3". The window is read from the original string via the match offset
 * — an earlier implementation folded the leading context into the match itself,
 * which meant a token's context was consumed by the token before it, and
 * "attempt 3 of 10" lost its 10.
 */
function redactAmountsPreservingCounts(input: string): string {
  const AMOUNT = /\b\d{1,3}(?:,\d{3})*(?:\.\d+)?(\s*[A-Z]{2,12}\b)?/g;

  return input.replace(AMOUNT, (match, assetCode: string | undefined, offset: number) => {
    // A trailing asset code makes it a monetary value regardless of context.
    if (assetCode) return MASK.amount;

    const before = input.slice(Math.max(0, offset - 24), offset);
    const after = input.slice(
      offset + match.length,
      offset + match.length + 24,
    );

    if (SAFE_NUMERIC_CONTEXT.test(before) || SAFE_NUMERIC_CONTEXT.test(after)) {
      return match;
    }

    // A bare integer with no decimal part is far more likely to be a count than
    // a balance; a decimal with no counting context is treated as monetary.
    if (/^\d{1,4}$/.test(match)) return match;

    return MASK.amount;
  });
}

/**
 * Extracts a redacted, loggable message from an unknown thrown value.
 *
 * Never returns a stack trace: stacks carry file paths and, in interpolated
 * frames, argument values. The exception's constructor name is preserved
 * because it is a bounded, non-identifying signal that is genuinely useful when
 * triaging.
 */
export function redactError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || "Error";
    return `${name}: ${redact(error.message)}`;
  }

  if (typeof error === "string") {
    return redact(error);
  }

  if (error && typeof error === "object") {
    // Deliberately not JSON.stringify: serialising an arbitrary object is how a
    // whole request body ends up in a log line.
    return `${(error as object).constructor?.name ?? "Object"}: [unserialised error]`;
  }

  return "UnknownError: [no message]";
}

/**
 * Structured fields permitted alongside a log message.
 *
 * Unlike metric labels, a log field may carry a high-cardinality *correlation*
 * value — a request ID or a job run ID. That is the point of the split: logs
 * are queried by identifier, metrics are aggregated by dimension, and the same
 * value must not appear in both.
 *
 * The fields remain privacy-bounded. A correlation ID is an opaque random
 * value that identifies a request, not a person.
 */
export interface LogContext {
  [key: string]: unknown;
  /** Propagated from `X-Request-ID`. Correlates a log line to one HTTP request. */
  requestId?: string;
  /** Identifies one execution of a scheduled job. */
  jobRunId?: string;
  /** Bounded workflow name, matching the metric label vocabulary. */
  workflow?: string;
  /** Bounded outcome, matching the metric label vocabulary. */
  outcome?: string;
  /** Duration in milliseconds. A measurement, not an identifier. */
  durationMs?: number;
  /** Row or item count. A measurement, not an identifier. */
  count?: number;
}

/** Keys that must never appear in a {@link LogContext}. */
const FORBIDDEN_LOG_FIELDS = new Set<string>([
  "walletAddress",
  "wallet",
  // Payment account addresses, and their protected forms: ciphertext and
  // lookup tokens are stable per address, so logging them links records.
  "sourceAddress",
  "destinationAddress",
  "sourceAddressEncrypted",
  "destinationAddressEncrypted",
  "sourceAddressLookup",
  "proofId",
  "credentialHash",
  "commitment",
  "amount",
  "memo",
  "url",
  "signature",
  "token",
  "tokenHash",
  "secret",
  "payload",
  "body",
  "stack",
]);

/** Raised when a log context carries a field that must not be logged. */
export class ForbiddenLogFieldError extends Error {
  constructor(field: string) {
    super(
      `Log field "${field}" is forbidden: it carries sensitive or unbounded data. ` +
        `Log a correlation identifier and look the value up in the database instead.`,
    );
    this.name = "ForbiddenLogFieldError";
  }
}

/**
 * Renders a log context as a stable `key=value` suffix.
 *
 * Throws {@link ForbiddenLogFieldError} rather than dropping a bad field, for
 * the same reason the metric registry throws: a silently dropped field makes a
 * log line look complete when it is not.
 */
export function formatContext(context: LogContext | undefined): string {
  if (!context) return "";

  const parts: string[] = [];

  for (const [key, value] of Object.entries(context)) {
    if (FORBIDDEN_LOG_FIELDS.has(key)) {
      throw new ForbiddenLogFieldError(key);
    }
    if (value === undefined || value === null) continue;

    // A correlation value is opaque by construction, but it arrives from a
    // client-controlled header, so it is constrained before being written.
    const rendered =
      typeof value === "string" ? redact(value).slice(0, 128) : String(value);
    parts.push(`${key}=${rendered}`);
  }

  return parts.length ? ` [${parts.join(" ")}]` : "";
}
