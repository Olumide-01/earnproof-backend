import { z } from "zod";
import { DEPLOYMENT_MANIFEST_MAX_BYTES } from "./deployment-manifest";

/**
 * ──────────────────────────────────────────────────────────────────────────
 * CONFIGURATION VALIDATION MATRIX
 * ──────────────────────────────────────────────────────────────────────────
 *
 * This module validates all environment variables across multiple profiles
 * (development, test, staging, production) with both individual constraints
 * and cross-variable invariant checks.
 *
 * Variable categories:
 * - REQUIRED: Must be present and non-empty
 * - OPTIONAL: Safe defaults if absent
 * - SECRET: Present, non-empty, but NEVER logged or included in error messages
 * - URL: Valid URL format, correct protocol per profile
 * - NETWORK: Valid host/port ranges, no unsafe binds in production profiles
 * - NUMERIC: Valid ranges, type-correct, no NaN/negative where inappropriate
 * - CRON: Valid cron expression parseable by NestJS @Cron()
 *
 * Cross-variable invariants prevent individually valid but jointly insecure
 * combinations (e.g., debug mode + production profile, wide-open CORS + prod DB).
 */

// ── Helper: Preprocess empty strings to undefined ──
function optionalString<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );
}

// ── Helper: SECRET variable validator (never expose value in error) ──
const secret = (minLength: number = 1) =>
  z
    .string()
    .min(minLength, { message: "SECRET_VARIABLE is missing or too short" })
    .refine((v) => v.trim().length > 0, {
      message: "SECRET_VARIABLE must not be empty or whitespace-only",
    });

// ── Helper: Validate cron expression format ──
// NestJS @Cron() accepts standard cron format (5 fields: minute hour day month weekday)
// and also supports seconds field (6 fields total). Validates both field count and
// semantic constraints: minute/hour/day/month/weekday/second ranges, step syntax, and
// day-of-month vs day-of-week mutual exclusivity (at most one can be non-*).
const cronExpression = z.string().refine(
  (value) => {
    const fields = value.trim().split(/\s+/);
    if (fields.length < 5 || fields.length > 6) return false;

    // Extract fields based on count: if 6 fields, first is second; if 5, no second
    let second, minute, hour, day, month, weekday;
    if (fields.length === 6) {
      [second, minute, hour, day, month, weekday] = fields;
    } else {
      [minute, hour, day, month, weekday] = fields;
      second = null;
    }

    // Helper: validate a single cron field
    const validateField = (field: string, min: number, max: number): boolean => {
      if (field === "*") return true;
      // Handle step syntax: */n or start-end/n
      if (field.includes("/")) {
        const [rangeStr, stepStr] = field.split("/");
        const step = parseInt(stepStr, 10);
        if (!Number.isInteger(step) || step <= 0) return false;
        if (rangeStr === "*") return true;
        // For ranges with steps, just validate the base range exists
        return validateField(rangeStr, min, max);
      }
      // Handle ranges: start-end
      if (field.includes("-")) {
        const [startStr, endStr] = field.split("-");
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        return (
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          start >= min &&
          end <= max &&
          start <= end
        );
      }
      // Handle lists: a,b,c
      if (field.includes(",")) {
        return field.split(",").every((part) => validateField(part, min, max));
      }
      // Single number
      const num = parseInt(field, 10);
      return Number.isInteger(num) && num >= min && num <= max;
    };

    // Validate each field with its allowed range
    if (second && !validateField(second, 0, 59)) return false;
    if (!validateField(minute, 0, 59)) return false;
    if (!validateField(hour, 0, 23)) return false;
    if (!validateField(day, 1, 31)) return false;
    if (!validateField(month, 1, 12)) return false;
    if (!validateField(weekday, 0, 7)) return false; // 0 or 7 = Sunday

    // Semantic check: day-of-month and day-of-week must not both be restricted
    // (cron spec: at most one of these two fields should be non-*)
    const dayRestricted = day !== "*";
    const weekdayRestricted = weekday !== "*";
    if (dayRestricted && weekdayRestricted) return false;

    return true;
  },
  {
    message:
      "CRON_VARIABLE must be a valid cron expression (minute hour day month weekday [second], with field ranges and semantic validity)",
  },
);

// ── Helper: Stellar contract ID format ──
const stellarContractId = z.string().regex(
  /^C[A-Z2-7]{55}$/,
  "CONTRACT_ID must be a valid Stellar contract ID (C followed by 55 alphanumeric chars)",
);

// ── Helper: Stellar public key (issuer address) format ──
const stellarPublicKey = z.string().regex(
  /^G[A-Z2-7]{55}$/,
  "PUBLIC_KEY must be a valid Stellar public key (G followed by 55 alphanumeric chars)",
);

// ── Helper: Encryption key validator ──
const encryptionKey = z.string().refine((value) => {
  try {
    const key = /^[a-fA-F0-9]{64}$/.test(value)
      ? Buffer.from(value, "hex")
      : Buffer.from(value, "base64");
    return key.length === 32;
  } catch {
    return false;
  }
}, "PAYMENT_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64-char hex");

// ── Helper: Positive integer (for ports, limits) ──
const positiveInt = (fieldNameOrMin: string | number, max?: number, defaultValue?: number) => {
  if (typeof fieldNameOrMin === "number") {
    let schema = z.coerce.number().int().min(fieldNameOrMin);
    if (max !== undefined) schema = schema.max(max);
    if (defaultValue !== undefined) return schema.default(defaultValue);
    return schema;
  }
  return z
    .coerce.number()
    .int(`${fieldNameOrMin} must be an integer`)
    .positive(`${fieldNameOrMin} must be a positive integer`)
    .finite(`${fieldNameOrMin} must be a finite number`);
};

