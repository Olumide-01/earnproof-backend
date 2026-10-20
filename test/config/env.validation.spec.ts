import { validateEnv } from "../../src/config/env.validation";

/**
 * CONFIGURATION VALIDATION TEST MATRIX
 *
 * This test suite covers the complete validation schema across all profiles:
 * - Unit validation: each variable type, constraint, and boundary
 * - Cross-variable invariants: combinations that are individually valid but
 *   jointly insecure or misconfigured
 * - Profile-specific rules: development, test, staging, production
 *
 * Tests ensure:
 * - Secret values are never exposed in error messages
 * - Error messages name the offending variable key
 * - Validation fails fast before partial startup
 * - All variable categories are covered
 */

describe("Configuration Validation (env.validation.ts)", () => {
  // ──────────────────────────────────────────────────────────────────────
  // HAPPY PATH: Development profile
  // ──────────────────────────────────────────────────────────────────────

  describe("Happy path: development profile", () => {
    it("accepts minimal valid development config", () => {
      const config = {
        NODE_ENV: "development",
        PORT: "4000",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        REDIS_URL: "redis://localhost:6379",
        APP_URL: "http://localhost:3000",
        API_URL: "http://localhost:4000",
        STELLAR_NETWORK: "testnet",
        STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
        STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      };

      const result = validateEnv(config);

      expect(result.NODE_ENV).toBe("development");
      expect(result.PORT).toBe(4000);
      expect(result.DATABASE_URL).toBe(config.DATABASE_URL);
    });

    it("applies all defaults for optional fields", () => {
      const config = {
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        REDIS_URL: "redis://localhost:6379",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      };

      const result = validateEnv(config);

      expect(result.PORT).toBe(4000);
      expect(result.APP_URL).toBe("http://localhost:3000");
      expect(result.API_URL).toBe("http://localhost:4000");
      expect(result.STELLAR_NETWORK).toBe("testnet");
      expect(result.VERIFICATION_EVENT_RETENTION_DAYS).toBe(90);
      expect(result.AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS).toBe(10);
    });

    it("accepts non-HTTPS URLs in development", () => {
      const config = {
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        REDIS_URL: "redis://localhost:6379",
        APP_URL: "http://localhost:3000",
        API_URL: "http://localhost:4000",
        STELLAR_NETWORK: "testnet",
        STELLAR_HORIZON_URL: "http://horizon-testnet.stellar.org",
        STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
        SESSION_SECRET: "dev-session-secret-8-chars",
        CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
        PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      };

      // Should not throw
      expect(() => validateEnv(config)).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // HAPPY PATH: Production profile
  // ──────────────────────────────────────────────────────────────────────

  describe("Happy path: production profile", () => {
    it("accepts valid production config with HTTPS URLs and remote hosts", () => {
      const config = {
        NODE_ENV: "production",
        PORT: "4000",
        DATABASE_URL: "postgresql://user:pass@db.example.com:5432/prod_db",
        REDIS_URL: "redis://redis.example.com:6379",
        APP_URL: "https://app.example.com",
        API_URL: "https://api.example.com",
        STELLAR_NETWORK: "testnet",
        STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
        STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
        SESSION_SECRET: "prod-session-secret-very-long-secure-value",
        CREDENTIAL_SIGNING_SECRET: "prod-cred-secret-very-long-secure-value",
        PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      };

      const result = validateEnv(config);

      expect(result.NODE_ENV).toBe("production");
      expect(result.APP_URL).toBe("https://app.example.com");
      expect(result.API_URL).toBe("https://api.example.com");
    });

    it("accepts production config with reasonable rate limits", () => {
      const config = {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://user:pass@db.example.com:5432/prod_db",
        REDIS_URL: "redis://redis.example.com:6379",
        APP_URL: "https://app.example.com",
        API_URL: "https://api.example.com",
        STELLAR_NETWORK: "testnet",
        STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
        STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
        SESSION_SECRET: "prod-session-secret-very-long-secure-value",
        CREDENTIAL_SIGNING_SECRET: "prod-cred-secret-very-long-secure-value",
        PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS: "10",
        AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS: "600000", // 10 minutes
        AUTH_RATE_LIMIT_MAX_VERIFICATIONS: "5",
        AUTH_RATE_LIMIT_VERIFICATION_WINDOW_MS: "600000",
      };

      // Should not throw
      expect(() => validateEnv(config)).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // REQUIRED VARIABLES
  // ──────────────────────────────────────────────────────────────────────

  describe("Required variables", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("fails when DATABASE_URL is missing", () => {
      const config = { ...baseConfig };
      delete (config as any).DATABASE_URL;

      expect(() => validateEnv(config)).toThrow(
        /DATABASE_URL|must be non-empty/,
      );
    });

    it("fails when REDIS_URL is missing", () => {
      const config = { ...baseConfig };
      delete (config as any).REDIS_URL;

      expect(() => validateEnv(config)).toThrow(/REDIS_URL|must be non-empty/);
    });

    it("fails when SESSION_SECRET is missing", () => {
      const config = { ...baseConfig };
      delete (config as any).SESSION_SECRET;

      expect(() => validateEnv(config)).toThrow(/SESSION_SECRET/);
    });

    it("fails when SESSION_SECRET is too short (< 8 chars)", () => {
      const config = {
        ...baseConfig,
        SESSION_SECRET: "short",
      };

      expect(() => validateEnv(config)).toThrow(/SESSION_SECRET/);
    });

    it("fails when CREDENTIAL_SIGNING_SECRET is missing", () => {
      const config = { ...baseConfig };
      delete (config as any).CREDENTIAL_SIGNING_SECRET;

      expect(() => validateEnv(config)).toThrow(/CREDENTIAL_SIGNING_SECRET/);
    });

    it("fails when CREDENTIAL_SIGNING_SECRET is too short (< 8 chars)", () => {
      const config = {
        ...baseConfig,
        CREDENTIAL_SIGNING_SECRET: "short",
      };

      expect(() => validateEnv(config)).toThrow(/CREDENTIAL_SIGNING_SECRET/);
    });

    it("fails when PAYMENT_ENCRYPTION_KEY is missing", () => {
      const config = { ...baseConfig };
      delete (config as any).PAYMENT_ENCRYPTION_KEY;

      expect(() => validateEnv(config)).toThrow(/PAYMENT_ENCRYPTION_KEY/);
    });

    it("never exposes actual secret values in error messages", () => {
      const secretValue = "this-is-a-real-secret-value-12345";
      const config = {
        ...baseConfig,
        SESSION_SECRET: "zq7x",
      };

      let errorMessage = "";
      try {
        validateEnv(config);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).not.toContain(config.SESSION_SECRET);
      expect(errorMessage).not.toContain(secretValue);
      expect(errorMessage).toContain("SESSION_SECRET");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // NUMERIC VARIABLES (Port, Retention, Rate Limits, Timeouts)
  // ──────────────────────────────────────────────────────────────────────

  describe("Numeric variables", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    describe("PORT", () => {
      it("accepts valid port numbers", () => {
        const config = { ...baseConfig, PORT: "3000" };
        expect(() => validateEnv(config)).not.toThrow();
      });

      it("fails on port 0 (must be positive)", () => {
        const config = { ...baseConfig, PORT: "0" };
        expect(() => validateEnv(config)).toThrow(/PORT.*positive/);
      });

      it("fails on negative port", () => {
        const config = { ...baseConfig, PORT: "-1" };
        expect(() => validateEnv(config)).toThrow(/PORT.*positive/);
      });

      it("fails on non-integer port", () => {
        const config = { ...baseConfig, PORT: "3000.5" };
        expect(() => validateEnv(config)).toThrow(/PORT.*integer/);
      });

      it("coerces string to number", () => {
        const config = { ...baseConfig, PORT: "4000" };
        const result = validateEnv(config);
        expect(typeof result.PORT).toBe("number");
        expect(result.PORT).toBe(4000);
      });
    });

    describe("RETENTION days (1–3650 range)", () => {
      it("accepts valid retention durations", () => {
        const config = {
          ...baseConfig,
          RETENTION_WALLET_CHALLENGE_DAYS: "7",
          RETENTION_AUTH_SESSION_DAYS: "30",
          RETENTION_WEBHOOK_DELIVERY_DAYS: "30",
          RETENTION_AUDIT_LOG_DAYS: "365",
          RETENTION_FAILED_ANCHORING_DAYS: "90",
        };
        expect(() => validateEnv(config)).not.toThrow();
      });

      it("fails when RETENTION_WALLET_CHALLENGE_DAYS is 0", () => {
        const config = { ...baseConfig, RETENTION_WALLET_CHALLENGE_DAYS: "0" };
        expect(() => validateEnv(config)).toThrow(
          /RETENTION_WALLET_CHALLENGE_DAYS.*at least 1/,
        );
      });

      it("fails when RETENTION_AUTH_SESSION_DAYS exceeds 3650", () => {
        const config = {
          ...baseConfig,
          RETENTION_AUTH_SESSION_DAYS: "3651",
        };
        expect(() => validateEnv(config)).toThrow(
          /RETENTION_AUTH_SESSION_DAYS.*at most 3650/,
        );
      });

      it("accepts boundary values (1 and 3650)", () => {
        const config = {
          ...baseConfig,
          RETENTION_WALLET_CHALLENGE_DAYS: "1",
          RETENTION_AUDIT_LOG_DAYS: "3650",
        };
        expect(() => validateEnv(config)).not.toThrow();
      });
    });

    describe("AUTH rate limit counters", () => {
      it("accepts valid rate limit counts", () => {
        const config = {
          ...baseConfig,
          AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS: "10",
          AUTH_RATE_LIMIT_MAX_VERIFICATIONS: "5",
        };
        expect(() => validateEnv(config)).not.toThrow();
      });

      it("fails when AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS is 0", () => {
        const config = {
          ...baseConfig,
          AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS: "0",
        };
        expect(() => validateEnv(config)).toThrow(
          /AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS.*positive/,
        );
      });

      it("fails when AUTH_RATE_LIMIT_MAX_VERIFICATIONS is negative", () => {
        const config = {
          ...baseConfig,
          AUTH_RATE_LIMIT_MAX_VERIFICATIONS: "-1",
        };
        expect(() => validateEnv(config)).toThrow(
          /AUTH_RATE_LIMIT_MAX_VERIFICATIONS.*positive/,
        );
      });
    });

    describe("Time windows (milliseconds)", () => {
      it("accepts valid time windows", () => {
        const config = {
          ...baseConfig,
          AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS: "900000",
          AUTH_RATE_LIMIT_VERIFICATION_WINDOW_MS: "600000",
        };
        expect(() => validateEnv(config)).not.toThrow();
      });

      it("fails when window exceeds 1 hour (3600000ms)", () => {
        const config = {
          ...baseConfig,
          AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS: "3600001",
        };
        expect(() => validateEnv(config)).toThrow(
          /AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS.*exceed 1 hour/,
        );
      });

      it("accepts exactly 1 hour (3600000ms)", () => {
        const config = {
          ...baseConfig,
          AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS: "3600000",
        };
        expect(() => validateEnv(config)).not.toThrow();
      });

      it("fails when window is 0", () => {
        const config = {
          ...baseConfig,
          AUTH_RATE_LIMIT_VERIFICATION_WINDOW_MS: "0",
        };
        expect(() => validateEnv(config)).toThrow(/must be positive/);
      });
    });

    describe("HEALTH_PROBE_TIMEOUT_MS", () => {
      it("accepts valid probe timeouts (< 30s)", () => {
        const config = { ...baseConfig, HEALTH_PROBE_TIMEOUT_MS: "5000" };
        expect(() => validateEnv(config)).not.toThrow();
      });

      it("fails when probe timeout exceeds 30 seconds", () => {
        const config = { ...baseConfig, HEALTH_PROBE_TIMEOUT_MS: "31000" };
        expect(() => validateEnv(config)).toThrow(
          /HEALTH_PROBE_TIMEOUT_MS.*exceed 30 seconds/,
        );
      });

      it("accepts exactly 25 seconds (invariant threshold)", () => {
        const config = { ...baseConfig, HEALTH_PROBE_TIMEOUT_MS: "25000" };
        expect(() => validateEnv(config)).not.toThrow();
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // URL VARIABLES
  // ──────────────────────────────────────────────────────────────────────

  describe("URL variables", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("fails when DATABASE_URL is not a valid URL", () => {
      const config = { ...baseConfig, DATABASE_URL: "not-a-url" };
      expect(() => validateEnv(config)).toThrow(/DATABASE_URL.*valid connection URL/);
    });

    it("fails when REDIS_URL is not a valid URL", () => {
      const config = { ...baseConfig, REDIS_URL: "invalid" };
      expect(() => validateEnv(config)).toThrow(/REDIS_URL.*valid connection URL/);
    });

    it("fails when APP_URL is not a valid URL", () => {
      const config = { ...baseConfig, APP_URL: "not a url" };
      expect(() => validateEnv(config)).toThrow(/APP_URL.*valid URL/);
    });

    it("fails when API_URL is not a valid URL", () => {
      const config = { ...baseConfig, API_URL: ":::invalid:::" };
      expect(() => validateEnv(config)).toThrow(/API_URL.*valid URL/);
    });

    it("fails when STELLAR_HORIZON_URL is not a valid URL", () => {
      const config = { ...baseConfig, STELLAR_HORIZON_URL: "not a url" };
      expect(() => validateEnv(config)).toThrow(/STELLAR_HORIZON_URL.*valid URL/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // STELLAR CONTRACT & PUBLIC KEY VARIABLES
  // ──────────────────────────────────────────────────────────────────────

  describe("Stellar contract and public key variables", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("fails when PROOF_REGISTRY_CONTRACT_ID has invalid format", () => {
      const config = {
        ...baseConfig,
        PROOF_REGISTRY_CONTRACT_ID: "INVALID_FORMAT",
      };
      expect(() => validateEnv(config)).toThrow(
        /PROOF_REGISTRY_CONTRACT_ID.*valid Stellar contract/,
      );
    });

    it("accepts valid PROOF_REGISTRY_CONTRACT_ID (C + 55 chars)", () => {
      const config = {
        ...baseConfig,
        PROOF_REGISTRY_CONTRACT_ID: "CBLTPEEUUC426PLBIFR76UVJKV3JJGVESMGALBWQXISKUOJE56XEXLAA",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("fails when EARNPROOF_ISSUER_ADDRESS has invalid format", () => {
      const config = {
        ...baseConfig,
        EARNPROOF_ISSUER_ADDRESS: "INVALID_KEY",
      };
      expect(() => validateEnv(config)).toThrow(
        /EARNPROOF_ISSUER_ADDRESS.*valid Stellar public key/,
      );
    });

    it("accepts valid EARNPROOF_ISSUER_ADDRESS (G + 55 chars)", () => {
      const config = {
        ...baseConfig,
        EARNPROOF_ISSUER_ADDRESS: "GBUZXASG7ZSDA6K6VY4XH7GAKU3URVEDX5DSCCRMV3XH3XUACF5UCLDA",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("accepts empty/missing contract IDs in development", () => {
      const config = {
        ...baseConfig,
        PROOF_REGISTRY_CONTRACT_ID: "",
        ISSUER_REGISTRY_CONTRACT_ID: "",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // CRON EXPRESSIONS
  // ──────────────────────────────────────────────────────────────────────

  describe("Cron expressions", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("accepts valid 5-field cron expressions", () => {
      const config = {
        ...baseConfig,
        AUTH_SESSION_CLEANUP_CRON: "0 0 * * *",
        AUTH_CHALLENGE_CLEANUP_CRON: "0 2 * * *",
        RETENTION_CLEANUP_CRON: "0 3 * * *",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("accepts cron expressions with ranges and lists", () => {
      const config = {
        ...baseConfig,
        AUTH_SESSION_CLEANUP_CRON: "0,30 * * * *",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("fails on invalid cron expression (missing fields)", () => {
      const config = { ...baseConfig, AUTH_SESSION_CLEANUP_CRON: "0 0 *" };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_SESSION_CLEANUP_CRON.*valid cron/,
      );
    });

    it("fails on invalid cron expression (garbage)", () => {
      const config = {
        ...baseConfig,
        AUTH_CHALLENGE_CLEANUP_CRON: "not a cron",
      };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_CHALLENGE_CLEANUP_CRON.*valid cron/,
      );
    });

    it("fails on cron with invalid hour (>23)", () => {
      const config = { ...baseConfig, AUTH_SESSION_CLEANUP_CRON: "0 25 * * *" };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_SESSION_CLEANUP_CRON.*valid cron/,
      );
    });

    it("fails on cron with invalid minute (>59)", () => {
      const config = { ...baseConfig, AUTH_SESSION_CLEANUP_CRON: "75 * * * *" };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_SESSION_CLEANUP_CRON.*valid cron/,
      );
    });

    it("fails on cron with invalid step (*/0)", () => {
      const config = { ...baseConfig, AUTH_SESSION_CLEANUP_CRON: "*/0 * * * *" };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_SESSION_CLEANUP_CRON.*valid cron/,
      );
    });

    it("fails on cron with both day-of-month and day-of-week restricted", () => {
      const config = { ...baseConfig, AUTH_SESSION_CLEANUP_CRON: "0 0 15 * 1" };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_SESSION_CLEANUP_CRON.*valid cron/,
      );
    });

    it("accepts cron with 6 fields (with seconds)", () => {
      const config = {
        ...baseConfig,
        AUTH_SESSION_CLEANUP_CRON: "30 0 0 * * *",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("fails on cron with 7 fields (too many)", () => {
      const config = { ...baseConfig, AUTH_SESSION_CLEANUP_CRON: "0 0 0 * * * *" };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_SESSION_CLEANUP_CRON.*valid cron/,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // ENCRYPTION KEY
  // ──────────────────────────────────────────────────────────────────────

  describe("PAYMENT_ENCRYPTION_KEY", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
    };

    it("accepts valid base64-encoded 32-byte key", () => {
      const config = {
        ...baseConfig,
        PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("accepts valid hex-encoded 32-byte key (64 chars)", () => {
      const config = {
        ...baseConfig,
        PAYMENT_ENCRYPTION_KEY:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("fails when key is not 32 bytes (too short in base64)", () => {
      const config = {
        ...baseConfig,
        PAYMENT_ENCRYPTION_KEY: "dGVzdA==", // "test" = 4 bytes
      };
      expect(() => validateEnv(config)).toThrow(
        /PAYMENT_ENCRYPTION_KEY.*32 bytes/,
      );
    });

    it("fails when key is invalid base64", () => {
      const config = {
        ...baseConfig,
        PAYMENT_ENCRYPTION_KEY: "!!!invalid!!!base64!!!",
      };
      expect(() => validateEnv(config)).toThrow(
        /PAYMENT_ENCRYPTION_KEY.*32 bytes/,
      );
    });

    it("fails when hex key is wrong length (not 64 chars)", () => {
      const config = {
        ...baseConfig,
        PAYMENT_ENCRYPTION_KEY: "0123456789abcdef", // 16 chars = 8 bytes
      };
      expect(() => validateEnv(config)).toThrow(
        /PAYMENT_ENCRYPTION_KEY.*32 bytes/,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // CROSS-VARIABLE INVARIANTS: PRODUCTION PROFILE
  // ──────────────────────────────────────────────────────────────────────

  describe("Cross-variable invariants: production profile", () => {
    const baseConfig = {
      NODE_ENV: "production",
      PORT: "4000",
      DATABASE_URL: "postgresql://user:pass@db.example.com:5432/prod_db",
      REDIS_URL: "redis://redis.example.com:6379",
      APP_URL: "https://app.example.com",
      API_URL: "https://api.example.com",
      STELLAR_NETWORK: "testnet",
      STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
      STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      SESSION_SECRET: "prod-session-secret-very-long-secure-value",
      CREDENTIAL_SIGNING_SECRET: "prod-cred-secret-very-long-secure-value",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("fails when APP_URL is HTTP (not HTTPS) in production", () => {
      const config = { ...baseConfig, APP_URL: "http://app.example.com" };
      expect(() => validateEnv(config)).toThrow(
        /APP_URL.*must use https.*production/,
      );
    });

    it("fails when API_URL is HTTP (not HTTPS) in production", () => {
      const config = { ...baseConfig, API_URL: "http://api.example.com" };
      expect(() => validateEnv(config)).toThrow(
        /API_URL.*must use https.*production/,
      );
    });

    it("fails when DATABASE_URL points to localhost in production", () => {
      const config = {
        ...baseConfig,
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      };
      expect(() => validateEnv(config)).toThrow(
        /DATABASE_URL.*localhost.*production/,
      );
    });

    it("fails when DATABASE_URL points to 127.0.0.1 in production", () => {
      const config = {
        ...baseConfig,
        DATABASE_URL: "postgresql://user:pass@127.0.0.1:5432/db",
      };
      expect(() => validateEnv(config)).toThrow(
        /DATABASE_URL.*localhost.*production/,
      );
    });

    it("fails when REDIS_URL points to localhost in production", () => {
      const config = {
        ...baseConfig,
        REDIS_URL: "redis://localhost:6379",
      };
      expect(() => validateEnv(config)).toThrow(
        /REDIS_URL.*localhost.*production/,
      );
    });

    it("fails when CONTRACT_ANCHORING_REQUIRED=true but PROOF_REGISTRY_CONTRACT_ID is missing", () => {
      const config = {
        ...baseConfig,
        CONTRACT_ANCHORING_REQUIRED: "true",
        PROOF_REGISTRY_CONTRACT_ID: "",
      };
      expect(() => validateEnv(config)).toThrow(
        /CONTRACT_ANCHORING_REQUIRED=true.*PROOF_REGISTRY_CONTRACT_ID/,
      );
    });

    it("fails when CONTRACT_ANCHORING_REQUIRED=true but EARNPROOF_ISSUER_ADDRESS is missing", () => {
      const config = {
        ...baseConfig,
        CONTRACT_ANCHORING_REQUIRED: "true",
        PROOF_REGISTRY_CONTRACT_ID:
          "CBLTPEEUUC426PLBIFR76UVJKV3JJGVESMGALBWQXISKUOJE56XEXLAA",
        EARNPROOF_ISSUER_ADDRESS: "",
      };
      expect(() => validateEnv(config)).toThrow(
        /CONTRACT_ANCHORING_REQUIRED=true.*EARNPROOF_ISSUER_ADDRESS/,
      );
    });

    it("fails when ISSUER_REGISTRY_ENABLED=true but ISSUER_REGISTRY_CONTRACT_ID is missing", () => {
      const config = {
        ...baseConfig,
        ISSUER_REGISTRY_ENABLED: "true",
        ISSUER_REGISTRY_CONTRACT_ID: "",
      };
      expect(() => validateEnv(config)).toThrow(
        /ISSUER_REGISTRY_ENABLED=true.*ISSUER_REGISTRY_CONTRACT_ID/,
      );
    });

    it("fails when rate limit window is too long (> 1 hour) in production", () => {
      const config = {
        ...baseConfig,
        AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS: "7200000", // 2 hours
      };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS.*exceed 1 hour/,
      );
    });

    it("fails when challenge rate limit is unreasonably high (> 100) in production", () => {
      const config = {
        ...baseConfig,
        AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS: "101",
      };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS.*unreasonably high/,
      );
    });

    it("fails when verification rate limit is unreasonably high (> 50) in production", () => {
      const config = {
        ...baseConfig,
        AUTH_RATE_LIMIT_MAX_VERIFICATIONS: "51",
      };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_RATE_LIMIT_MAX_VERIFICATIONS.*unreasonably high/,
      );
    });

    it("fails when HEALTH_PROBE_TIMEOUT_MS is too long (> 25s)", () => {
      const config = {
        ...baseConfig,
        HEALTH_PROBE_TIMEOUT_MS: "26000",
      };
      expect(() => validateEnv(config)).toThrow(
        /HEALTH_PROBE_TIMEOUT_MS.*should not exceed 25 seconds/,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // CROSS-VARIABLE INVARIANTS: TEST PROFILE
  // ──────────────────────────────────────────────────────────────────────

  describe("Cross-variable invariants: test profile", () => {
    const baseConfig = {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/test_db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "test-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "test-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("fails when TEST_DATABASE_URL does not contain 'test'", () => {
      const config = {
        ...baseConfig,
        TEST_DATABASE_URL: "postgresql://user:pass@localhost:5432/prod_db",
      };
      expect(() => validateEnv(config)).toThrow(
        /TEST_DATABASE_URL.*must contain 'test'/,
      );
    });

    it("accepts TEST_DATABASE_URL when it contains 'test'", () => {
      const config = {
        ...baseConfig,
        TEST_DATABASE_URL:
          "postgresql://user:pass@localhost:5432/earnproof_test",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("accepts TEST_DATABASE_URL with 'test' anywhere in the path", () => {
      const config = {
        ...baseConfig,
        TEST_DATABASE_URL:
          "postgresql://user:pass@localhost:5432/test_db_worker_1",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // ENUM VARIABLES
  // ──────────────────────────────────────────────────────────────────────

  describe("Enum variables", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    describe("NODE_ENV", () => {
      it("accepts development, test, staging, and production", () => {
        ["development", "test", "staging", "production"].forEach((env) => {
          const config = {
            ...baseConfig,
            NODE_ENV: env,
            APP_URL: "https://app.example.com",
            API_URL: "https://api.example.com",
            DATABASE_URL: "postgresql://user:pass@db.example.com:5432/db",
            REDIS_URL: "redis://redis.example.com:6379",
          };
          expect(() => validateEnv(config)).not.toThrow();
        });
      });

      it("fails on invalid NODE_ENV", () => {
        const config = { ...baseConfig, NODE_ENV: "preview" };
        expect(() => validateEnv(config)).toThrow(/NODE_ENV/);
      });
    });

    describe("STELLAR_NETWORK", () => {
      it("accepts testnet", () => {
        const config = { ...baseConfig, STELLAR_NETWORK: "testnet" };
        expect(() => validateEnv(config)).not.toThrow();
      });

      it("fails on invalid network", () => {
        const config = { ...baseConfig, STELLAR_NETWORK: "mainnet" };
        expect(() => validateEnv(config)).toThrow(/STELLAR_NETWORK/);
      });
    });

    describe("Boolean-like enums (true | false strings)", () => {
      it("accepts 'true' and 'false' strings for CONTRACT_ANCHORING_ENABLED", () => {
        const config = {
          ...baseConfig,
          CONTRACT_ANCHORING_ENABLED: "true",
        };
        expect(() => validateEnv(config)).not.toThrow();

        const config2 = {
          ...baseConfig,
          CONTRACT_ANCHORING_ENABLED: "false",
        };
        expect(() => validateEnv(config2)).not.toThrow();
      });

      it("fails on other values for CONTRACT_ANCHORING_ENABLED", () => {
        const config = {
          ...baseConfig,
          CONTRACT_ANCHORING_ENABLED: "yes",
        };
        expect(() => validateEnv(config)).toThrow(
          /CONTRACT_ANCHORING_ENABLED/,
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // OPTIONAL VARIABLES (Empty strings and missing)
  // ──────────────────────────────────────────────────────────────────────

  describe("Optional variables", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("treats empty strings as undefined for optional string fields", () => {
      const config = {
        ...baseConfig,
        STELLAR_CLI_SOURCE: "",
        PROOF_REGISTRY_CONTRACT_ID: "",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("accepts missing optional fields", () => {
      const config = { ...baseConfig };
      // Don't provide optional fields
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("uses defaults for optional fields when missing", () => {
      const config = { ...baseConfig };
      const result = validateEnv(config);
      expect(result.CONTRACT_ANCHORING_ENABLED).toBe("false");
      expect(result.CONTRACT_ANCHORING_REQUIRED).toBe("false");
      expect(result.ISSUER_REGISTRY_ENABLED).toBe("false");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // VERSIONED PAYMENT ENCRYPTION KEYS (PAYMENT_ENCRYPTION_KEY_V*)
  // ──────────────────────────────────────────────────────────────────────

  describe("PAYMENT_ENCRYPTION_KEY_V* (dynamically numbered)", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("accepts valid versioned payment encryption keys", () => {
      const config = {
        ...baseConfig,
        PAYMENT_ENCRYPTION_KEY_VERSION: "1",
        PAYMENT_ENCRYPTION_KEY_V0: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        PAYMENT_ENCRYPTION_KEY_V1: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWE=",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("rejects a payment key that is not 32 bytes", () => {
      const config = {
        ...baseConfig,
        PAYMENT_ENCRYPTION_KEY_V0: "dGVzdA==", // "test" = 4 bytes
      };
      expect(() => validateEnv(config)).toThrow(/PAYMENT_ENCRYPTION_KEY_V0/);
    });

    it("ignores empty-string versioned payment keys (treated as absent)", () => {
      const config = {
        ...baseConfig,
        PAYMENT_ENCRYPTION_KEY_V0: "",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("accepts hex-encoded versioned payment keys", () => {
      const config = {
        ...baseConfig,
        PAYMENT_ENCRYPTION_KEY_V0:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // PRESERVED RETENTION VARIABLES (RETENTION_PROOF_DAYS, etc.)
  // ──────────────────────────────────────────────────────────────────────

  describe("Preserved retention variables (never auto-swept)", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("accepts valid preserved retention durations", () => {
      const config = {
        ...baseConfig,
        RETENTION_PROOF_DAYS: "3650",
        RETENTION_REVOCATION_DAYS: "3650",
        RETENTION_ANCHORING_STATE_DAYS: "3650",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("fails when RETENTION_PROOF_DAYS is out of range", () => {
      const config = {
        ...baseConfig,
        RETENTION_PROOF_DAYS: "3651",
      };
      expect(() => validateEnv(config)).toThrow(
        /RETENTION_PROOF_DAYS.*at most 3650/,
      );
    });

    it("fails when RETENTION_PROOF_DAYS is zero", () => {
      const config = {
        ...baseConfig,
        RETENTION_PROOF_DAYS: "0",
      };
      expect(() => validateEnv(config)).toThrow(
        /RETENTION_PROOF_DAYS.*at least 1/,
      );
    });

    it("accepts boundary values for preserved retention", () => {
      const config = {
        ...baseConfig,
        RETENTION_PROOF_DAYS: "1",
        RETENTION_REVOCATION_DAYS: "3650",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("treats empty/missing preserved retention as absent (no error)", () => {
      const config = { ...baseConfig };
      expect(() => validateEnv(config)).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // RATE LIMIT BOUNDS (Stricter validation)
  // ──────────────────────────────────────────────────────────────────────

  describe("Rate limit stricter bounds", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("fails when rate limit counter exceeds 1000", () => {
      const config = {
        ...baseConfig,
        AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS: "1001",
      };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS.*exceed 1000/,
      );
    });

    it("accepts rate limit counter at exactly 1000", () => {
      const config = {
        ...baseConfig,
        AUTH_RATE_LIMIT_MAX_CHALLENGE_CREATIONS: "1000",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("fails when global rate limit counters exceed 1000", () => {
      const config = {
        ...baseConfig,
        RATE_LIMIT_DEFAULT_LIMIT: "1001",
      };
      expect(() => validateEnv(config)).toThrow(/RATE_LIMIT_DEFAULT_LIMIT/);
    });

    it("fails when time window exceeds 1 hour (3600000ms)", () => {
      const config = {
        ...baseConfig,
        AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS: "3600001",
      };
      expect(() => validateEnv(config)).toThrow(
        /AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS.*exceed 1 hour/,
      );
    });

    it("accepts time window at exactly 1 hour (3600000ms)", () => {
      const config = {
        ...baseConfig,
        AUTH_RATE_LIMIT_CHALLENGE_CREATION_WINDOW_MS: "3600000",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("fails when global rate limit window exceeds 1 hour", () => {
      const config = {
        ...baseConfig,
        RATE_LIMIT_DEFAULT_TTL_MS: "3600001",
      };
      expect(() => validateEnv(config)).toThrow(/RATE_LIMIT_DEFAULT_TTL_MS/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // VERSIONED VERIFICATION HASH SALTS (VERIFICATION_HASH_SALT_V*)
  // ──────────────────────────────────────────────────────────────────────

  describe("VERIFICATION_HASH_SALT_V* (dynamically numbered)", () => {
    const baseConfig = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      SESSION_SECRET: "dev-session-secret-8-chars",
      CREDENTIAL_SIGNING_SECRET: "dev-cred-secret-8-chars",
      PAYMENT_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    it("accepts valid versioned salts", () => {
      const config = {
        ...baseConfig,
        VERIFICATION_HASH_SALT_VERSION: "1",
        VERIFICATION_HASH_SALT_V0: "a-sufficiently-long-salt-value-0",
        VERIFICATION_HASH_SALT_V1: "a-sufficiently-long-salt-value-1",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });

    it("rejects a salt shorter than the minimum length", () => {
      const config = {
        ...baseConfig,
        VERIFICATION_HASH_SALT_V0: "short",
      };
      expect(() => validateEnv(config)).toThrow(/VERIFICATION_HASH_SALT_V0/);
    });

    it("ignores empty-string salt values (treated as absent)", () => {
      const config = {
        ...baseConfig,
        VERIFICATION_HASH_SALT_V0: "",
      };
      expect(() => validateEnv(config)).not.toThrow();
    });
  });
});
