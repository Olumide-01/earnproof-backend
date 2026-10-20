import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SessionService } from "./session.service";
import { FixedClock } from "../../test/time/fixed-clock";

// ---------------------------------------------------------------------------
// Minimal Prisma mock — every method is a jest.fn() returning sensible defaults
// ---------------------------------------------------------------------------
function makePrismaMock() {
  return {
    authSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

const config = {
  getOrThrow: () => "test_secret_xyz",
} as unknown as ConfigService;

const validToken = `${"A".repeat(16)}.${"a".repeat(64)}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid-looking active session row. */
function activeSession(overrides: Partial<{
  id: string;
  userId: string;
  tokenHash: string;
  revokedAt: Date | null;
  expiresAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "sess_1",
    userId: overrides.userId ?? "user_1",
    tokenHash: overrides.tokenHash ?? "hash",
    revokedAt: overrides.revokedAt ?? null,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
  };
}

// ---------------------------------------------------------------------------
// SessionService.create
// ---------------------------------------------------------------------------

describe("SessionService.create", () => {
  it("returns an opaque token, sessionId and expiresAt", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config);

    const result = await svc.create({
      id: "user_1",
      walletAddress: "G".padEnd(56, "A"),
      walletHash: "sha256:abc",
      role: "WORKER",
    });

    expect(result.token).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    expect(result.sessionId).toBeTruthy();
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("stores only the hash — the raw token is never written to DB", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config);

    const { token } = await svc.create({
      id: "user_1",
      walletAddress: "G".padEnd(56, "A"),
      walletHash: "sha256:abc",
      role: "WORKER",
    });

    const [call] = prisma.authSession.create.mock.calls;
    const storedData = call[0].data as Record<string, unknown>;

    // The raw token must not appear anywhere in the stored data.
    expect(JSON.stringify(storedData)).not.toContain(token);
    // tokenHash must be present and must differ from the token.
    expect(storedData.tokenHash).toBeTruthy();
    expect(storedData.tokenHash).not.toEqual(token);
  });

  it("uses the supplied ttl", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config);
    const before = Date.now();

    const { expiresAt } = await svc.create(
      { id: "u", walletAddress: "G".padEnd(56, "A"), walletHash: "h", role: "WORKER" },
      3600,
    );

    const diff = expiresAt.getTime() - before;
    expect(diff).toBeGreaterThanOrEqual(3600 * 1000 - 50);
    expect(diff).toBeLessThanOrEqual(3600 * 1000 + 500);
  });
});

// ---------------------------------------------------------------------------
// SessionService.validate
// ---------------------------------------------------------------------------

describe("SessionService.validate", () => {
  it("returns sessionId and userId for a valid token", async () => {
    const prisma = makePrismaMock();
    const sess = activeSession();
    prisma.authSession.findUnique.mockResolvedValue(sess);
    prisma.authSession.update.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config);

    // Create a real token so the format check passes.
    prisma.authSession.create.mockResolvedValue({});
    const { token } = await svc.create({
      id: "user_1",
      walletAddress: "G".padEnd(56, "A"),
      walletHash: "sha256:abc",
      role: "WORKER",
    });

    // Re-wire findUnique to return our fake session for whatever hash is queried.
    prisma.authSession.findUnique.mockResolvedValue(sess);
    const result = await svc.validate(token);

    expect(result.userId).toBe("user_1");
    expect(result.sessionId).toBe("sess_1");
  });

  it("rejects a malformed token (no dot separator)", async () => {
    const prisma = makePrismaMock();
    const svc = new SessionService(prisma as never, config);

    await expect(svc.validate("nodottoken")).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.authSession.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an empty string token", async () => {
    const prisma = makePrismaMock();
    const svc = new SessionService(prisma as never, config);

    await expect(svc.validate("")).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a token whose session row is missing", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockResolvedValue(null);
    const svc = new SessionService(prisma as never, config);

    await expect(svc.validate(validToken)).rejects.toThrow(
      "Session not found",
    );
  });

  it("rejects a revoked session", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ revokedAt: new Date() }),
    );
    const svc = new SessionService(prisma as never, config);

    await expect(svc.validate(validToken)).rejects.toThrow(
      "Session has been revoked",
    );
  });

  it("rejects an expired session", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const svc = new SessionService(prisma as never, config);

    await expect(svc.validate(validToken)).rejects.toThrow(
      "Session has expired",
    );
  });

  it("updates lastUsedAt on successful validation", async () => {
    const prisma = makePrismaMock();
    const sess = activeSession();
    prisma.authSession.findUnique.mockResolvedValue(sess);
    prisma.authSession.update.mockResolvedValue({});
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config);

    const { token } = await svc.create({
      id: "user_1",
      walletAddress: "G".padEnd(56, "A"),
      walletHash: "sha256:abc",
      role: "WORKER",
    });
    prisma.authSession.findUnique.mockResolvedValue(sess);

    await svc.validate(token);

    // Give the fire-and-forget update a tick to fire.
    await new Promise((r) => setImmediate(r));
    expect(prisma.authSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sess.id },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// SessionService.tryIdentify
// ---------------------------------------------------------------------------

describe("SessionService.tryIdentify", () => {
  it("returns a session identity for a live persisted session", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ id: "sess_live", userId: "user_live" }),
    );
    const svc = new SessionService(prisma as never, config);

    await expect(svc.tryIdentify(validToken)).resolves.toEqual({
      sessionId: "sess_live",
      userId: "user_live",
    });
  });

  it("returns null for a malformed token without querying storage", async () => {
    const prisma = makePrismaMock();
    const svc = new SessionService(prisma as never, config);

    await expect(svc.tryIdentify("not-a-session")).resolves.toBeNull();
    expect(prisma.authSession.findUnique).not.toHaveBeenCalled();
  });

  it("returns null for missing, revoked, or expired sessions", async () => {
    const prisma = makePrismaMock();
    const svc = new SessionService(prisma as never, config);

    prisma.authSession.findUnique.mockResolvedValueOnce(null);
    await expect(svc.tryIdentify(validToken)).resolves.toBeNull();

    prisma.authSession.findUnique.mockResolvedValueOnce(
      activeSession({ revokedAt: new Date() }),
    );
    await expect(svc.tryIdentify(validToken)).resolves.toBeNull();

    prisma.authSession.findUnique.mockResolvedValueOnce(
      activeSession({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(svc.tryIdentify(validToken)).resolves.toBeNull();
  });

  it("returns null if session storage is temporarily unavailable", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockRejectedValue(new Error("database down"));
    const svc = new SessionService(prisma as never, config);

    await expect(svc.tryIdentify(validToken)).resolves.toBeNull();
  });

  it("does not update lastUsedAt", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockResolvedValue(activeSession());
    const svc = new SessionService(prisma as never, config);

    await svc.tryIdentify(validToken);

    expect(prisma.authSession.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SessionService.revoke
// ---------------------------------------------------------------------------

describe("SessionService.revoke", () => {
  it("sets revokedAt on the targeted session", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.updateMany.mockResolvedValue({ count: 1 });
    const svc = new SessionService(prisma as never, config);

    await svc.revoke("sess_1");

    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "sess_1", revokedAt: null }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it("is idempotent — revoking twice does not throw", async () => {
    const prisma = makePrismaMock();
    // Second call matches 0 rows — still resolves cleanly.
    prisma.authSession.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const svc = new SessionService(prisma as never, config);

    await expect(svc.revoke("sess_1")).resolves.toBeUndefined();
    await expect(svc.revoke("sess_1")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SessionService.rotate
// ---------------------------------------------------------------------------

describe("SessionService.rotate", () => {
  function runTransactions(prisma: ReturnType<typeof makePrismaMock>) {
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
  }

  it("creates a new session and revokes the old one atomically", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ id: "old_sess" }),
    );
    runTransactions(prisma);
    prisma.authSession.create.mockResolvedValue({});
    prisma.authSession.updateMany.mockResolvedValue({ count: 1 });
    const svc = new SessionService(prisma as never, config);

    const result = await svc.rotate("old_sess", {
      id: "user_1",
      walletAddress: "G".padEnd(56, "A"),
      walletHash: "sha256:abc",
      role: "WORKER",
    });

    expect(result.token).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    expect(result.sessionId).not.toBe("old_sess");
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.authSession.create).toHaveBeenCalledTimes(1);
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "old_sess", userId: "user_1", revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it("rejects rotation of an already-revoked session", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ id: "old_sess", revokedAt: new Date() }),
    );
    runTransactions(prisma);
    const svc = new SessionService(prisma as never, config);

    await expect(
      svc.rotate("old_sess", {
        id: "user_1",
        walletAddress: "G".padEnd(56, "A"),
        walletHash: "sha256:abc",
        role: "WORKER",
      }),
    ).rejects.toThrow("Cannot rotate an already-revoked session");
  });

  it("rejects rotation of a missing session", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockResolvedValue(null);
    runTransactions(prisma);
    const svc = new SessionService(prisma as never, config);

    await expect(
      svc.rotate("ghost_sess", {
        id: "user_1",
        walletAddress: "G".padEnd(56, "A"),
        walletHash: "sha256:abc",
        role: "WORKER",
      }),
    ).rejects.toThrow("Session not found");
  });

  it("issues a token that is different from the original", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ id: "old_sess" }),
    );
    runTransactions(prisma);
    prisma.authSession.updateMany.mockResolvedValue({ count: 1 });
    const svc = new SessionService(prisma as never, config);

    const originalToken = "old_sess.aaaa".padEnd(67, "0");
    const rotated = await svc.rotate("old_sess", {
      id: "user_1",
      walletAddress: "G".padEnd(56, "A"),
      walletHash: "sha256:abc",
      role: "WORKER",
    });

    expect(rotated.token).not.toBe(originalToken);
  });

  it("allows only one concurrent rotation of the same session", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ id: "old_sess" }),
    );
    prisma.authSession.create.mockResolvedValue({});
    prisma.authSession.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    runTransactions(prisma);
    const svc = new SessionService(prisma as never, config);
    const user = {
      id: "user_1",
      walletAddress: "G".padEnd(56, "A"),
      walletHash: "sha256:abc",
      role: "WORKER",
    };

    const results = await Promise.allSettled([
      svc.rotate("old_sess", user),
      svc.rotate("old_sess", user),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// SessionService.revokeAll
// ---------------------------------------------------------------------------

describe("SessionService.revokeAll", () => {
  it("revokes all active sessions for a user", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.updateMany.mockResolvedValue({ count: 3 });
    const svc = new SessionService(prisma as never, config);

    await svc.revokeAll("user_1");

    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { userId: "user_1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

// ---------------------------------------------------------------------------
// SessionService.deleteExpired  (retention/cleanup)
// ---------------------------------------------------------------------------

describe("SessionService.deleteExpired", () => {
  it("deletes rows with expiresAt before the cutoff and returns count", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.deleteMany.mockResolvedValue({ count: 7 });
    const svc = new SessionService(prisma as never, config);

    const count = await svc.deleteExpired(new Date("2030-01-01"));

    expect(count).toBe(7);
    expect(prisma.authSession.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: new Date("2030-01-01") } },
    });
  });

  it("defaults cutoff to now when no argument is provided", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.deleteMany.mockResolvedValue({ count: 0 });
    const svc = new SessionService(prisma as never, config);
    const before = new Date();

    await svc.deleteExpired();

    const call = prisma.authSession.deleteMany.mock.calls[0][0] as {
      where: { expiresAt: { lt: Date } };
    };
    const cutoff = call.where.expiresAt.lt;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before.getTime() - 10);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() + 10);
  });
});

describe("SessionService device metadata", () => {
  it("derives and stores only a coarse label from allowlisted headers", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config);

    await svc.create(
      { id: "user_1", walletAddress: "G".padEnd(56, "A"), walletHash: "h", role: "WORKER" },
      undefined,
      {
        "user-agent": "Mozilla/5.0 Chrome/120.0 (Macintosh; Intel Mac OS X)",
        "sec-ch-ua-platform": '"macOS"',
        "sec-ch-ua-mobile": "?0",
      },
    );

    const stored = prisma.authSession.create.mock.calls[0][0].data;
    expect(stored.deviceLabel).toBe("Chrome / macOS / Desktop");
    expect(JSON.stringify(stored)).not.toContain("Mozilla");
    expect(stored.firstSeenAt).toBeInstanceOf(Date);
    expect(stored.lastSeenAt).toBeInstanceOf(Date);
  });

  it("uses a safe bounded label for malformed or oversized headers", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config);

    await svc.create(
      { id: "user_1", walletAddress: "G".padEnd(56, "A"), walletHash: "h", role: "WORKER" },
      undefined,
      { "user-agent": ["<script>".repeat(200), "ignored"] },
    );

    const label = prisma.authSession.create.mock.calls[0][0].data.deviceLabel;
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label).not.toContain("<");
    expect(label).toBe("Browser / Unknown platform / Desktop");
  });

  it("lists and renames only sessions owned by the caller", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findMany.mockResolvedValue([{ id: "owned", deviceLabel: "Phone" }]);
    prisma.authSession.updateMany.mockResolvedValue({ count: 1 });
    const svc = new SessionService(prisma as never, config);

    await expect(svc.listForUser("user_1")).resolves.toEqual([{ id: "owned", deviceLabel: "Phone" }]);
    await svc.renameForUser("user_1", "owned", "<Office>");
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { id: "owned", userId: "user_1" },
      data: { deviceLabel: "&lt;Office&gt;" },
    });

    prisma.authSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.renameForUser("user_1", "other", "Home")).rejects.toThrow(
      "does not belong to the current user",
    );
  });
});

// ---------------------------------------------------------------------------
// Concurrent revocation — simulates a race between two logout requests
// ---------------------------------------------------------------------------

describe("SessionService concurrent revocation", () => {
  it("handles two simultaneous revocations without throwing", async () => {
    const prisma = makePrismaMock();
    // First call revokes (count: 1), second is a no-op (count: 0).
    prisma.authSession.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const svc = new SessionService(prisma as never, config);

    const [r1, r2] = await Promise.allSettled([
      svc.revoke("sess_1"),
      svc.revoke("sess_1"),
    ]);

    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
  });
});

// ---------------------------------------------------------------------------
// Clock-skew and expiry-boundary coverage (earnproof-backend#66)
//
// Uses FixedClock so the exact-before / exact-at / exact-after boundary is
// deterministic — no real sleeps, no timing flakiness.
// ---------------------------------------------------------------------------

describe("SessionService expiry boundary (deterministic clock)", () => {
  const TTL_SECONDS = 3600;

  it("accepts a session strictly before its expiry instant", async () => {
    const clock = new FixedClock("2030-01-01T00:00:00.000Z");
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config, clock);

    const { token, expiresAt } = await svc.create(
      { id: "u", walletAddress: "G".padEnd(56, "A"), walletHash: "h", role: "WORKER" },
      TTL_SECONDS,
    );

    // One millisecond before expiry: still valid.
    clock.set(expiresAt.getTime() - 1);
    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ expiresAt }),
    );
    prisma.authSession.update.mockResolvedValue({});

    await expect(svc.validate(token)).resolves.toEqual(
      expect.objectContaining({ userId: "user_1" }),
    );
  });

  it("rejects a session exactly at its expiry instant (inclusive boundary)", async () => {
    const clock = new FixedClock("2030-01-01T00:00:00.000Z");
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config, clock);

    const { token, expiresAt } = await svc.create(
      { id: "u", walletAddress: "G".padEnd(56, "A"), walletHash: "h", role: "WORKER" },
      TTL_SECONDS,
    );

    // Exactly at expiresAt: expiresAt <= now, so this must be rejected —
    // documents the boundary as inclusive (session.service.ts's own
    // `session.expiresAt <= this.clock.now()` check).
    clock.set(expiresAt.getTime());
    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ expiresAt }),
    );

    await expect(svc.validate(token)).rejects.toThrow("Session has expired");
  });

  it("rejects a session one millisecond after its expiry instant", async () => {
    const clock = new FixedClock("2030-01-01T00:00:00.000Z");
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config, clock);

    const { token, expiresAt } = await svc.create(
      { id: "u", walletAddress: "G".padEnd(56, "A"), walletHash: "h", role: "WORKER" },
      TTL_SECONDS,
    );

    clock.set(expiresAt.getTime() + 1);
    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ expiresAt }),
    );

    await expect(svc.validate(token)).rejects.toThrow("Session has expired");
  });

  it("survives forward clock skew without throwing outside validate's own expiry check", async () => {
    // Forward skew: the clock jumps far ahead between create() and
    // validate() (e.g. NTP correction on the server). The only effect
    // should be that the session is (correctly) treated as expired — no
    // exception other than the documented UnauthorizedException.
    const clock = new FixedClock("2030-01-01T00:00:00.000Z");
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config, clock);

    const { token, expiresAt } = await svc.create(
      { id: "u", walletAddress: "G".padEnd(56, "A"), walletHash: "h", role: "WORKER" },
      TTL_SECONDS,
    );

    clock.advanceMs(365 * 24 * 60 * 60 * 1000); // +1 year
    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ expiresAt }),
    );

    await expect(svc.validate(token)).rejects.toThrow(UnauthorizedException);
  });

  it("survives backward clock skew (still resolves a well-formed expiresAt)", async () => {
    // Backward skew: the clock jumps into the past. create() must still
    // compute a well-formed expiresAt (ttl seconds after whatever "now"
    // the clock reports), and a session created and validated entirely
    // within that skewed window must still be treated as valid.
    const clock = new FixedClock("2030-01-01T00:00:00.000Z");
    clock.advanceMs(-365 * 24 * 60 * 60 * 1000); // -1 year, before create()
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config, clock);

    const { token, expiresAt } = await svc.create(
      { id: "u", walletAddress: "G".padEnd(56, "A"), walletHash: "h", role: "WORKER" },
      TTL_SECONDS,
    );
    expect(expiresAt.getTime()).toBe(clock.nowMs() + TTL_SECONDS * 1000);

    prisma.authSession.findUnique.mockResolvedValue(
      activeSession({ expiresAt }),
    );
    prisma.authSession.update.mockResolvedValue({});

    await expect(svc.validate(token)).resolves.toEqual(
      expect.objectContaining({ userId: "user_1" }),
    );
  });

  it("deleteExpired's default cutoff tracks the injected clock, not the real system clock", async () => {
    // Regression guard for the injectable-clock refactor itself: the
    // default-parameter cutoff must come from `clock.now()`, not a bare
    // `new Date()` that would silently ignore an injected FixedClock.
    const clock = new FixedClock("2030-06-15T12:00:00.000Z");
    const prisma = makePrismaMock();
    prisma.authSession.deleteMany.mockResolvedValue({ count: 0 });
    const svc = new SessionService(prisma as never, config, clock);

    await svc.deleteExpired();

    expect(prisma.authSession.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: new Date("2030-06-15T12:00:00.000Z") } },
    });
  });
});

// ---------------------------------------------------------------------------
// Wallet binding (wallet rotation)
// ---------------------------------------------------------------------------

describe("SessionService wallet binding", () => {
  const user = {
    id: "user_1",
    walletAddress: "G".padEnd(56, "A"),
    walletHash: "sha256:wallet-a",
    role: "WORKER",
  };

  it("records the wallet identity a session is issued to", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.create.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config);

    await svc.create(user);

    expect(prisma.authSession.create.mock.calls[0][0].data.walletHash).toBe(
      "sha256:wallet-a",
    );
  });

  it("carries the wallet identity onto a rotated session", async () => {
    const prisma = makePrismaMock();
    const tx = {
      authSession: {
        findUnique: jest.fn().mockResolvedValue({
          userId: "user_1",
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        }),
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation((run: (client: typeof tx) => unknown) => run(tx));
    const svc = new SessionService(prisma as never, config);

    await svc.rotate("sess_1", user);

    expect(tx.authSession.create.mock.calls[0][0].data.walletHash).toBe("sha256:wallet-a");
  });

  it("returns the bound wallet identity from validate", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockResolvedValue({
      ...activeSession(),
      walletHash: "sha256:wallet-a",
    });
    prisma.authSession.update.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config);

    await expect(svc.validate(validToken)).resolves.toEqual({
      sessionId: "sess_1",
      userId: "user_1",
      walletHash: "sha256:wallet-a",
    });
  });

  it("returns null for a legacy session issued before binding existed", async () => {
    const prisma = makePrismaMock();
    prisma.authSession.findUnique.mockResolvedValue(activeSession());
    prisma.authSession.update.mockResolvedValue({});
    const svc = new SessionService(prisma as never, config);

    await expect(svc.validate(validToken)).resolves.toMatchObject({ walletHash: null });
  });
});
