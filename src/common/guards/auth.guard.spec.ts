import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import { SessionService } from "../../auth/session.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(authHeader?: string): ExecutionContext {
  const request = {
    headers: { authorization: authHeader },
    user: undefined as unknown,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const activeDbUser = {
  id: "user_1",
  walletAddress: "G".padEnd(56, "A"),
  walletHash: "sha256:abc",
  role: "WORKER",
  status: "ACTIVE",
};

function makeSessionServiceMock(
  validateResult:
    | { sessionId: string; userId: string; walletHash?: string | null }
    | Error,
) {
  return {
    validate: jest.fn().mockImplementation(() => {
      if (validateResult instanceof Error) return Promise.reject(validateResult);
      return Promise.resolve(validateResult);
    }),
  } as unknown as SessionService;
}

function makePrismaMock(user: typeof activeDbUser | null = activeDbUser) {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
    },
  };
}

// ---------------------------------------------------------------------------
// Missing / malformed Authorization header
// ---------------------------------------------------------------------------

describe("AuthGuard — missing or malformed header", () => {
  it("throws UnauthorizedException when Authorization header is absent", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock({ sessionId: "s", userId: "u" }),
      makePrismaMock() as never,
    );

    await expect(guard.canActivate(makeContext())).rejects.toThrow(
      "Missing bearer token",
    );
  });

  it("throws when header does not start with 'Bearer '", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock({ sessionId: "s", userId: "u" }),
      makePrismaMock() as never,
    );

    await expect(guard.canActivate(makeContext("Basic abc123"))).rejects.toThrow(
      "Missing bearer token",
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid / revoked / expired sessions (propagated from SessionService)
// ---------------------------------------------------------------------------

describe("AuthGuard — session validation failures", () => {
  it("propagates 'Session not found' from SessionService", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock(new UnauthorizedException("Session not found")),
      makePrismaMock() as never,
    );

    await expect(
      guard.canActivate(makeContext("Bearer fake.token")),
    ).rejects.toThrow("Session not found");
  });

  it("propagates 'Session has been revoked' from SessionService", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock(
        new UnauthorizedException("Session has been revoked"),
      ),
      makePrismaMock() as never,
    );

    await expect(
      guard.canActivate(makeContext("Bearer revoked.token")),
    ).rejects.toThrow("Session has been revoked");
  });

  it("propagates 'Session has expired' from SessionService", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock(
        new UnauthorizedException("Session has expired"),
      ),
      makePrismaMock() as never,
    );

    await expect(
      guard.canActivate(makeContext("Bearer expired.token")),
    ).rejects.toThrow("Session has expired");
  });

  it("propagates 'Malformed session token' from SessionService", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock(
        new UnauthorizedException("Malformed session token"),
      ),
      makePrismaMock() as never,
    );

    await expect(guard.canActivate(makeContext("Bearer malformed"))).rejects.toThrow(
      "Malformed session token",
    );
  });
});

// ---------------------------------------------------------------------------
// Account status enforcement
// ---------------------------------------------------------------------------

describe("AuthGuard — account status checks", () => {
  it("throws when the user account is SUSPENDED", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock({ sessionId: "s", userId: "user_1" }),
      makePrismaMock({ ...activeDbUser, status: "SUSPENDED" }) as never,
    );

    await expect(
      guard.canActivate(makeContext("Bearer valid.token")),
    ).rejects.toThrow("Account is not active");
  });

  it("throws when the user account is REVOKED", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock({ sessionId: "s", userId: "user_1" }),
      makePrismaMock({ ...activeDbUser, status: "REVOKED" }) as never,
    );

    await expect(
      guard.canActivate(makeContext("Bearer valid.token")),
    ).rejects.toThrow("Account is not active");
  });

  it("throws when the user account is DELETED", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock({ sessionId: "s", userId: "user_1" }),
      makePrismaMock({ ...activeDbUser, status: "DELETED" }) as never,
    );

    await expect(
      guard.canActivate(makeContext("Bearer valid.token")),
    ).rejects.toThrow("Account is not active");
  });

  it("admits a PENDING account, which may still authenticate", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock({ sessionId: "s", userId: "user_1" }),
      makePrismaMock({ ...activeDbUser, status: "PENDING" }) as never,
    );

    await expect(
      guard.canActivate(makeContext("Bearer valid.token")),
    ).resolves.toBe(true);
  });

  it("throws when user row is not found in DB", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock({ sessionId: "s", userId: "user_1" }),
      makePrismaMock(null) as never,
    );

    await expect(
      guard.canActivate(makeContext("Bearer valid.token")),
    ).rejects.toThrow("User not found");
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("AuthGuard — valid session", () => {
  it("returns true and attaches AuthenticatedSession to request.user", async () => {
    const ctx = makeContext("Bearer valid.sessiontoken");
    const guard = new AuthGuard(
      makeSessionServiceMock({ sessionId: "sess_1", userId: "user_1" }),
      makePrismaMock() as never,
    );

    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    const req = ctx.switchToHttp().getRequest() as { user: Record<string, unknown> };
    expect(req.user).toMatchObject({
      sessionId: "sess_1",
      id: "user_1",
      walletAddress: "G".padEnd(56, "A"),
      role: "WORKER",
    });
  });
});

// ---------------------------------------------------------------------------
// Wallet binding
// ---------------------------------------------------------------------------

describe("AuthGuard — wallet binding", () => {
  it("admits a session bound to the account's current wallet", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock({ sessionId: "s", userId: "user_1", walletHash: "sha256:abc" }),
      makePrismaMock() as never,
    );

    await expect(guard.canActivate(makeContext("Bearer valid.token"))).resolves.toBe(true);
  });

  it("refuses a session issued to a wallet the account no longer holds", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock({ sessionId: "s", userId: "user_1", walletHash: "sha256:previous" }),
      makePrismaMock() as never,
    );

    await expect(guard.canActivate(makeContext("Bearer valid.token"))).rejects.toThrow(
      "Session is no longer valid",
    );
  });

  it("admits a legacy session that carries no wallet binding", async () => {
    const guard = new AuthGuard(
      makeSessionServiceMock({ sessionId: "s", userId: "user_1", walletHash: null }),
      makePrismaMock() as never,
    );

    await expect(guard.canActivate(makeContext("Bearer valid.token"))).resolves.toBe(true);
  });
});
