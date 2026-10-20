/**
 * Redaction for integration-test output.
 *
 * An integration test talks to a real database, so its failure output is built
 * from real material: Prisma puts the datasource in connection errors, a failed
 * `toEqual` prints whole rows including `amountEncrypted` and `tokenHash`, and a
 * rejected assertion prints the token a test just minted. Test output is the
 * least guarded surface in the system — it lands in CI logs, in terminal
 * scrollback, and pasted into issues — so the values that the application takes
 * care never to log must not arrive there through a failing test either.
 *
 * This is deliberately NOT `src/common/observability/redaction.ts`. That module
 * is tuned for a single log line: it collapses runs of whitespace and truncates
 * at 512 characters. Applied to a Jest diff it would destroy the very thing the
 * reader needs — the line structure showing which field differs — and clip the
 * tail of any diff longer than a few rows. The rules here therefore preserve
 * layout and length, and cover the shapes this repository actually stores:
 * `enc:v<N>:` protected amounts, `sha256:` credential hashes, opaque session
 * tokens, and `postgresql://` connection strings.
 *
 * Redaction is by pattern AND by field name. Pattern alone misses a value whose
 * shape is unremarkable (a webhook secret is just base64); field name alone
 * misses everything that arrives inside free-form prose, which is how a
 * connection string reaches a Prisma error message.
 */

/** Placeholder written in place of a redacted value. */
const MASK = {
  connectionString: "[REDACTED_CONNECTION_STRING]",
  sessionToken: "[REDACTED_SESSION_TOKEN]",
  walletAddress: "[REDACTED_WALLET_ADDRESS]",
  protectedAmount: "[REDACTED_PROTECTED_AMOUNT]",
  signingMaterial: "[REDACTED_SIGNING_MATERIAL]",
  credential: "[REDACTED_CREDENTIAL]",
  hash: "[REDACTED_HASH]",
  field: "[REDACTED]",
  env: "[REDACTED_ENV_VALUE]",
} as const;

/**
 * Environment variables whose *values* are replaced wherever they appear.
 *
 * A literal match is the only rule that can catch a secret with no recognisable
 * shape. `PAYMENT_ENCRYPTION_KEY` is base64 and `SESSION_SECRET` may be any
 * string an operator chose; neither has a pattern, but both are known verbatim
 * at the moment the test runs.
 */
const SENSITIVE_ENV_KEYS = [
  "TEST_DATABASE_URL",
  "DATABASE_URL",
  "SESSION_SECRET",
  "CREDENTIAL_SIGNING_SECRET",
  "PAYMENT_ENCRYPTION_KEY",
  "PGPASSWORD",
  "VERIFICATION_HASH_SALT_V0",
] as const;

/**
 * Columns and DTO fields that must never surface in a diff.
 *
 * Matched as JSON-ish `"key": "value"` and as Jest's object-diff form
 * `key: 'value'`, because a failure prints both depending on the matcher.
 */
const SENSITIVE_FIELDS = [
  "amountEncrypted",
  "thresholdEncrypted",
  "secretEncrypted",
  "tokenHash",
  "keyHash",
  "nonceHash",
  "walletAddress",
  "walletHash",
  "subjectWalletHash",
  "sourceAddress",
  "destinationAddress",
  "sourceAddressEncrypted",
  "destinationAddressEncrypted",
  "sourceAddressLookup",
  "stellarAddress",
  "credentialHash",
  "commitment",
  "metadataHash",
  "signature",
  "signedPayload",
  "token",
  "secret",
  "password",
] as const;

const FIELD_NAMES = SENSITIVE_FIELDS.join("|");

/**
 * Ordered rules. Order matters for the same reason it does in the production
 * redactor: a broad pattern run early consumes the text a narrow one was meant
 * to classify. The opaque session token is `<id>.<64 hex>` and would otherwise
 * be half-eaten by the generic hex-digest rule, so it runs first.
 */
