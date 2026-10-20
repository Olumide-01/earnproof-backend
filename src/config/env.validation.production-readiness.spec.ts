import { validateEnv } from "./env.validation";

/** Validation for the clock skew, metric rollup, config rollout and payment rotation settings. */
describe("validateEnv production-readiness settings", () => {
  // Synthetic placeholders only.
  const baseEnv = {
    DATABASE_URL: "postgresql://user:password@localhost:5432/earnproof",
    REDIS_URL: "redis://localhost:6379",
    SESSION_SECRET: "session_secret_123",
    CREDENTIAL_SIGNING_SECRET: "credential_secret_123",
    PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  };

  it("applies documented defaults", () => {
    expect(validateEnv(baseEnv)).toMatchObject({
      CLOCK_SKEW_UNKNOWN_POLICY: "fail_open",
      CLOCK_SKEW_READINESS_IMPACT: "critical",
      CLOCK_SKEW_WARN_MS: 2_000,
      CLOCK_SKEW_CRITICAL_MS: 10_000,
      METRICS_ROLLUP_RAW_RETENTION_HOURS: 6,
      METRICS_ROLLUP_DAY_RETENTION_DAYS: 730,
      PAYMENT_ACCOUNT_ROTATION_CHALLENGE_TTL_MS: 600_000,
    });
  });

  it("treats empty optional rollout settings as unset", () => {
    expect(() =>
      validateEnv({ ...baseEnv, DEPLOYMENT_ENVIRONMENT: "", CONFIG_SNAPSHOT_SIGNING_SECRET: "" }),
    ).not.toThrow();
  });

  it.each([
    ["critical at or below warn", { CLOCK_SKEW_WARN_MS: "5000", CLOCK_SKEW_CRITICAL_MS: "5000" }, /CLOCK_SKEW_CRITICAL_MS/],
    ["sample age shorter than the interval", { CLOCK_SKEW_INTERVAL_MS: "120000", CLOCK_SKEW_MAX_SAMPLE_AGE_MS: "60000" }, /CLOCK_SKEW_MAX_SAMPLE_AGE_MS/],
    ["an unknown unknown-time policy", { CLOCK_SKEW_UNKNOWN_POLICY: "ignore" }, /CLOCK_SKEW_UNKNOWN_POLICY/],
    ["minute retention not exceeding hour retention", { METRICS_ROLLUP_MINUTE_RETENTION_DAYS: "5", METRICS_ROLLUP_HOUR_RETENTION_DAYS: "5" }, /retention must increase/],
    ["stages not ending at 100", { CONFIG_ROLLOUT_DEFAULT_STAGES: "5,50" }, /CONFIG_ROLLOUT_DEFAULT_STAGES/],
    ["non-increasing stages", { CONFIG_ROLLOUT_DEFAULT_STAGES: "50,25,100" }, /CONFIG_ROLLOUT_DEFAULT_STAGES/],
    ["a non-slug environment", { DEPLOYMENT_ENVIRONMENT: "Prod East" }, /DEPLOYMENT_ENVIRONMENT/],
    ["a short snapshot signing secret", { CONFIG_SNAPSHOT_SIGNING_SECRET: "short" }, /CONFIG_SNAPSHOT_SIGNING_SECRET/],
    ["a challenge TTL under a minute", { PAYMENT_ACCOUNT_ROTATION_CHALLENGE_TTL_MS: "1000" }, /PAYMENT_ACCOUNT_ROTATION_CHALLENGE_TTL_MS/],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() => validateEnv({ ...baseEnv, ...overrides })).toThrow(message);
  });

  it("never echoes the snapshot signing secret in an error", () => {
    const secret = "tiny-secret";
    try {
      validateEnv({ ...baseEnv, CONFIG_SNAPSHOT_SIGNING_SECRET: secret });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });
});