// ── Helper: Non-negative integer (includes zero) ──
const nonnegativeInt = (fieldName: string) =>
  z
    .coerce.number()
    .int(`${fieldName} must be an integer`)
    .nonnegative(`${fieldName} must be zero or positive`)
    .finite(`${fieldName} must be a finite number`);

// ── Helper: Retention duration validator (1–3650 days) ──
const retentionDays = (fieldName: string) =>
  z
    .coerce.number()
    .int(`${fieldName} must be an integer`)
    .min(1, `${fieldName} must be at least 1 day (minimum 1)`)
    .max(3650, `${fieldName} must be at most 3650 days (maximum 10 years)`)
    .finite(`${fieldName} must be a finite number`);

/** Optional bounded integer with a default, for operational limits. */
const boundedInt = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).optional().default(fallback);

// ── Helper: Rate limit counter validator ──
// Bounds: 1–1000 per window. Higher values defeat the purpose of rate limiting.
const rateLimitCounter = (fieldName: string) =>
  z
    .coerce.number()
    .int(`${fieldName} must be an integer`)
    .positive(`${fieldName} must be positive (at least 1)`)
    .max(1000, `${fieldName} must not exceed 1000 (rate limiting would be ineffective)`)
    .finite(`${fieldName} must be a finite number`);

// ── Helper: Time window in milliseconds ──
// Bounds: > 0 and ≤ 1 hour. Windows > 1 hour make rate limiting ineffective.
const timeWindowMs = (fieldName: string) =>
  z
    .coerce.number()
    .int(`${fieldName} must be an integer`)
    .positive(`${fieldName} must be positive`)
    .max(3600000, `${fieldName} must not exceed 1 hour (3600000ms), or rate limiting becomes ineffective`)
    .finite(`${fieldName} must be a finite number`);

// ── Helper: Health probe timeout validator ──
const probeTimeoutMs = (fieldName: string) =>
  z
    .coerce.number()
    .int(`${fieldName} must be an integer`)
    .positive(`${fieldName} must be positive`)
    .max(30000, `${fieldName} must not exceed 30 seconds (30000ms)`)
    .finite(`${fieldName} must be a finite number`);

/**
 * Zod schema covering all environment variables across all profiles.
 * Individual field validation happens here; cross-variable checks happen
 * in validateEnv() after parsing.
 */
