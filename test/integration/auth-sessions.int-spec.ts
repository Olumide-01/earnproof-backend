import { UnauthorizedException } from "@nestjs/common";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { SessionService } from "../../src/auth/session.service";
import { Clock, SystemClock } from "../../src/common/time/clock";
import { integrationDatabase } from "./harness/database";
import { integrationModule } from "./harness/nest";
import { isUniqueViolation, race, seedUser, violatedTarget } from "./harness/fixtures";

/**
 * Authentication sessions against real PostgreSQL.
 *
 * `SessionService.rotate` is the reason this file exists. Rotation is a
 * conditional update — "revoke this session only if it is still unrevoked, and
 * link it to the replacement" — whose correctness lives entirely in the
 * database: the `revokedAt: null` guard in the `WHERE` clause, the unique index
 * on `rotatedToId`, and the surrounding transaction. Against a mock, two
 * concurrent rotations both "succeed" and the test proves nothing.
 */

const db = integrationDatabase();
// SessionService's constructor takes `clock: Clock = new SystemClock()` as its
// third parameter. Nest's DI container resolves every constructor parameter's
// declared TYPE regardless of default values, so a `Clock` provider must be
// registered explicitly here.
const injector = integrationModule([
  SessionService,
  { provide: Clock, useClass: SystemClock },
]);

function sessions(): SessionService {
  return injector.get(SessionService);
}

async function authenticatedUser(seed: string): Promise<AuthenticatedUser> {
  const user = await seedUser(db.prisma, seed);
  return {
    id: user.id,
    walletAddress: user.walletAddress,
    walletHash: user.walletHash,
    role: user.role,
  };
}

describe("session creation", () => {
  it("stores only a hash of the token", async () => {
    const user = await authenticatedUser("session-create");

    const { token, sessionId } = await sessions().create(user);

    const stored = await db.prisma.authSession.findUniqueOrThrow({
      where: { id: sessionId },
    });

    expect(stored.userId).toBe(user.id);
    expect(stored.revokedAt).toBeNull();
    // The raw token must never reach the row. Comparing the whole row as text
    // catches it landing in any column, not just the one we expected.
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.tokenHash).not.toContain(token);
  });

  it("refuses a session for a user that does not exist", async () => {
    const orphan = sessions().create({
      id: "user_that_does_not_exist",
      walletAddress: "GSYNTHETIC".padEnd(56, "X"),
      walletHash: "sha256:synthetic-orphan",
      role: "WORKER",
    });

    await expect(orphan).rejects.toMatchObject({ code: "P2003" });
    expect(await db.prisma.authSession.count()).toBe(0);
  });
});

