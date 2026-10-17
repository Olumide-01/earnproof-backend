/**
 * Collects PAYMENT_ENCRYPTION_KEY_V0, _V1, ... into an indexed object
 * (`{ 0: "...", 1: "..." }`) for the payment-encryption keyring service.
 * Loads until the first gap, same convention as VERIFICATION_HASH_SALT_V*.
 */
function loadPaymentEncryptionKeyVersions(): Record<number, string> {
  const versions: Record<number, string> = {};
  for (let i = 0; i < 100; i++) {
    const value = process.env[`PAYMENT_ENCRYPTION_KEY_V${i}`];
    if (value) {
      versions[i] = value;
    } else {
      break;
    }
  }
  return versions;
}

export const configuration = () => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  apiUrl: process.env.API_URL ?? "http://localhost:4000",
  stellar: {
    network: process.env.STELLAR_NETWORK ?? "testnet",
    horizonUrl:
      process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE ??
      "Test SDF Network ; September 2015",
  },
  sessionSecret: process.env.SESSION_SECRET,
  credentialSigningSecret: process.env.CREDENTIAL_SIGNING_SECRET,
  paymentEncryptionKey: process.env.PAYMENT_ENCRYPTION_KEY,
  paymentEncryptionKeyVersions: loadPaymentEncryptionKeyVersions(),
  paymentEncryptionKeyVersion: Number(
    process.env.PAYMENT_ENCRYPTION_KEY_VERSION ?? 0,
  ),
  verificationEventRetentionDays: Number(
    process.env.VERIFICATION_EVENT_RETENTION_DAYS ?? 90,
  ),
  verificationHashSaltVersion: Number(
    process.env.VERIFICATION_HASH_SALT_VERSION ?? 0,
  ),
  auth: {
    challengeRetentionDays: Number(
      process.env.AUTH_CHALLENGE_RETENTION_DAYS ?? 7,
    ),
    auditRetentionDays: Number(process.env.AUTH_AUDIT_RETENTION_DAYS ?? 90),
    sessionCleanupCron: process.env.AUTH_SESSION_CLEANUP_CRON ?? "0 0 * * *",
    challengeCleanupCron: process.env.AUTH_CHALLENGE_CLEANUP_CRON ?? "0 2 * * *",
    auditCleanupCron: process.env.AUTH_AUDIT_CLEANUP_CRON ?? "0 3 * * *",
    rateLimits: {
      maxChallengeCreations: Number(
        process.env.AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS ?? 10,
      ),
      challengeCreationWindowMs: Number(
        process.env.AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS ?? 900000, // 15 minutes
      ),
      maxVerifications: Number(
        process.env.AUTH_RATE_LIMIT_MAX_VERIFICATIONS ?? 5,
      ),
      verificationWindowMs: Number(
        process.env.AUTH_RATE_LIMIT_VERIFICATION_WINDOW_MS ?? 900000, // 15 minutes
      ),
    },
  },
  contractAnchoring: {
    enabled: process.env.CONTRACT_ANCHORING_ENABLED === "true",
    required: process.env.CONTRACT_ANCHORING_REQUIRED === "true",
    stellarCliPath: process.env.STELLAR_CLI_PATH ?? "stellar",
    source: process.env.STELLAR_CLI_SOURCE,
    proofRegistryContractId: process.env.PROOF_REGISTRY_CONTRACT_ID,
    issuerAddress: process.env.EARNPROOF_ISSUER_ADDRESS,
    schemaVersion: Number(process.env.EARNPROOF_SCHEMA_VERSION ?? 1),
  },
  health: {
    // Probe timeout. Must stay below the orchestrator's own probe timeout, or a
    // slow dependency produces overlapping in-flight probes against a system
    // that is already struggling.
    probeTimeoutMs: Number(process.env.HEALTH_PROBE_TIMEOUT_MS ?? 2000),
    // How long a probe result is reused. Readiness is polled continuously by
    // every replica and load balancer, so without caching the probe load scales
    // with poll rate rather than with anything meaningful.
    cacheTtlMs: Number(process.env.HEALTH_CACHE_TTL_MS ?? 5000),
  },
  capacityMetrics: {
    enabled: process.env.CAPACITY_METRICS_ENABLED === "true",
    samplerCron: process.env.CAPACITY_SAMPLER_CRON ?? "*/5 * * * *",
  },
  issuerRegistry: {
    enabled: process.env.ISSUER_REGISTRY_ENABLED === "true",
    stellarCliPath: process.env.STELLAR_CLI_PATH ?? "stellar",
    source: process.env.STELLAR_CLI_SOURCE,
    contractId: process.env.ISSUER_REGISTRY_CONTRACT_ID,
  },
  retention: {
    walletChallengeDays: Number(
      process.env.RETENTION_WALLET_CHALLENGE_DAYS ?? 7,
    ),
    authSessionDays: Number(process.env.RETENTION_AUTH_SESSION_DAYS ?? 30),
    webhookDeliveryDays: Number(
      process.env.RETENTION_WEBHOOK_DELIVERY_DAYS ?? 30,
    ),
    auditLogDays: Number(process.env.RETENTION_AUDIT_LOG_DAYS ?? 365),
    failedAnchoringDays: Number(
      process.env.RETENTION_FAILED_ANCHORING_DAYS ?? 90,
    ),
    cleanupCron: process.env.RETENTION_CLEANUP_CRON ?? "0 3 * * *",
    dryRun: process.env.RETENTION_DRY_RUN === "true",
  },
  rateLimit: {
    // "default": the global ceiling applied to every route that does not opt
    // into a stricter named throttler below. Anonymous callers get this limit;
    // RoleAwareThrottlerGuard multiplies it for authenticated callers.
    defaultTtlMs: Number(process.env.RATE_LIMIT_DEFAULT_TTL_MS ?? 60_000),
    defaultLimit: Number(process.env.RATE_LIMIT_DEFAULT_LIMIT ?? 100),
    // "strict": expensive operations such as proof creation and payment sync.
    strictTtlMs: Number(process.env.RATE_LIMIT_STRICT_TTL_MS ?? 60_000),
    strictLimit: Number(process.env.RATE_LIMIT_STRICT_LIMIT ?? 10),
    // "verification": public proof-verification lookups.
    verificationTtlMs: Number(
      process.env.RATE_LIMIT_VERIFICATION_TTL_MS ?? 60_000,
    ),
    verificationLimit: Number(process.env.RATE_LIMIT_VERIFICATION_LIMIT ?? 30),
    authenticatedMultiplier: Number(
      process.env.RATE_LIMIT_AUTHENTICATED_MULTIPLIER ?? 3,
    ),
  },
});