const envSchema = z.object({
  // ──────────────────────────────────────────────────────────────────────
  // CORE APPLICATION VARIABLES (Required)
  // ──────────────────────────────────────────────────────────────────────

  /** Application runtime environment: development, test, or production */
  NODE_ENV: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),

  /** HTTP server port (1–65535, but typically 3000–4000) */
  PORT: positiveInt("PORT").default(4000),

  /** PostgreSQL connection string (REQUIRED: checked at startup and readiness) */
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL must be non-empty")
    .url("DATABASE_URL must be a valid connection URL"),

  /** Redis connection string (REQUIRED: checked at startup) */
  REDIS_URL: z
    .string()
    .min(1, "REDIS_URL must be non-empty")
    .url("REDIS_URL must be a valid connection URL"),

  // ──────────────────────────────────────────────────────────────────────
  // APPLICATION URLs (Required, profile-specific)
  // ──────────────────────────────────────────────────────────────────────

  /** Frontend application URL (used for CORS origin, must be HTTPS in production) */
  APP_URL: z.string().url("APP_URL must be a valid URL").default("http://localhost:3000"),

  /** This backend API URL (used for Swagger docs, must be HTTPS in production) */
  API_URL: z.string().url("API_URL must be a valid URL").default("http://localhost:4000"),

  // ──────────────────────────────────────────────────────────────────────
  // STELLAR NETWORK CONFIGURATION (Required)
  // ──────────────────────────────────────────────────────────────────────

  /** Stellar network identifier (currently hardcoded to testnet) */
  STELLAR_NETWORK: z.literal("testnet").default("testnet"),

  /** Stellar Horizon API endpoint (must point to matching network) */
  STELLAR_HORIZON_URL: z
    .string()
    .url("STELLAR_HORIZON_URL must be a valid URL")
    .default("https://horizon-testnet.stellar.org"),

  /** Stellar network pass phrase (determines transaction signing/validation) */
  STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .min(1, "STELLAR_NETWORK_PASSPHRASE must be non-empty")
    .default("Test SDF Network ; September 2015"),

  /** Ledgers behind the last verified checkpoint that a divergence may reach */
  STELLAR_FINALITY_HISTORY_LEDGERS: z
    .coerce.number()
    .int("STELLAR_FINALITY_HISTORY_LEDGERS must be an integer")
    .positive("STELLAR_FINALITY_HISTORY_LEDGERS must be positive")
    .max(1_000_000, "STELLAR_FINALITY_HISTORY_LEDGERS is unreasonably large")
    .finite("STELLAR_FINALITY_HISTORY_LEDGERS must be a finite number")
    .default(17_280),

  /** Horizon pages one ledger reconciliation read may walk */
  STELLAR_FINALITY_RECONCILIATION_MAX_PAGES: z
    .coerce.number()
    .int("STELLAR_FINALITY_RECONCILIATION_MAX_PAGES must be an integer")
    .positive("STELLAR_FINALITY_RECONCILIATION_MAX_PAGES must be positive")
    .max(100, "STELLAR_FINALITY_RECONCILIATION_MAX_PAGES must not exceed 100")
    .finite("STELLAR_FINALITY_RECONCILIATION_MAX_PAGES must be a finite number")
    .default(10),

  // ──────────────────────────────────────────────────────────────────────
  // SECRETS (Required, never logged or exposed in error messages)
  // ──────────────────────────────────────────────────────────────────────

  /** Session token signing secret (minimum 8 chars, non-empty) */
  SESSION_SECRET: secret(8),

  /** Credential signature verification secret (minimum 8 chars, non-empty) */
  CREDENTIAL_SIGNING_SECRET: secret(8),
  CREDENTIAL_SIGNING_SECRET_PREVIOUS: optionalString(secret(8)),
  CREDENTIAL_SIGNING_KEY_ID: optionalString(
    z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  ),
  CREDENTIAL_SIGNING_PREVIOUS_KEY_ID: optionalString(
    z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  ),
  CREDENTIAL_SIGNING_KEY_OVERLAP_DAYS: retentionDays(
    "CREDENTIAL_SIGNING_KEY_OVERLAP_DAYS",
  ).default(30),

  /** Payment encryption key (32 bytes as hex or base64) */
  PAYMENT_ENCRYPTION_KEY: encryptionKey,
  PAYMENT_ENCRYPTION_KEY_VERSION: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0),

  // ──────────────────────────────────────────────────────────────────────
  // AUTHENTICATION RATE LIMITING
  // ──────────────────────────────────────────────────────────────────────

  /** Max challenge creations per hashed client within window */
  AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS: rateLimitCounter(
    "AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS",
  )
    .default(10),

  /** Time window for challenge creation limit (milliseconds) */
  AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS: timeWindowMs(
    "AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS",
  )
    .default(900000), // 15 minutes

  /** Max verification attempts per hashed client within window */
  AUTH_RATE_LIMIT_MAX_VERIFICATIONS: rateLimitCounter(
    "AUTH_RATE_LIMIT_MAX_VERIFICATIONS",
  )
    .default(5),

  /** Time window for verification limit (milliseconds) */
  AUTH_RATE_LIMIT_VERIFICATION_WINDOW_MS: timeWindowMs(
    "AUTH_RATE_LIMIT_VERIFICATION_WINDOW_MS",
  )
    .default(900000), // 15 minutes

  // ──────────────────────────────────────────────────────────────────────
  // AUTHENTICATION RETENTION & CLEANUP
  // ──────────────────────────────────────────────────────────────────────

  /** Retention duration for authentication challenges (days) */
  AUTH_CHALLENGE_RETENTION_DAYS: retentionDays("AUTH_CHALLENGE_RETENTION_DAYS")
    .default(7),

  /** Retention duration for authentication audit events (days) */
  AUTH_AUDIT_RETENTION_DAYS: retentionDays("AUTH_AUDIT_RETENTION_DAYS")
    .default(90),

  /** Cron expression for expired session cleanup (default: midnight) */
  AUTH_SESSION_CLEANUP_CRON: cronExpression.default("0 0 * * *"),

  /** Cron expression for old challenge cleanup (default: 2 AM) */
  AUTH_CHALLENGE_CLEANUP_CRON: cronExpression.default("0 2 * * *"),

  /** Cron expression for old audit event cleanup (default: 3 AM) */
  AUTH_AUDIT_CLEANUP_CRON: cronExpression.default("0 3 * * *"),

  // ──────────────────────────────────────────────────────────────────────
  // CONTRACT ANCHORING (Optional feature, with consistency checks)
  // ──────────────────────────────────────────────────────────────────────

  /** Whether contract anchoring is enabled */
  CONTRACT_ANCHORING_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false"),

  /** Whether contract anchoring is required for proofs */
  CONTRACT_ANCHORING_REQUIRED: z
    .enum(["true", "false"])
    .optional()
    .default("false"),

  /** Path to Stellar CLI executable */
  STELLAR_CLI_PATH: optionalString(z.string().min(1)),

  /** Source for Stellar CLI (e.g., "npm", "system") */
  STELLAR_CLI_SOURCE: optionalString(z.string().min(1)),

  /** Stellar contract ID for proof registry (matches ^C[A-Z2-7]{55}$) */
  PROOF_REGISTRY_CONTRACT_ID: optionalString(stellarContractId),

  // ──────────────────────────────────────────────────────────────────────
  // ISSUER REGISTRY (Optional feature)
  // ──────────────────────────────────────────────────────────────────────

  /** Whether issuer registry is enabled */
  ISSUER_REGISTRY_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false"),

  /** Stellar contract ID for issuer registry */
  ISSUER_REGISTRY_CONTRACT_ID: optionalString(stellarContractId),

  // ──────────────────────────────────────────────────────────────────────
  // DEPLOYMENT MANIFEST (Optional)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Deployment manifest JSON (network, contract addresses, artifact hashes).
   * Only bounded here; its structure and consistency with the Stellar and
   * contract variables are validated by deployment-manifest.ts and reported
   * through readiness, so a bad manifest takes the replica out of rotation
   * with a stable reason code instead of crash-looping it.
   */
  DEPLOYMENT_MANIFEST: optionalString(
    z
      .string()
      .max(
        DEPLOYMENT_MANIFEST_MAX_BYTES,
        `DEPLOYMENT_MANIFEST must not exceed ${DEPLOYMENT_MANIFEST_MAX_BYTES} characters`,
      ),
  ),

  // ──────────────────────────────────────────────────────────────────────
  // EARNPROOF INTEGRATION (Optional, used when anchoring is enabled)
  // ──────────────────────────────────────────────────────────────────────

  /** EarnProof issuer Stellar public key */
  EARNPROOF_ISSUER_ADDRESS: optionalString(stellarPublicKey),

  /** EarnProof schema version (numeric, optional) */
  EARNPROOF_SCHEMA_VERSION: z
    .coerce.number()
    .int("EARNPROOF_SCHEMA_VERSION must be an integer")
    .positive("EARNPROOF_SCHEMA_VERSION must be positive")
    .optional()
    .default(1),

  // ──────────────────────────────────────────────────────────────────────
  // VERIFICATION EVENT PRIVACY
  // ──────────────────────────────────────────────────────────────────────

  /** Retention duration for verification events (days) */
  VERIFICATION_EVENT_RETENTION_DAYS: retentionDays(
    "VERIFICATION_EVENT_RETENTION_DAYS",
  )
    .default(90),
  WEBHOOK_MAX_DELIVERY_ATTEMPTS: boundedInt(1, 20, 5),
  WEBHOOK_REDRIVE_MAX_BATCH: boundedInt(1, 100, 25),
  PROOF_SHARE_TOKEN_MAX_TTL_MINUTES: boundedInt(5, 525_600, 10_080),
  PROOF_SHARE_TOKEN_DEFAULT_TTL_MINUTES: boundedInt(5, 525_600, 1_440),
  QUOTA_MAX_ACTIVE_API_KEYS: boundedInt(1, 10_000, 25),
  QUOTA_MAX_WEBHOOKS: boundedInt(1, 1_000, 10),
  QUOTA_PROOF_REQUESTS_PER_DAY: boundedInt(1, 10_000_000, 1_000),
  QUOTA_SYNCS_PER_HOUR: boundedInt(1, 3_600, 12),

  /** Hash salt version for verification metadata privacy */
  VERIFICATION_HASH_SALT_VERSION: nonnegativeInt(
    "VERIFICATION_HASH_SALT_VERSION",
  )
    .default(0),

  /** Maximum stored verification metadata events per proof in the budget window */
  VERIFICATION_METADATA_BUDGET_PER_PROOF: rateLimitCounter(
    "VERIFICATION_METADATA_BUDGET_PER_PROOF",
  ).default(100),

  /** Privacy-budget window for stored verification metadata */
  VERIFICATION_METADATA_BUDGET_WINDOW_MS: timeWindowMs(
    "VERIFICATION_METADATA_BUDGET_WINDOW_MS",
  ).default(86400000),

  // ──────────────────────────────────────────────────────────────────────
  // DATA RETENTION (All retention durations validated at startup)
  // ──────────────────────────────────────────────────────────────────────

  /** Retention duration for wallet challenge records (days, 1–3650) */
  RETENTION_WALLET_CHALLENGE_DAYS: retentionDays(
    "RETENTION_WALLET_CHALLENGE_DAYS",
  )
    .default(7),

  /** Retention duration for authentication session records (days, 1–3650) */
  RETENTION_AUTH_SESSION_DAYS: retentionDays("RETENTION_AUTH_SESSION_DAYS")
    .default(30),

  /** Retention duration for webhook delivery records (days, 1–3650) */
  RETENTION_WEBHOOK_DELIVERY_DAYS: retentionDays(
    "RETENTION_WEBHOOK_DELIVERY_DAYS",
  )
    .default(30),

  /** Retention duration for audit log records (days, 1–3650) */
  RETENTION_AUDIT_LOG_DAYS: retentionDays("RETENTION_AUDIT_LOG_DAYS").default(
    365,
  ),

  /** Retention duration for failed anchoring records (days, 1–3650) */
  RETENTION_FAILED_ANCHORING_DAYS: retentionDays(
    "RETENTION_FAILED_ANCHORING_DAYS",
  )
    .default(90),

  /** Cron expression for retention cleanup job (default: 3 AM daily) */
  RETENTION_CLEANUP_CRON: cronExpression.default("0 3 * * *"),

  /** Enable dry-run mode to report what would be deleted without actually deleting */
  RETENTION_DRY_RUN: z
    .enum(["true", "false"])
    .optional()
    .default("false"),

  // ──────────────────────────────────────────────────────────────────────
  // DATA RETENTION - PRESERVED RECORDS (not automatically swept)
  // These have no override in practice but are included for completeness:
  // Proofs, revocation evidence, and anchoring state must never be
  // automatically deleted (they are evidence the protocol exists to produce).
  // Operators may still configure these if extending defaults, but the
  // retention.ts cleanup job respects the PRESERVED sweep mode regardless.
  // ──────────────────────────────────────────────────────────────────────

  /** Retention duration for proof credentials (days, 1–3650, PRESERVED = never auto-swept) */
  RETENTION_PROOF_DAYS: optionalString(retentionDays("RETENTION_PROOF_DAYS")),

  /** Retention duration for revocation evidence (days, 1–3650, PRESERVED = never auto-swept) */
  RETENTION_REVOCATION_DAYS: optionalString(
    retentionDays("RETENTION_REVOCATION_DAYS"),
  ),

  /** Retention duration for anchoring state (days, 1–3650, PRESERVED = never auto-swept) */
  RETENTION_ANCHORING_STATE_DAYS: optionalString(
    retentionDays("RETENTION_ANCHORING_STATE_DAYS"),
  ),

  // ──────────────────────────────────────────────────────────────────────
  // HEALTH CHECKS
  // ──────────────────────────────────────────────────────────────────────

  /** Health probe timeout (milliseconds, max 30 seconds) */
  HEALTH_PROBE_TIMEOUT_MS: probeTimeoutMs("HEALTH_PROBE_TIMEOUT_MS")
    .default(2000),

  /** Health probe result cache TTL (milliseconds) */
  HEALTH_CACHE_TTL_MS: nonnegativeInt("HEALTH_CACHE_TTL_MS").default(5000),

  // ──────────────────────────────────────────────────────────────────────
  // CLOCK SKEW MONITORING (#328) — measures only, never adjusts a clock
  // ──────────────────────────────────────────────────────────────────────

  CLOCK_SKEW_MONITOR_ENABLED: optionalString(z.enum(["true", "false"])),
  CLOCK_SKEW_INTERVAL_MS: boundedInt(5_000, 3_600_000, 60_000),
  CLOCK_SKEW_PROBE_TIMEOUT_MS: boundedInt(100, 30_000, 2_000),
  CLOCK_SKEW_WARN_MS: boundedInt(1, 3_600_000, 2_000),
  CLOCK_SKEW_CRITICAL_MS: boundedInt(2, 3_600_000, 10_000),
  CLOCK_SKEW_MAX_ROUND_TRIP_MS: boundedInt(1, 60_000, 5_000),
  CLOCK_SKEW_MAX_SAMPLE_AGE_MS: boundedInt(1_000, 86_400_000, 180_000),
  CLOCK_SKEW_SUSTAIN_FOR_MS: boundedInt(0, 86_400_000, 300_000),
  CLOCK_SKEW_CLEAR_AFTER_ASSESSMENTS: boundedInt(1, 100, 2),
  CLOCK_SKEW_LEDGER_CLOSE_ALLOWANCE_MS: boundedInt(0, 120_000, 10_000),
  CLOCK_SKEW_UNKNOWN_POLICY: z
    .enum(["fail_closed", "fail_open"])
    .optional()
    .default("fail_open"),
  CLOCK_SKEW_READINESS_IMPACT: z.enum(["none", "critical"]).optional().default("critical"),

  // ──────────────────────────────────────────────────────────────────────
  // OPERATIONAL METRIC ROLLUPS (#330)
  // ──────────────────────────────────────────────────────────────────────

  METRICS_ROLLUP_ENABLED: z.enum(["true", "false"]).optional().default("true"),
  METRICS_ROLLUP_LATENESS_GRACE_MS: boundedInt(0, 3_600_000, 120_000),
  METRICS_ROLLUP_SETTLE_DELAY_MS: boundedInt(0, 600_000, 30_000),
  METRICS_ROLLUP_RAW_RETENTION_HOURS: boundedInt(2, 168, 6),
  METRICS_ROLLUP_MINUTE_RETENTION_DAYS: boundedInt(1, 31, 3),
  METRICS_ROLLUP_HOUR_RETENTION_DAYS: boundedInt(2, 731, 90),
  METRICS_ROLLUP_DAY_RETENTION_DAYS: boundedInt(30, 3650, 730),

  // ──────────────────────────────────────────────────────────────────────
  // CONFIGURATION ROLLOUTS (#329)
  // ──────────────────────────────────────────────────────────────────────

  DEPLOYMENT_ENVIRONMENT: optionalString(
    z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "DEPLOYMENT_ENVIRONMENT must be a lowercase slug"),
  ),
  CONFIG_SNAPSHOT_SIGNING_SECRET: optionalString(secret(32)),
  CONFIG_ROLLOUT_MAX_GATE_EVIDENCE_AGE_MS: boundedInt(1_000, 86_400_000, 900_000),
  CONFIG_ROLLOUT_GATE_VALIDITY_MS: boundedInt(1_000, 86_400_000, 3_600_000),
  CONFIG_ROLLOUT_REQUIRED_GATE_CHECKS: optionalString(
    z.string().regex(/^[a-z][a-z0-9_]{0,63}(,[a-z][a-z0-9_]{0,63}){0,15}$/, {
      message: "CONFIG_ROLLOUT_REQUIRED_GATE_CHECKS must be a comma-separated list of snake_case names",
    }),
  ),
  CONFIG_ROLLOUT_DEFAULT_STAGES: optionalString(
    z.string().regex(/^\d{1,3}(,\d{1,3}){0,9}$/, {
      message: "CONFIG_ROLLOUT_DEFAULT_STAGES must be a comma-separated list of percentages",
    }),
  ),

  // ──────────────────────────────────────────────────────────────────────
  // PAYMENT ACCOUNT ROTATION (#321)
  // ──────────────────────────────────────────────────────────────────────

  PAYMENT_ACCOUNT_ROTATION_CHALLENGE_TTL_MS: boundedInt(60_000, 3_600_000, 600_000),
  PAYMENT_ACCOUNT_ROTATION_ROLLBACK_WINDOW_MS: boundedInt(0, 2_592_000_000, 86_400_000),

  // ──────────────────────────────────────────────────────────────────────
  // TESTING (Integration test harness only, not used in production)
  // ──────────────────────────────────────────────────────────────────────

  /** PostgreSQL connection string for integration tests (must contain "test") */
  TEST_DATABASE_URL: optionalString(
    z.string().url("TEST_DATABASE_URL must be a valid URL"),
  ),

  /** Whether to keep test databases after integration tests complete */
  INTEGRATION_KEEP_DATABASES: optionalString(
    z.enum(["true", "false"]),
  ),

  /** Integration test timeout in milliseconds */
  INTEGRATION_TEST_TIMEOUT_MS: optionalString(
    timeWindowMs("INTEGRATION_TEST_TIMEOUT_MS"),
  ),

  // ──────────────────────────────────────────────────────────────────────
  // SEEDING
  // ──────────────────────────────────────────────────────────────────────

  /** Allow synthetic seed data (demo seed) in non-production environments */
  ALLOW_SYNTHETIC_SEED: optionalString(z.enum(["true", "false"])),

  // ──────────────────────────────────────────────────────────────────────
  // GLOBAL API RATE LIMITING
  // ──────────────────────────────────────────────────────────────────────

  /** Default global request window in milliseconds */
  RATE_LIMIT_DEFAULT_TTL_MS: timeWindowMs("RATE_LIMIT_DEFAULT_TTL_MS")
    .default(60000),

  /** Default global request count */
  RATE_LIMIT_DEFAULT_LIMIT: rateLimitCounter("RATE_LIMIT_DEFAULT_LIMIT")
    .default(100),

  /** Strict request window for expensive operations in milliseconds */
  RATE_LIMIT_STRICT_TTL_MS: timeWindowMs("RATE_LIMIT_STRICT_TTL_MS")
    .default(60000),

  /** Strict request count for expensive operations */
  RATE_LIMIT_STRICT_LIMIT: rateLimitCounter("RATE_LIMIT_STRICT_LIMIT")
    .default(10),

  /** Public verification request window in milliseconds */
  RATE_LIMIT_VERIFICATION_TTL_MS: timeWindowMs(
    "RATE_LIMIT_VERIFICATION_TTL_MS",
  )
    .default(60000),

  /** Public verification request count */
  RATE_LIMIT_VERIFICATION_LIMIT: rateLimitCounter(
    "RATE_LIMIT_VERIFICATION_LIMIT",
  )
    .default(30),

  /** Multiplier applied to authenticated caller request limits */
  RATE_LIMIT_AUTHENTICATED_MULTIPLIER: z
    .coerce.number()
    .positive("RATE_LIMIT_AUTHENTICATED_MULTIPLIER must be positive")
    .finite("RATE_LIMIT_AUTHENTICATED_MULTIPLIER must be finite")
    .default(3),

  /** Proof-verification abuse-control window */
  PROOF_VERIFICATION_ABUSE_WINDOW_MS: timeWindowMs(
    "PROOF_VERIFICATION_ABUSE_WINDOW_MS",
  ).default(900000),

  /** Unknown proof identifiers allowed per privacy-safe client in the window */
  PROOF_VERIFICATION_UNKNOWN_LIMIT: rateLimitCounter(
    "PROOF_VERIFICATION_UNKNOWN_LIMIT",
  ).default(10),

  /** Repeated verification attempts allowed per proof and client */
  PROOF_VERIFICATION_REPEATED_LIMIT: rateLimitCounter(
    "PROOF_VERIFICATION_REPEATED_LIMIT",
  ).default(60),

  /** Distinct proof identifiers allowed per privacy-safe client */
  PROOF_VERIFICATION_DISTINCT_CLIENT_LIMIT: rateLimitCounter(
    "PROOF_VERIFICATION_DISTINCT_CLIENT_LIMIT",
  ).default(100),
});