describe("session validation", () => {
  it("accepts a live token and records its use", async () => {
    const user = await authenticatedUser("session-validate");
    const { token, sessionId } = await sessions().create(user);

    const validated = await sessions().validate(token);
    // The session is bound to the wallet it was issued to (wallet rotation).
    expect(validated).toEqual({
      sessionId,
      userId: user.id,
      walletHash: user.walletHash,
    });

    // `lastUsedAt` is written fire-and-forget, so it is polled rather than
    // awaited: asserting immediately would be a race, and asserting nothing
    // would leave the write untested.
    await expect(
      eventually(async () => {
        const row = await db.prisma.authSession.findUniqueOrThrow({
          where: { id: sessionId },
        });
        return row.lastUsedAt !== null;
      }),
    ).resolves.toBe(true);
  });

  it("rejects a revoked token", async () => {
    const user = await authenticatedUser("session-revoked");
    const { token, sessionId } = await sessions().create(user);

    await sessions().revoke(sessionId);

    await expect(sessions().validate(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("rejects an expired token", async () => {
    const user = await authenticatedUser("session-expired");
    const { token } = await sessions().create(user, 1);

    // Expire by moving the row, not by sleeping: a sleeping test is slow and
    // still racy.
    await db.prisma.authSession.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await expect(sessions().validate(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("rejects a token whose hash is not in the database", async () => {
    const unknown = `${"A".repeat(16)}.${"a".repeat(64)}`;
    await expect(sessions().validate(unknown)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe("session rotation", () => {
  it("revokes the old session and links it to the new one", async () => {
    const user = await authenticatedUser("session-rotate");
    const original = await sessions().create(user);

    const rotated = await sessions().rotate(original.sessionId, user);

    const previous = await db.prisma.authSession.findUniqueOrThrow({
      where: { id: original.sessionId },
    });

    expect(previous.revokedAt).toBeInstanceOf(Date);
    expect(previous.rotatedToId).toBe(rotated.sessionId);

    const replacement = await db.prisma.authSession.findUniqueOrThrow({
      where: { id: rotated.sessionId },
    });
    expect(replacement.revokedAt).toBeNull();
    expect(replacement.userId).toBe(user.id);
  });

  it("leaves no replacement behind when rotation is refused", async () => {
    const user = await authenticatedUser("session-rotate-refused");
    const original = await sessions().create(user);
    await sessions().revoke(original.sessionId);

    await expect(sessions().rotate(original.sessionId, user)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // Rotation creates the replacement before revoking the original, inside one
    // transaction. If the transaction did not roll back, an orphan session would
    // remain here — and it would be a *valid* credential.
    expect(await db.prisma.authSession.count()).toBe(1);
  });

  it("lets exactly one of two concurrent rotations win", async () => {
    const user = await authenticatedUser("session-rotate-race");
    const original = await sessions().create(user);

    const { fulfilled, rejected } = await race([
      sessions().rotate(original.sessionId, user),
      sessions().rotate(original.sessionId, user),
    ]);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // One original plus one replacement. A second replacement would mean two
    // live credentials descended from one rotation.
    expect(await db.prisma.authSession.count()).toBe(2);
    expect(await db.prisma.authSession.count({ where: { revokedAt: null } })).toBe(1);
  });

  it("refuses to point two sessions at the same replacement", async () => {
    const user = await authenticatedUser("session-rotate-unique");
    const first = await sessions().create(user);
    const second = await sessions().create(user);
    const replacement = await sessions().create(user);

    await db.prisma.authSession.update({
      where: { id: first.sessionId },
      data: { rotatedToId: replacement.sessionId },
    });

    const conflicting = db.prisma.authSession.update({
      where: { id: second.sessionId },
      data: { rotatedToId: replacement.sessionId },
    });

    const error = await conflicting.catch((thrown: unknown) => thrown);
    expect(isUniqueViolation(error)).toBe(true);
    expect(violatedTarget(error)).toContain("rotatedToId");
  });
});

describe("bulk session operations", () => {
  it("revokes every live session for one user and no others", async () => {
    const user = await authenticatedUser("session-revoke-all");
    const other = await authenticatedUser("session-untouched");

    await sessions().create(user);
    await sessions().create(user);
    const untouched = await sessions().create(other);

    await sessions().revokeAll(user.id);

    expect(
      await db.prisma.authSession.count({
        where: { userId: user.id, revokedAt: null },
      }),
    ).toBe(0);

    const survivor = await db.prisma.authSession.findUniqueOrThrow({
      where: { id: untouched.sessionId },
    });
    expect(survivor.revokedAt).toBeNull();
  });

  it("deletes only sessions that expired before the cutoff", async () => {
    const user = await authenticatedUser("session-cleanup");

    const stale = await sessions().create(user, 60);
    const live = await sessions().create(user, 3600);

    await db.prisma.authSession.update({
      where: { id: stale.sessionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const deleted = await sessions().deleteExpired();

    expect(deleted).toBe(1);
    expect(
      await db.prisma.authSession.findUnique({ where: { id: live.sessionId } }),
    ).not.toBeNull();
    expect(
      await db.prisma.authSession.findUnique({ where: { id: stale.sessionId } }),
    ).toBeNull();
  });
});

/**
 * Polls `check` until it returns true or the bound is reached.
 *
 * Bounded by attempts rather than by wall-clock, so a slow CI machine gets more
 * time rather than a different verdict.
 */
async function eventually(
  check: () => Promise<boolean>,
  attempts = 40,
  intervalMs = 25,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
