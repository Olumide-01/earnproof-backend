import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthEventType } from "@prisma/client";
import { Keypair } from "@stellar/stellar-base";
import { createHash } from "crypto";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const keypair = Keypair.random();
const walletAddress = keypair.publicKey();

const challenge = {
  id: "challenge_1",
  walletAddress,
  message: "EarnProof wallet authentication",
  expiresAt: new Date(Date.now() + 60_000),
  usedAt: null,
  networkPassphrase: "Test SDF Network ; September 2015",
  origin: "http://localhost:3000",
};

const dbUser = {
  id: "user_1",
  walletAddress,
  walletHash: "sha256:hash",
  role: "WORKER",
};

function makePrismaMock() {
  return {
    walletChallenge: {
      create: jest.fn().mockResolvedValue(challenge),
      findFirst: jest.fn().mockResolvedValue(challenge),
      findUnique: jest.fn().mockResolvedValue(challenge),
      update: jest.fn().mockResolvedValue({ ...challenge, usedAt: new Date() }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      upsert: jest.fn().mockResolvedValue(dbUser),
      findUnique: jest.fn().mockResolvedValue({
        ...dbUser,
        status: "ACTIVE",
        lastLoginAt: new Date(),
      }),
    },
  };
}

function makeAuditServiceMock() {
  return {
    recordEvent: jest.fn().mockResolvedValue(undefined),
  };
}

function makeRateLimiterMock() {
  return {
    checkChallengeCreationLimit: jest.fn().mockResolvedValue(undefined),
    checkVerificationLimit: jest.fn().mockResolvedValue(undefined),
  };
}

const config = {
  getOrThrow: (key: string) => {
    const values: Record<string, string> = {
      appUrl: "http://localhost:3000",
      "stellar.networkPassphrase": "Test SDF Network ; September 2015",
      sessionSecret: "test_secret_123",
    };
    return values[key];
  },
} as ConfigService;

// ---------------------------------------------------------------------------
// AuthService.createChallenge
// ---------------------------------------------------------------------------

describe("AuthService.createChallenge", () => {
  it("returns a challenge record with id and message", async () => {
    const prisma = makePrismaMock();
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    await expect(svc.createChallenge(walletAddress)).resolves.toMatchObject({
      id: "challenge_1",
      message: expect.any(String),
    });
  });

  it("checks rate limits before creating challenge", async () => {
    const prisma = makePrismaMock();
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    await svc.createChallenge(walletAddress, "client-metadata");

    expect(rateLimiter.checkChallengeCreationLimit).toHaveBeenCalledWith(
      walletAddress,
      "client-metadata",
    );
  });

  it("records successful challenge creation", async () => {
    const prisma = makePrismaMock();
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    await svc.createChallenge(walletAddress);

    expect(auditSvc.recordEvent).toHaveBeenCalledWith(
      AuthEventType.CHALLENGE_CREATED,
      walletAddress,
      {
        challengeId: "challenge_1",
        success: true,
        clientMetadata: undefined,
      },
    );
  });
});

// ---------------------------------------------------------------------------
// AuthService.verifyChallenge
// ---------------------------------------------------------------------------

describe("AuthService.verifyChallenge", () => {
  it("creates a persisted session and returns tokenType Bearer", async () => {
    const prisma = makePrismaMock();
    // SessionService needs authSession.create
    (prisma as Record<string, unknown>).authSession = {
      create: jest.fn().mockResolvedValue({}),
    };
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    const signature = keypair
      .sign(sep53MessageHash(challenge.message))
      .toString("base64");

    const result = await svc.verifyChallenge({
      challengeId: challenge.id,
      walletAddress,
      signature,
    });

    expect(result.user.id).toBe("user_1");
    expect(result.session.tokenType).toBe("Bearer");
    // Token must be opaque format: <id>.<64-hex-chars>
    expect(result.session.token).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    // sessionId and expiresAt must be present in the response
    expect(result.session.sessionId).toBeTruthy();
    expect(result.session.expiresAt).toBeInstanceOf(Date);
  });

  it.each(["SUSPENDED", "REVOKED", "DELETED"])(
    "refuses a session to a %s account after a valid signature and audits it",
    async (status) => {
      const prisma = makePrismaMock();
      prisma.user.findUnique.mockResolvedValue({ ...dbUser, status });
      const authSession = { create: jest.fn() };
      (prisma as Record<string, unknown>).authSession = authSession;
      const auditSvc = makeAuditServiceMock();
      const svc = new AuthService(
        prisma as never,
        new SessionService(prisma as never, config),
        auditSvc as never,
        makeRateLimiterMock() as never,
        config,
      );

      const signature = keypair
        .sign(sep53MessageHash(challenge.message))
        .toString("base64");

      await expect(
        svc.verifyChallenge({ challengeId: challenge.id, walletAddress, signature }),
      ).rejects.toThrow("Account is not active");

      expect(prisma.user.upsert).not.toHaveBeenCalled();
      expect(authSession.create).not.toHaveBeenCalled();
      expect(auditSvc.recordEvent).toHaveBeenCalledWith(
        AuthEventType.ACCOUNT_INACTIVE,
        walletAddress,
        expect.objectContaining({ success: false, challengeId: challenge.id }),
      );
    },
  );

  it("checks rate limits before verification", async () => {
    const prisma = makePrismaMock();
    (prisma as Record<string, unknown>).authSession = {
      create: jest.fn().mockResolvedValue({}),
    };
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    const signature = keypair
      .sign(sep53MessageHash(challenge.message))
      .toString("base64");

    await svc.verifyChallenge({
      challengeId: challenge.id,
      walletAddress,
      signature,
      clientMetadata: "client-meta",
    });

    expect(rateLimiter.checkVerificationLimit).toHaveBeenCalledWith(
      walletAddress,
      "client-meta",
    );
  });

  it("records successful verification", async () => {
    const prisma = makePrismaMock();
    (prisma as Record<string, unknown>).authSession = {
      create: jest.fn().mockResolvedValue({}),
    };
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    const signature = keypair
      .sign(sep53MessageHash(challenge.message))
      .toString("base64");

    await svc.verifyChallenge({
      challengeId: challenge.id,
      walletAddress,
      signature,
    });

    expect(auditSvc.recordEvent).toHaveBeenCalledWith(
      AuthEventType.CHALLENGE_VERIFIED,
      walletAddress,
      {
        challengeId: challenge.id,
        success: true,
        clientMetadata: undefined,
      },
    );
  });

  it("records invalid signature event", async () => {
    const prisma = makePrismaMock();
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    const signature = "invalid_signature";

    await expect(
      svc.verifyChallenge({
        challengeId: challenge.id,
        walletAddress,
        signature,
      }),
    ).rejects.toThrow("Invalid wallet signature");

    expect(auditSvc.recordEvent).toHaveBeenCalledWith(
      AuthEventType.SIGNATURE_INVALID,
      walletAddress,
      {
        challengeId: challenge.id,
        success: false,
        failureReason: "Invalid signature",
        clientMetadata: undefined,
      },
    );
  });

  it("records challenge replay event", async () => {
    const prisma = makePrismaMock();
    // The atomic consumption update matches 0 rows (already used), and the
    // replay-detection lookup finds the challenge with usedAt already set.
    prisma.walletChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.walletChallenge.findFirst.mockResolvedValueOnce({
      ...challenge,
      usedAt: new Date(),
    });

    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    const signature = keypair
      .sign(sep53MessageHash(challenge.message))
      .toString("base64");

    await expect(
      svc.verifyChallenge({
        challengeId: challenge.id,
        walletAddress,
        signature,
      }),
    ).rejects.toThrow("Challenge is expired or unavailable");

    expect(auditSvc.recordEvent).toHaveBeenCalledWith(
      AuthEventType.CHALLENGE_REPLAYED,
      walletAddress,
      {
        challengeId: challenge.id,
        success: false,
        failureReason: "Challenge already used",
        clientMetadata: undefined,
      },
    );
  });

  it("records challenge expired event", async () => {
    const prisma = makePrismaMock();
    // Nothing consumed and no used row either: expired, or never existed.
    prisma.walletChallenge.updateMany.mockResolvedValue({ count: 0 });
    prisma.walletChallenge.findFirst.mockResolvedValue(null);
    // The atomic consumption update matches 0 rows (expired/missing), and
    // the replay-detection lookup finds nothing with usedAt set either.
    prisma.walletChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.walletChallenge.findFirst.mockResolvedValueOnce(null);

    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    const signature = keypair
      .sign(sep53MessageHash(challenge.message))
      .toString("base64");

    await expect(
      svc.verifyChallenge({
        challengeId: challenge.id,
        walletAddress,
        signature,
      }),
    ).rejects.toThrow("Challenge is expired or unavailable");

    expect(auditSvc.recordEvent).toHaveBeenCalledWith(
      AuthEventType.CHALLENGE_EXPIRED,
      walletAddress,
      {
        challengeId: challenge.id,
        success: false,
        failureReason: "Challenge expired or not found",
        clientMetadata: undefined,
      },
    );
  });

  it("rejects raw-message signatures that do not follow SEP-53", async () => {
    const prisma = makePrismaMock();
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    const signature = keypair
      .sign(Buffer.from(challenge.message, "utf8"))
      .toString("base64");

    await expect(
      svc.verifyChallenge({
        challengeId: challenge.id,
        walletAddress,
        signature,
      }),
    ).rejects.toThrow("Invalid wallet signature");
  });

  it("consumes the challenge atomically before verifying the signature", async () => {
    const prisma = makePrismaMock();
    (prisma as Record<string, unknown>).authSession = {
      create: jest.fn().mockResolvedValue({}),
    };
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    const signature = keypair
      .sign(sep53MessageHash(challenge.message))
      .toString("base64");

    await svc.verifyChallenge({ challengeId: challenge.id, walletAddress, signature });

    // Consumed by the guarded update itself, before the signature is checked:
    // the where clause is what makes concurrent verifications race for one row.
    // Consumption happens via the atomic updateMany (usedAt: null in its
    // where clause guards against a concurrent double-consume) — there is
    // no separate .update() call afterward.
    expect(prisma.walletChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: challenge.id,
          walletAddress,
          usedAt: null,
        }),
        data: { usedAt: expect.any(Date) },
      }),
    );
    expect(prisma.walletChallenge.update).not.toHaveBeenCalled();
  });

  it("throws when no matching challenge exists", async () => {
    const prisma = makePrismaMock();
    prisma.walletChallenge.updateMany.mockResolvedValue({ count: 0 });
    prisma.walletChallenge.findFirst.mockResolvedValue(null);
    prisma.walletChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.walletChallenge.findFirst.mockResolvedValueOnce(null);
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    await expect(
      svc.verifyChallenge({ challengeId: "bad", walletAddress, signature: "sig" }),
    ).rejects.toThrow("Challenge is expired or unavailable");
  });

  it("handles concurrent challenge consumption attempts - first wins, second fails", async () => {
    // Regression test for challenge consumption edge case where multiple concurrent
    // requests attempt to consume the same challenge. The atomic updateMany with
    // usedAt: null guard ensures only one succeeds. This test verifies that:
    // 1. The first call consumes the challenge successfully
    // 2. The second concurrent call fails with challenge replay detection
    // 3. Both audit events are recorded correctly

    const prisma = makePrismaMock();
    (prisma as Record<string, unknown>).authSession = {
      create: jest.fn().mockResolvedValue({}),
    };

    // First verification: successful consumption
    prisma.walletChallenge.updateMany.mockResolvedValueOnce({ count: 1 });
    // Finds the challenge after atomic update
    prisma.walletChallenge.findUnique.mockResolvedValueOnce(challenge);

    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    const signature = keypair
      .sign(sep53MessageHash(challenge.message))
      .toString("base64");

    // First verification succeeds
    const result = await svc.verifyChallenge({
      challengeId: challenge.id,
      walletAddress,
      signature,
    });

    expect(result.user.id).toBe("user_1");
    expect(auditSvc.recordEvent).toHaveBeenCalledWith(
      AuthEventType.CHALLENGE_VERIFIED,
      walletAddress,
      expect.objectContaining({ success: true }),
    );

    // Reset mocks for second attempt
    auditSvc.recordEvent.mockClear();

    // Second verification: consumption fails (challenge already used)
    // The updateMany matches 0 rows because usedAt is no longer null
    prisma.walletChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    // The replay detection lookup finds the challenge with usedAt set
    const usedChallenge = { ...challenge, usedAt: new Date() };
    prisma.walletChallenge.findFirst.mockResolvedValueOnce(usedChallenge);

    // Second verification should fail with replay detection
    await expect(
      svc.verifyChallenge({
        challengeId: challenge.id,
        walletAddress,
        signature,
      }),
    ).rejects.toThrow("Challenge is expired or unavailable");

    expect(auditSvc.recordEvent).toHaveBeenCalledWith(
      AuthEventType.CHALLENGE_REPLAYED,
      walletAddress,
      expect.objectContaining({
        success: false,
        failureReason: "Challenge already used",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// AuthService.getSession
// ---------------------------------------------------------------------------

describe("AuthService.getSession", () => {
  it("returns user data for a valid userId", async () => {
    const prisma = makePrismaMock();
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    await expect(svc.getSession("user_1")).resolves.toMatchObject({
      user: { id: "user_1", walletAddress },
    });
  });

  it("throws UnauthorizedException when user does not exist", async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique.mockResolvedValue(null);
    const sessionSvc = new SessionService(prisma as never, config);
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    await expect(svc.getSession("missing_user")).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

// ---------------------------------------------------------------------------
// AuthService.logout
// ---------------------------------------------------------------------------

describe("AuthService.logout", () => {
  it("calls sessionService.revoke with the supplied sessionId", async () => {
    const prisma = makePrismaMock();
    (prisma as Record<string, unknown>).authSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const sessionSvc = new SessionService(prisma as never, config);
    const revokeSpy = jest.spyOn(sessionSvc, "revoke").mockResolvedValue();
    const auditSvc = makeAuditServiceMock();
    const rateLimiter = makeRateLimiterMock();
    const svc = new AuthService(
      prisma as never,
      sessionSvc,
      auditSvc as never,
      rateLimiter as never,
      config,
    );

    await svc.logout("sess_abc");

    expect(revokeSpy).toHaveBeenCalledWith("sess_abc");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sep53MessageHash(message: string) {
  return createHash("sha256")
    .update("Stellar Signed Message:\n", "utf8")
    .update(message, "utf8")
    .digest();
}