const RULES: ReadonlyArray<{ pattern: RegExp; mask: string }> = [
  // Opaque bearer session token: `<16 url-safe chars>.<64 hex>`.
  { pattern: /\b[A-Za-z0-9_-]{16}\.[a-f0-9]{64}\b/g, mask: MASK.sessionToken },

  // Any URI carrying userinfo — this is the connection-string leak.
  {
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@"'`<>]+:[^\s/@"'`<>]*@[^\s"'`<>]+/gi,
    mask: MASK.connectionString,
  },
  // Postgres URIs without credentials still name host and database.
  {
    pattern: /\bpostgres(?:ql)?:\/\/[^\s"'`<>]+/gi,
    mask: MASK.connectionString,
  },

  // Sensitive fields in JSON output: "amountEncrypted": "enc:v1:…".
  {
    pattern: new RegExp(`("(?:${FIELD_NAMES})"\\s*:\\s*)"[^"]*"`, "g"),
    mask: `$1"${MASK.field}"`,
  },
  // The same fields in Jest's object-diff rendering: amountEncrypted: 'enc:v1:…'.
  {
    pattern: new RegExp(`\\b((?:${FIELD_NAMES})\\s*:\\s*)'[^']*'`, "g"),
    mask: `$1'${MASK.field}'`,
  },

  // AES-256-GCM protected amount, and the legacy form it replaced. The
  // number after "v" is the payment-encryption key version (see
  // docs/key-rotation.md), not a wire-format marker, so it must match any
  // version — not just the key that happens to be active today.
  {
    pattern: /\benc:v\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g,
    mask: MASK.protectedAmount,
  },
  { pattern: /\bredacted:[A-Za-z0-9_-]{8,}/g, mask: MASK.protectedAmount },

  // Stellar secret seed. Must precede the address rule: a seed and an address
  // differ only in their leading byte.
  { pattern: /\bS[A-Z0-9]{55}\b/g, mask: MASK.signingMaterial },
  // Stellar public key and muxed account, including the synthetic variants the
  // factories emit (which contain digits outside the base32 alphabet).
  { pattern: /\bG[A-Z0-9]{55}\b/g, mask: MASK.walletAddress },
  { pattern: /\bM[A-Z0-9]{68}\b/g, mask: MASK.walletAddress },
  { pattern: /\bC[A-Z0-9]{55}\b/g, mask: MASK.hash },

  // Fixture secrets, which are recognisable by construction.
  {
    pattern: /\bsynthetic-not-a-real-secret-[A-Za-z0-9]+/g,
    mask: MASK.signingMaterial,
  },

  // Credential hashes and wallet hashes in the application's `sha256:` form.
  { pattern: /\bsha256:[A-Za-z0-9_+/=-]{8,}/gi, mask: MASK.hash },

  // Bare hex digests: HMAC signatures, token hashes, transaction hashes.
  { pattern: /\b[0-9a-f]{32,}\b/gi, mask: MASK.hash },

  // Long base64 runs: signed payloads, encryption keys, webhook secrets.
  { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, mask: MASK.credential },

  // KEY=value leakage from a spawned CLI's stderr.
  {
    pattern: new RegExp(
      `\\b(${SENSITIVE_ENV_KEYS.join("|")})\\s*[=:]\\s*\\S+`,
      "g",
    ),
    mask: `$1=${MASK.env}`,
  },
];

/** Shortest environment value worth matching literally. */
const MIN_LITERAL_SECRET_LENGTH = 8;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces the literal values of known-sensitive environment variables.
 *
 * Runs before the pattern rules so that a secret which happens to have no
 * recognisable shape is still removed.
 */
function redactLiteralEnvironmentValues(input: string): string {
  let output = input;

  for (const key of SENSITIVE_ENV_KEYS) {
    const value = process.env[key];
    if (!value || value.length < MIN_LITERAL_SECRET_LENGTH) continue;
    output = output.replace(new RegExp(escapeRegExp(value), "g"), MASK.env);
  }

  return output;
}

/**
 * Redacts sensitive material from test output.
 *
 * Unlike the production log redactor this preserves whitespace and imposes no
 * length limit: a Jest diff is only readable while its line structure survives,
 * and a clipped diff hides the mismatch it was printed to show.
 */
export function redactTestOutput(input: string): string {
  if (!input) return "";

  let output = redactLiteralEnvironmentValues(input);

  for (const { pattern, mask } of RULES) {
    output = output.replace(pattern, mask);
  }

  return output;
}

/**
 * Deep-redacts an arbitrary value, returning a structurally identical copy.
 *
 * Used for error `meta` payloads, which Prisma populates with constraint
 * details and which a reporter will stringify verbatim.
 */
export function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 6) return MASK.field;
  if (typeof value === "string") return redactTestOutput(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      result[key] = redactUnknown(source[key], depth + 1);
    }
    return result;
  }
  return value;
}

/**
 * Redacts an error's message, stack, and metadata **in place**.
 *
 * Mutating rather than replacing is deliberate. Tests assert on
 * `error.code === "P2002"` and on `instanceof PrismaClientKnownRequestError`;
 * rethrowing a different object would preserve the message but break both, so
 * the harness would trade one kind of unreadable failure for another.
 */
export function redactErrorInPlace<T>(error: T): T {
  if (!(error instanceof Error)) return error;

  error.message = redactTestOutput(error.message);

  if (typeof error.stack === "string") {
    error.stack = redactTestOutput(error.stack);
  }

  const withMeta = error as unknown as { meta?: unknown };
  if (withMeta.meta !== undefined) {
    withMeta.meta = redactUnknown(withMeta.meta);
  }

  const nested = (error as unknown as { cause?: unknown }).cause;
  if (nested instanceof Error) {
    redactErrorInPlace(nested);
  }

  return error;
}

/** Convenience for harness code that must build a message from a raw value. */
export function safe(value: unknown): string {
  return redactTestOutput(typeof value === "string" ? value : String(value));
}
