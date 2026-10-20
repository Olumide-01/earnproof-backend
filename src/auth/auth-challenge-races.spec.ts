import { Keypair } from "@stellar/stellar-base";
import { createHash } from "crypto";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";

/**
 * Builds the service with inert collaborators.
 *
 * This suite is about one thing: which request wins the race to consume a
 * challenge. Sessions, audit writes and rate limits must not be able to change
 * that answer, so they are doubles that always succeed.
 */
function buildAuthService(prisma: any, config: any): AuthService {
  // After a failed consume the service asks whether the challenge was already
  // used, to audit a replay separately from an expiry. That lookup is not what
  // these tests are about, so it defaults to "no such row" unless the test
  // supplies its own — which keeps each case's mock to the calls it cares about.
  const withReplayLookup = {
    ...prisma,
    walletChallenge: {
      findFirst: jest.fn().mockResolvedValue(null),
      ...(prisma?.walletChallenge ?? {}),
    },
  };

  return new AuthService(
    withReplayLookup,
    {
      create: jest.fn().mockResolvedValue({
        token: "session-token",
        sessionId: "session_1",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    } as never,
    { recordEvent: jest.fn().mockResolvedValue(undefined) } as never,
    {
      checkChallengeCreationLimit: jest.fn().mockResolvedValue(undefined),
      checkVerificationLimit: jest.fn().mockResolvedValue(undefined),
    } as never,
    config,
  );
}

describe("Auth challenge replay and race-condition tests", () => {
  let mockConfig: any;
  let keypairA: Keypair;
  let keypairB: Keypair;
  let walletAddressA: string;
  let walletAddressB: string;

  beforeEach(() => {
    keypairA = Keypair.random();
    keypairB = Keypair.random();
    walletAddressA = keypairA.publicKey();
    walletAddressB = keypairB.publicKey();

    mockConfig = {
      getOrThrow: (key: string) => {
        const values: Record<string, string> = {
          appUrl: "http://localhost:3000",
          "stellar.networkPassphrase": "Test SDF Network ; September 2015",
          sessionSecret: "test_secret_123",
        };
        return values[key];
      },
    } as any;

    // The collaborators are inert doubles: this suite is about the challenge
    // consume race, and a session or an audit write must not decide its result.
    authService = buildAuthService(mockPrisma, mockConfig);
  });

  // Helper function to generate SEP-53 message hash
  function sep53MessageHash(message: string) {
    return createHash("sha256")
      .update("Stellar Signed Message:\n", "utf8")
      .update(message, "utf8")
      .digest();
  }

  // Helper function to sign a challenge message
  function signChallenge(message: string, keypair: Keypair): string {
    return keypair
      .sign(sep53MessageHash(message))
      .toString("base64");
  }

  // Helper function to generate a challenge message
  function generateChallengeMessage(
    walletAddress: string,
    nonce: string,
    expiresAt: Date,
  ): string {
    return [
      "EarnProof wallet authentication",
      `Domain: http://localhost:3000`,
      `Network: Test SDF Network ; September 2015`,
      `Wallet: ${walletAddress}`,
      `Nonce: ${nonce}`,
      `Expires At: ${expiresAt.toISOString()}`,
    ].join("\n");
  }

  /**
   * Builds a real AuthService wired to a fake PrismaService plus no-op
   * audit/rate-limiter dependencies, so these tests exercise the actual
   * atomic-consumption logic in AuthService.verifyChallenge without
   * depending on a real database.
   */
  function buildAuthService(mockPrisma: any): AuthService {
    const sessionSvc = new SessionService(mockPrisma, mockConfig);
    const auditSvc = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    const rateLimiter = {
      checkChallengeCreationLimit: jest.fn().mockResolvedValue(undefined),
      checkVerificationLimit: jest.fn().mockResolvedValue(undefined),
    };
    return new AuthService(
      mockPrisma,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      mockConfig,
    );
  }

  describe("Single-use guarantee", () => {
    it("challenge_can_be_consumed_at_most_once", async () => {
      const challengeId = "challenge_1";
      const nonce = "test_nonce_12345678901234567890";
      const expiresAt = new Date(Date.now() + 60_000);
      const message = generateChallengeMessage(walletAddressA, nonce, expiresAt);
      const validSig = signChallenge(message, keypairA);

      // Setup mock for successful first verification
      const mockPrisma = {
        walletChallenge: {
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 }) // First call succeeds (atomic update)
            .mockResolvedValueOnce({ count: 0 }), // Second call fails (already used)
          findFirst: jest
            .fn()
            .mockResolvedValue({ message, walletAddress: walletAddressA, usedAt: new Date() }),
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({ message, walletAddress: walletAddressA, networkPassphrase: "Test SDF Network ; September 2015", origin: "http://localhost:3000" })
            .mockResolvedValueOnce({ message, walletAddress: walletAddressA, networkPassphrase: "Test SDF Network ; September 2015", origin: "http://localhost:3000" }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({
            id: "user_1",
            walletAddress: walletAddressA,
            walletHash: "sha256:hash",
            role: "WORKER",
          }),
        },
        authSession: {
          create: jest.fn().mockResolvedValue({}),
        },
      };

      const authService = buildAuthService(mockPrisma, mockConfig);

      // First verification succeeds
      const result1 = await authService.verifyChallenge({
        challengeId,
        walletAddress: walletAddressA,
        signature: validSig,
      });

      expect(result1).toBeDefined();
      expect(result1.user).toBeDefined();
      expect(result1.session).toBeDefined();
      expect(result1.session.token).toBeDefined();

      // Second verification with same challenge fails
      await expect(
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: validSig,
        }),
      ).rejects.toThrow("Challenge is expired or unavailable");
    });
  });

  describe("Parallel race conditions", () => {
    it("parallel_verification_has_exactly_one_winner", async () => {
      const challengeId = "challenge_parallel";
      const nonce = "nonce_parallel_test_abc123def456";
      const expiresAt = new Date(Date.now() + 60_000);
      const message = generateChallengeMessage(walletAddressA, nonce, expiresAt);
      const validSig = signChallenge(message, keypairA);

      // Setup mock: first 5 updateMany calls — only first succeeds, rest fail
      const mockPrisma = {
        walletChallenge: {
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 }) // 1st wins
            .mockResolvedValueOnce({ count: 0 }) // 2nd loses
            .mockResolvedValueOnce({ count: 0 }) // 3rd loses
            .mockResolvedValueOnce({ count: 0 }) // 4th loses
            .mockResolvedValueOnce({ count: 0 }), // 5th loses
          findFirst: jest
            .fn()
            .mockResolvedValue({ message, walletAddress: walletAddressA, usedAt: new Date() }),
          findUnique: jest
            .fn()
            .mockResolvedValue({ message, walletAddress: walletAddressA, networkPassphrase: "Test SDF Network ; September 2015", origin: "http://localhost:3000" }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({
            id: "user_1",
            walletAddress: walletAddressA,
            walletHash: "sha256:hash",
            role: "WORKER",
          }),
        },
        authSession: {
          create: jest.fn().mockResolvedValue({}),
        },
      };

      const authService = buildAuthService(mockPrisma);
      authService = buildAuthService(mockPrisma, mockConfig);

      // Fire 5 concurrent verification requests for the same challenge
      const results = await Promise.allSettled([
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: validSig,
        }),
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: validSig,
        }),
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: validSig,
        }),
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: validSig,
        }),
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: validSig,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly one succeeds
      expect(fulfilled).toHaveLength(1);
      // All others fail
      expect(rejected).toHaveLength(4);

      // Verify all results are stable (no crypto material leaked)
      for (const r of rejected) {
        if (r.status === "rejected") {
          const errorMessage = r.reason?.message || "";
          // Error must not expose challenge secret or nonce
          expect(errorMessage).not.toContain(nonce);
          expect(errorMessage).not.toMatch(/secret|nonce|signature/i);
        }
      }
    });

    it("parallel_losers_receive_stable_error_response", async () => {
      const challengeId = "challenge_stable_error";
      const nonce = "nonce_stable_xyz789";
      const expiresAt = new Date(Date.now() + 60_000);
      const message = generateChallengeMessage(walletAddressA, nonce, expiresAt);
      const validSig = signChallenge(message, keypairA);

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 }) // First wins
            .mockResolvedValueOnce({ count: 0 }), // Second loses
          findFirst: jest
            .fn()
            .mockResolvedValue({ message, walletAddress: walletAddressA, usedAt: new Date() }),
          findUnique: jest
            .fn()
            .mockResolvedValue({ message, walletAddress: walletAddressA, networkPassphrase: "Test SDF Network ; September 2015", origin: "http://localhost:3000" }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({
            id: "user_1",
            walletAddress: walletAddressA,
            walletHash: "sha256:hash",
            role: "WORKER",
          }),
        },
        authSession: {
          create: jest.fn().mockResolvedValue({}),
        },
      };

      authService = buildAuthService(mockPrisma, mockConfig);

      const results = await Promise.allSettled([
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: validSig,
        }),
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: validSig,
        }),
      ]);

      const loser = results.find((r) => r.status === "rejected");

      if (loser?.status === "rejected") {
        // Stable error — not an internal server error
        expect(loser.reason?.message).toBe("Challenge is expired or unavailable");
        // Error should be UnauthorizedException, not generic Error
        expect(loser.reason?.name).toBe("UnauthorizedException");
      }
    });
  });

  describe("Expiry boundary races", () => {
    it("expired_challenge_is_rejected", async () => {
      const challengeId = "challenge_expired";
      const nonce = "nonce_expired_test";
      const expiresAt = new Date(Date.now() - 1000); // Already expired
      const message = generateChallengeMessage(walletAddressA, nonce, expiresAt);
      const validSig = signChallenge(message, keypairA);

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }), // No challenge found (expired)
          findFirst: jest.fn().mockResolvedValue(null),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn(),
        },
      };

      authService = buildAuthService(mockPrisma, mockConfig);

      await expect(
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: validSig,
        }),
      ).rejects.toThrow("Challenge is expired or unavailable");
    });

    it("challenge_just_before_expiry_succeeds", async () => {
      const challengeId = "challenge_valid_expiry";
      const nonce = "nonce_valid_boundary";
      const expiresAt = new Date(Date.now() + 1000); // Expires in 1 second
      const message = generateChallengeMessage(walletAddressA, nonce, expiresAt);
      const validSig = signChallenge(message, keypairA);

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            message,
            walletAddress: walletAddressA,
            networkPassphrase: "Test SDF Network ; September 2015",
            origin: "http://localhost:3000",
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({
            id: "user_1",
            walletAddress: walletAddressA,
            walletHash: "sha256:hash",
            role: "WORKER",
          }),
        },
        authSession: {
          create: jest.fn().mockResolvedValue({}),
        },
      };

      authService = buildAuthService(mockPrisma, mockConfig);

      const result = await authService.verifyChallenge({
        challengeId,
        walletAddress: walletAddressA,
        signature: validSig,
      });

      expect(result).toBeDefined();
      expect(result.user).toBeDefined();
    });
  });

  describe("Wallet mismatch and account switching", () => {
    it("mismatched_wallet_address_fails_closed", async () => {
      const challengeId = "challenge_wallet_mismatch";
      const nonce = "nonce_wallet_mismatch";
      const expiresAt = new Date(Date.now() + 60_000);
      // Challenge created for wallet A
      const messageA = generateChallengeMessage(walletAddressA, nonce, expiresAt);

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }), // No match because wallet mismatch
          findFirst: jest.fn().mockResolvedValue(null),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn(),
        },
      };

      authService = buildAuthService(mockPrisma, mockConfig);

      // Attempt to verify with wallet B's signature
      const wrongSig = signChallenge(messageA, keypairB); // Different wallet

      await expect(
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressB, // Wallet mismatch
          signature: wrongSig,
        }),
      ).rejects.toThrow("Challenge is expired or unavailable");
    });

    it("account_switched_mid_challenge_fails", async () => {
      const challengeId = "challenge_account_switch";
      const nonce = "nonce_account_switch";
      const expiresAt = new Date(Date.now() + 60_000);
      // Challenge created for wallet A
      const messageA = generateChallengeMessage(walletAddressA, nonce, expiresAt);
      const sigB = signChallenge(messageA, keypairB);

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }), // No match (wallet mismatch)
          findFirst: jest.fn().mockResolvedValue(null),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn(),
        },
      };

      authService = buildAuthService(mockPrisma, mockConfig);

      // Attempt to verify challenge for A with wallet B
      await expect(
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressB,
          signature: sigB,
        }),
      ).rejects.toThrow("Challenge is expired or unavailable");
    });
  });

  describe("Malformed signature and empty input", () => {
    it("malformed_signature_fails_closed_without_leaking_nonce", async () => {
      const challengeId = "challenge_malformed_sig";
      const nonce = "nonce_malformed_signature_test";
      const expiresAt = new Date(Date.now() + 60_000);
      const message = generateChallengeMessage(walletAddressA, nonce, expiresAt);

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            message,
            walletAddress: walletAddressA,
            networkPassphrase: "Test SDF Network ; September 2015",
            origin: "http://localhost:3000",
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn(),
        },
      };

      authService = buildAuthService(mockPrisma, mockConfig);

      try {
        await authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: "not-a-valid-signature",
        });
        fail("Should have thrown");
      } catch (error: any) {
        // Verify error message doesn't leak nonce
        expect(error.message).not.toContain(nonce);
        expect(error.message).toBe("Invalid wallet signature");
      }
    });

    it("empty_signature_fails_closed", async () => {
      const challengeId = "challenge_empty_sig";
      const nonce = "nonce_empty_signature";
      const expiresAt = new Date(Date.now() + 60_000);
      const message = generateChallengeMessage(walletAddressA, nonce, expiresAt);

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            message,
            walletAddress: walletAddressA,
            networkPassphrase: "Test SDF Network ; September 2015",
            origin: "http://localhost:3000",
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn(),
        },
      };

      authService = buildAuthService(mockPrisma, mockConfig);

      await expect(
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: "",
        }),
      ).rejects.toThrow("Invalid wallet signature");
    });
  });

  describe("Cross-challenge nonce replay", () => {
    it("replay_of_different_challenge_nonce_fails", async () => {
      const challengeIdB = "challenge_b";
      const nonceA = "nonce_a_distinct_123456789012345";
      const nonceB = "nonce_b_distinct_987654321098765";
      const expiresAt = new Date(Date.now() + 60_000);

      const messageA = generateChallengeMessage(walletAddressA, nonceA, expiresAt);
      const messageB = generateChallengeMessage(walletAddressA, nonceB, expiresAt);
      const sigA = signChallenge(messageA, keypairA);

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            message: messageB, // Challenge B has a different message
            walletAddress: walletAddressA,
            networkPassphrase: "Test SDF Network ; September 2015",
            origin: "http://localhost:3000",
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn(),
        },
      };

      authService = buildAuthService(mockPrisma, mockConfig);

      // Sign nonce A but submit against challenge B
      await expect(
        authService.verifyChallenge({
          challengeId: challengeIdB,
          walletAddress: walletAddressA,
          signature: sigA,
        }),
      ).rejects.toThrow("Invalid wallet signature");
    });
  });

  describe("Error response message validation (no secret leakage)", () => {
    it("error_responses_do_not_expose_challenge_secret_or_signature", async () => {
      const challengeId = "challenge_secret_leak_test";
      const nonce = "secret_nonce_should_not_leak_12345";
      const expiresAt = new Date(Date.now() + 60_000);
      const message = generateChallengeMessage(walletAddressA, nonce, expiresAt);

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            message,
            walletAddress: walletAddressA,
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn(),
        },
      };

      const authService = buildAuthService(mockPrisma);
      authService = buildAuthService(mockPrisma, mockConfig);

      try {
        await authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: "bad-signature",
        });
        fail("Should have thrown");
      } catch (error: any) {
        const errorStr = JSON.stringify(error);
        expect(errorStr).not.toContain(nonce);
        expect(errorStr).not.toMatch(/secret|private.*key|signing.*material/i);
      }
    });

    it("expired_challenge_error_is_same_as_invalid_challenge", async () => {
      const expiredChallengeId = "challenge_expired_error";
      const invalidChallengeId = "challenge_nonexistent_error";

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 0 }) // expired
            .mockResolvedValueOnce({ count: 0 }), // nonexistent
          findFirst: jest.fn().mockResolvedValue(null),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn(),
        },
      };

      const authService = buildAuthService(mockPrisma);
      authService = buildAuthService(mockPrisma, mockConfig);

      let expiredError: any;
      let invalidError: any;

      try {
        await authService.verifyChallenge({
          challengeId: expiredChallengeId,
          walletAddress: walletAddressA,
          signature: "any-sig",
        });
      } catch (error) {
        expiredError = error;
      }

      try {
        await authService.verifyChallenge({
          challengeId: invalidChallengeId,
          walletAddress: walletAddressA,
          signature: "any-sig",
        });
      } catch (error) {
        invalidError = error;
      }

      // Both produce the same error message (fail closed)
      expect(expiredError?.message).toBe(invalidError?.message);
      expect(expiredError?.message).toBe("Challenge is expired or unavailable");
    });
  });

  describe("Challenge not found after atomic consumption", () => {
    it("finds_challenge_after_successful_updateMany", async () => {
      const challengeId = "challenge_find_after_update";
      const nonce = "nonce_find_after_update_test";
      const expiresAt = new Date(Date.now() + 60_000);
      const message = generateChallengeMessage(walletAddressA, nonce, expiresAt);
      const validSig = signChallenge(message, keypairA);

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            message,
            walletAddress: walletAddressA,
            networkPassphrase: "Test SDF Network ; September 2015",
            origin: "http://localhost:3000",
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({
            id: "user_1",
            walletAddress: walletAddressA,
            walletHash: "sha256:hash",
            role: "WORKER",
          }),
        },
        authSession: {
          create: jest.fn().mockResolvedValue({}),
        },
      };

      const authService = buildAuthService(mockPrisma);
      authService = buildAuthService(mockPrisma, mockConfig);

      const result = await authService.verifyChallenge({
        challengeId,
        walletAddress: walletAddressA,
        signature: validSig,
      });

      expect(result).toBeDefined();
      // Verify that updateMany was called (marks challenge as consumed first)
      expect(mockPrisma.walletChallenge.updateMany).toHaveBeenCalled();
      expect(mockPrisma.walletChallenge.findUnique).toHaveBeenCalled();
    });
  });

  describe("Atomic consumption prevents signature oracle attacks", () => {
    it("failed_signature_verification_still_consumes_challenge", async () => {
      const challengeId = "challenge_bad_sig_consumed";
      const nonce = "nonce_bad_sig_should_consume";
      const expiresAt = new Date(Date.now() + 60_000);
      const message = generateChallengeMessage(walletAddressA, nonce, expiresAt);

      let updateCalled = false;

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest.fn().mockImplementation(async () => {
            updateCalled = true;
            return { count: 1 };
          }),
          findUnique: jest.fn().mockResolvedValue({
            message,
            walletAddress: walletAddressA,
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn(),
        },
      };

      const authService = buildAuthService(mockPrisma);
      authService = buildAuthService(mockPrisma, mockConfig);

      // Attempt with bad signature
      try {
        await authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: "invalid-signature",
        });
      } catch {
        // Expected to fail
      }

      // Challenge was still marked as consumed (atomic update happened first)
      expect(updateCalled).toBe(true);
      expect(mockPrisma.walletChallenge.updateMany).toHaveBeenCalled();
    });

    it("second_attempt_with_different_signature_fails", async () => {
      const challengeId = "challenge_second_attempt";
      const nonce = "nonce_second_attempt";
      const expiresAt = new Date(Date.now() + 60_000);
      const message = generateChallengeMessage(walletAddressA, nonce, expiresAt);

      const mockPrisma = {
        walletChallenge: {
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 }) // First attempt marks as used
            .mockResolvedValueOnce({ count: 0 }), // Second attempt finds it already used
          findFirst: jest
            .fn()
            .mockResolvedValue({ message, walletAddress: walletAddressA, usedAt: new Date() }),
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({
              message,
              walletAddress: walletAddressA,
            }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn(),
        },
      };

      const authService = buildAuthService(mockPrisma);
      authService = buildAuthService(mockPrisma, mockConfig);

      // First attempt with bad signature fails after consuming
      try {
        await authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: "bad-sig-1",
        });
      } catch {
        // Expected
      }

      // Second attempt with different bad signature also fails
      await expect(
        authService.verifyChallenge({
          challengeId,
          walletAddress: walletAddressA,
          signature: "bad-sig-2",
        }),
      ).rejects.toThrow("Challenge is expired or unavailable");
    });
  });
});