/**
 * Cross-variable invariant checks.
 * These invariants prevent combinations that are individually valid but
 * jointly insecure or misconfigured (e.g., debug mode in production).
 *
 * Each invariant must:
 * - Be profile-specific (use NODE_ENV to branch)
 * - Include a detailed comment explaining the risk
 * - Reference the environment variables by key name only (never expose values)
 */
// ── Helper: Extract hostname from a connection URL, robust to userinfo ──
// (e.g. "postgresql://user:pass@127.0.0.1:5432/db") which a naive regex on
// "//" up to the next ":" would mistake the username for the host.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
function isLocalhostUrl(value: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function checkCrossVariableInvariants(data: z.infer<typeof envSchema>) {
  const errors: string[] = [];

  // ────────────────────────────────────────────────────────────────────────
  // PRODUCTION-LIKE PROFILE INVARIANTS
  // ────────────────────────────────────────────────────────────────────────

  if (data.NODE_ENV === "production") {
    // Invariant: HTTPS-only URLs in production
    // Risk: Unencrypted traffic to/from production API exposes credentials,
    // tokens, and proof data to network interception.
    if (!data.APP_URL.startsWith("https://")) {
      errors.push(
        "Invalid configuration: APP_URL must use https:// in production profile",
      );
    }
    if (!data.API_URL.startsWith("https://")) {
      errors.push(
        "Invalid configuration: API_URL must use https:// in production profile",
      );
    }

    // Invariant: Database URL must use production or secure host
    // Risk: Connecting to "localhost" in production means the database is
    // not remotely accessible (good) but indicates misconfiguration; operator
    // likely meant to set a remote host. Catch this early.
    if (isLocalhostUrl(data.DATABASE_URL)) {
      errors.push(
        "Invalid configuration: DATABASE_URL appears to be localhost in production profile (likely misconfigured)",
      );
    }

    // Invariant: Redis URL must not be localhost
    // Risk: Same as database — remote Redis access required in production.
    if (isLocalhostUrl(data.REDIS_URL)) {
      errors.push(
        "Invalid configuration: REDIS_URL appears to be localhost in production profile (likely misconfigured)",
      );
    }

    // Invariant: Contract anchoring consistency
    // Risk: If CONTRACT_ANCHORING_REQUIRED is true but REQUIRED fields are
    // missing, every proof attempt fails. Catch this at startup, not at first
    // proof attempt.
    if (data.CONTRACT_ANCHORING_REQUIRED === "true") {
      if (!data.PROOF_REGISTRY_CONTRACT_ID) {
        errors.push(
          "Invalid configuration: CONTRACT_ANCHORING_REQUIRED=true but PROOF_REGISTRY_CONTRACT_ID is missing",
        );
      }
      if (!data.EARNPROOF_ISSUER_ADDRESS) {
        errors.push(
          "Invalid configuration: CONTRACT_ANCHORING_REQUIRED=true but EARNPROOF_ISSUER_ADDRESS is missing",
        );
      }
    }

    // Invariant: If issuer registry is required, contract must be set
    // Risk: Feature cannot function without configuration.
    if (data.ISSUER_REGISTRY_ENABLED === "true") {
      if (!data.ISSUER_REGISTRY_CONTRACT_ID) {
        errors.push(
          "Invalid configuration: ISSUER_REGISTRY_ENABLED=true but ISSUER_REGISTRY_CONTRACT_ID is missing",
        );
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // STAGING & PRODUCTION-LIKE PROFILE INVARIANTS
  // ────────────────────────────────────────────────────────────────────────

  if (data.NODE_ENV === "production" || data.NODE_ENV === "staging") {
    // Invariant: Rate limit window must be ≤ 1 hour across all profiles
    // Risk: Overly long windows make rate limiting ineffective; attackers can
    // spread abuse across the window without triggering limits.
    const challengeWindowHours =
      data.AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS / (1000 * 60 * 60);
    if (challengeWindowHours > 1) {
      errors.push(
        "Invalid configuration: AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS exceeds 1 hour in production-like profile (must be ≤ 3600000ms)",
      );
    }

    const verificationWindowHours =
      data.AUTH_RATE_LIMIT_VERIFICATION_WINDOW_MS / (1000 * 60 * 60);
    if (verificationWindowHours > 1) {
      errors.push(
        "Invalid configuration: AUTH_RATE_LIMIT_VERIFICATION_WINDOW_MS exceeds 1 hour in production-like profile (must be ≤ 3600000ms)",
      );
    }

    // Invariant: Rate limit counts must be reasonable
    // Risk: Very high limits defeat the purpose of rate limiting.
    if (data.AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS > 100) {
      errors.push(
        "Invalid configuration: AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS seems unreasonably high (>100) in production-like profile",
      );
    }
    if (data.AUTH_RATE_LIMIT_MAX_VERIFICATIONS > 50) {
      errors.push(
        "Invalid configuration: AUTH_RATE_LIMIT_MAX_VERIFICATIONS seems unreasonably high (>50) in production-like profile",
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // TEST PROFILE INVARIANTS
  // ────────────────────────────────────────────────────────────────────────

  if (data.NODE_ENV === "test") {
    // Invariant: Test database must be distinct from production
    // Risk: Running tests against a real production database can corrupt data.
    // While the harness validates this, we check here as defense-in-depth.
    if (data.TEST_DATABASE_URL) {
      const urlObj = new URL(data.TEST_DATABASE_URL);
      const dbName = urlObj.pathname.split("/").pop() || "";
      if (!dbName.includes("test")) {
        errors.push(
          "Invalid configuration: TEST_DATABASE_URL database name must contain 'test' (detected: " +
            dbName +
            ")",
        );
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // ALL PROFILES: Health probe timeout must be reasonable
  // ────────────────────────────────────────────────────────────────────────

  // Invariant: Probe timeout should not exceed container startup probe timeout
  // Risk: If the health check hangs for longer than the orchestrator's own
  // probe timeout, probes timeout before Kiro finishes, creating redundant
  // failures and slower debugging.
  if (data.HEALTH_PROBE_TIMEOUT_MS > 25000) {
    errors.push(
      "Invalid configuration: HEALTH_PROBE_TIMEOUT_MS should not exceed 25 seconds (most orchestrators use 30s timeout)",
    );
  }

  // Invariant: clock skew thresholds are ordered and samples outlive one interval.
  // Risk: a critical threshold at or below the warning threshold makes the
  // warning tier unreachable; a sample age shorter than the sampling interval
  // makes every assessment UNKNOWN between samples.
  if (data.CLOCK_SKEW_CRITICAL_MS <= data.CLOCK_SKEW_WARN_MS) {
    errors.push(
      "Invalid configuration: CLOCK_SKEW_CRITICAL_MS must be greater than CLOCK_SKEW_WARN_MS",
    );
  }
  if (data.CLOCK_SKEW_MAX_SAMPLE_AGE_MS < data.CLOCK_SKEW_INTERVAL_MS) {
    errors.push(
      "Invalid configuration: CLOCK_SKEW_MAX_SAMPLE_AGE_MS must be at least CLOCK_SKEW_INTERVAL_MS",
    );
  }

  // Invariant: each metric tier is retained long enough to be rolled up.
  // Risk: deleting a lower tier before the tier above it has sealed would
  // silently drop data from long-term charts.
  const hourMs = 3_600_000;
  const dayMs = 24 * hourMs;
  const rawMs = data.METRICS_ROLLUP_RAW_RETENTION_HOURS * hourMs;
  const minuteMs = data.METRICS_ROLLUP_MINUTE_RETENTION_DAYS * dayMs;
  const hourTierMs = data.METRICS_ROLLUP_HOUR_RETENTION_DAYS * dayMs;
  const dayTierMs = data.METRICS_ROLLUP_DAY_RETENTION_DAYS * dayMs;
  if (!(rawMs < minuteMs && minuteMs < hourTierMs && hourTierMs < dayTierMs)) {
    errors.push(
      "Invalid configuration: METRICS_ROLLUP retention must increase strictly from raw to minute to hour to day",
    );
  }
  const rollupHorizonMs =
    data.METRICS_ROLLUP_LATENESS_GRACE_MS + data.METRICS_ROLLUP_SETTLE_DELAY_MS;
  if (rawMs <= 60_000 + rollupHorizonMs + hourMs) {
    errors.push(
      "Invalid configuration: METRICS_ROLLUP_RAW_RETENTION_HOURS is shorter than the minute rollup horizon",
    );
  }

  // Invariant: canary stages are strictly increasing percentages ending at 100.
  if (data.CONFIG_ROLLOUT_DEFAULT_STAGES) {
    const stages = data.CONFIG_ROLLOUT_DEFAULT_STAGES.split(",").map(Number);
    const ordered = stages.every((stage, index) => index === 0 || stage > stages[index - 1]);
    if (!ordered || stages[0] < 1 || stages[stages.length - 1] !== 100) {
      errors.push(
        "Invalid configuration: CONFIG_ROLLOUT_DEFAULT_STAGES must strictly increase from at least 1 and end at 100",
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Return accumulated errors
  // ────────────────────────────────────────────────────────────────────────

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed: ${errors.join("; ")}`);
  }
}

/**
 * Validates all environment variables against the schema and cross-variable
 * invariants. Runs at application startup to ensure fast failure before the
 * server begins listening.
 *
 * Error messages include variable keys but NEVER expose secret values.
 *
 * @param config Raw environment variables from process.env
 * @returns Typed and validated configuration object
 * @throws Error if validation fails (causes immediate process exit)
 */
/**
 * Matches versioned verification hash salt keys: VERIFICATION_HASH_SALT_V0,
 * VERIFICATION_HASH_SALT_V1, etc. These are dynamically numbered (see
 * VerificationEventService, which loads VERIFICATION_HASH_SALT_V{n} for
 * n = 0.. until it hits a gap) so they cannot be listed individually in the
 * schema. Validated separately: any key matching this pattern must be a
 * non-empty string of reasonable length if present at all.
 */
const VERIFICATION_HASH_SALT_KEY_PATTERN = /^VERIFICATION_HASH_SALT_V\d+$/;

/**
 * Matches versioned payment encryption key keys: PAYMENT_ENCRYPTION_KEY_V0,
 * PAYMENT_ENCRYPTION_KEY_V1, etc. Like salts, these are dynamically numbered
 * and loaded until a gap is found. Each must be a valid 32-byte encryption key.
 */
const PAYMENT_ENCRYPTION_KEY_KEY_PATTERN = /^PAYMENT_ENCRYPTION_KEY_V\d+$/;

const versionedSalt = z
  .string()
  .min(16, "must be at least 16 characters (used as an HMAC salt)");

/**
 * Validates VERIFICATION_HASH_SALT_V* keys, which are not part of the fixed
 * envSchema shape since their count/numbering is operator-controlled.
 * Returns field-level error strings (empty array if all valid).
 */
function validateVersionedSalts(config: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(config)) {
    if (!VERIFICATION_HASH_SALT_KEY_PATTERN.test(key)) continue;
    const value = config[key];
    if (value === undefined || value === "") continue; // treat as absent
    const result = versionedSalt.safeParse(value);
    if (!result.success) {
      errors.push(`${key} ${result.error.issues[0]?.message ?? "is invalid"}`);
    }
  }
  return errors;
}

/**
 * Validates PAYMENT_ENCRYPTION_KEY_V* keys, which are dynamically numbered
 * similar to salts but represent 32-byte encryption keys.
 * Returns field-level error strings (empty array if all valid).
 */
function validateVersionedPaymentKeys(config: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(config)) {
    if (!PAYMENT_ENCRYPTION_KEY_KEY_PATTERN.test(key)) continue;
    const value = config[key];
    if (value === undefined || value === "") continue; // treat as absent
    const result = encryptionKey.safeParse(value);
    if (!result.success) {
      errors.push(`${key} must be 32 bytes encoded as base64 or 64-char hex`);
    }
  }
  return errors;
}

export function validateEnv(config: Record<string, unknown>) {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    // Format each issue as a single readable line naming the offending
    // variable, so error messages stay grep-able and match-able (zod v4's
    // raw error.message is multi-line JSON, which is hard to read and hard
    // to test against with a single regex).
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }

  const saltErrors = validateVersionedSalts(config);
  const paymentKeyErrors = validateVersionedPaymentKeys(config);
  
  if (saltErrors.length > 0 || paymentKeyErrors.length > 0) {
    const allErrors = [...saltErrors, ...paymentKeyErrors];
    throw new Error(
      `Invalid environment:\n${allErrors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  if (
    parsed.data.PROOF_SHARE_TOKEN_DEFAULT_TTL_MINUTES >
    parsed.data.PROOF_SHARE_TOKEN_MAX_TTL_MINUTES
  ) {
    throw new Error(
      "Invalid environment: PROOF_SHARE_TOKEN_DEFAULT_TTL_MINUTES must not exceed PROOF_SHARE_TOKEN_MAX_TTL_MINUTES",
    );
  }
  // Check cross-variable invariants after individual field validation
  checkCrossVariableInvariants(parsed.data);

  return parsed.data;
}
