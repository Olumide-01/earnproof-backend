import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { SessionService } from "../../src/auth/session.service";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { PrismaService } from "../../src/database/prisma.service";
import { FixedClock } from "../time/fixed-clock";

describe("SessionService - Inventory and Revocation (Issue #152)", () => {
  let service: SessionService;
  let prisma: PrismaService;
  let clock: FixedClock;

  const mockUser: AuthenticatedUser = {
    id: "user-123",
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    walletHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    role: "WORKER",
    status: "ACTIVE",
  };

  const otherUser: AuthenticatedUser = {
    id: "user-456",
    walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHI",
    walletHash: "sha256:f4e0d55298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b856",
    role: "WORKER",
    status: "ACTIVE",
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: SessionService,
          useFactory: (prisma: PrismaService) => {
            clock = new FixedClock();
            return new SessionService(prisma, mockConfigService(), clock);
          },
          inject: [PrismaService],
        },
        PrismaService,
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
    prisma = module.get<PrismaService>(PrismaService);

    // Clean up existing sessions for test users
    await prisma.authSession.deleteMany({
      where: { userId: { in: [mockUser.id, otherUser.id] } },
    });
  });

  afterEach(async () => {
    await prisma.authSession.deleteMany({
      where: { userId: { in: [mockUser.id, otherUser.id] } },
    });
  });

  // ============================================================================
  // getSessions() - Session Inventory
  // ============================================================================

  describe("getSessions()", () => {
    it("should return empty list for user with no active sessions", async () => {
      const sessions = await service.getSessions(mockUser.id);
      expect(sessions).toEqual([]);
    });

    it("should return active sessions ordered by creation (newest first)", async () => {
      // Create 3 sessions with controlled timestamps
      clock.setNowMs(100000);
      const session1 = await service.create(mockUser);
      
      clock.setNowMs(200000);
      const session2 = await service.create(mockUser);
      
      clock.setNowMs(300000);
      const session3 = await service.create(mockUser);

      const sessions = await service.getSessions(mockUser.id);

      expect(sessions).toHaveLength(3);
      expect(sessions[0].id).toBe(session3.sessionId);
      expect(sessions[1].id).toBe(session2.sessionId);
      expect(sessions[2].id).toBe(session1.sessionId);
    });

    it("should exclude revoked sessions from inventory", async () => {
      const s1 = await service.create(mockUser);
      const s2 = await service.create(mockUser);
      const s3 = await service.create(mockUser);

      // Revoke the middle session
      await service.revoke(s2.sessionId);

      const sessions = await service.getSessions(mockUser.id);

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id)).toEqual(
        expect.not.arrayContaining([s2.sessionId]),
      );
    });

    it("should include optional deviceFingerprint in results", async () => {
      const session = await service.create(mockUser);

      // Manually set deviceFingerprint
      await prisma.authSession.update({
        where: { id: session.sessionId },
        data: { deviceFingerprint: "sha256:fingerprint123" },
      });

      const sessions = await service.getSessions(mockUser.id);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].deviceFingerprint).toBe("sha256:fingerprint123");
    });

    it("should never expose token hash or raw token", async () => {
      await service.create(mockUser);
      const sessions = await service.getSessions(mockUser.id);

      expect(sessions[0]).not.toHaveProperty("tokenHash");
      expect(sessions[0]).not.toHaveProperty("token");
    });

    it("should only return sessions for the requested user (isolation)", async () => {
      const s1 = await service.create(mockUser);
      const s2 = await service.create(otherUser);

      const userSessions = await service.getSessions(mockUser.id);
      const otherSessions = await service.getSessions(otherUser.id);

      expect(userSessions).toHaveLength(1);
      expect(userSessions[0].id).toBe(s1.sessionId);

      expect(otherSessions).toHaveLength(1);
      expect(otherSessions[0].id).toBe(s2.sessionId);
    });

    it("should track lastUsedAt when sessions are validated", async () => {
      const session = await service.create(mockUser);

      clock.setNowMs(200000);
      await service.validate(session.token);

      const sessions = await service.getSessions(mockUser.id);

      expect(sessions[0].lastUsedAt).toBeDefined();
      expect(sessions[0].lastUsedAt?.getTime()).toBe(200000);
    });
  });

  // ============================================================================
  // revokeOtherSession() - Single Session Revocation
  // ============================================================================

  describe("revokeOtherSession()", () => {
    it("should successfully revoke a session owned by the user", async () => {
      const session = await service.create(mockUser);

      const revokedId = await service.revokeOtherSession(
        session.sessionId,
        mockUser.id,
      );

      expect(revokedId).toBe(session.sessionId);

      // Verify session is marked revoked
      const dbSession = await prisma.authSession.findUnique({
        where: { id: session.sessionId },
      });
      expect(dbSession?.revokedAt).not.toBeNull();
      expect(dbSession?.revocationReason).toBe("REMOTE_REVOCATION");
    });

    it("should set custom revocationReason when provided", async () => {
      const session = await service.create(mockUser);

      await service.revokeOtherSession(
        session.sessionId,
        mockUser.id,
        "DEVICE_LOSS",
      );

      const dbSession = await prisma.authSession.findUnique({
        where: { id: session.sessionId },
      });
      expect(dbSession?.revocationReason).toBe("DEVICE_LOSS");
    });

    it("should throw UnauthorizedException for non-existent session", async () => {
      await expect(
        service.revokeOtherSession("nonexistent-id", mockUser.id),
      ).rejects.toThrow(
        new UnauthorizedException("Session not found"),
      );
    });

    it("should throw UnauthorizedException if session belongs to different user", async () => {
      const session = await service.create(otherUser);

      await expect(
        service.revokeOtherSession(session.sessionId, mockUser.id),
      ).rejects.toThrow(
        new UnauthorizedException("Session does not belong to you"),
      );
    });

    it("should throw UnauthorizedException if session is already revoked", async () => {
      const session = await service.create(mockUser);
      await service.revoke(session.sessionId);

      await expect(
        service.revokeOtherSession(session.sessionId, mockUser.id),
      ).rejects.toThrow(
        new UnauthorizedException("Session is already revoked"),
      );
    });

    it("should not prevent validation of the session before revocation check", async () => {
      const session = await service.create(mockUser);

      // Advance time past expiry
      clock.setNowMs(session.expiresAt.getTime() + 1000);

      // Revoke should still work (we check in DB, not via validate)
      const revokedId = await service.revokeOtherSession(
        session.sessionId,
        mockUser.id,
      );
      expect(revokedId).toBe(session.sessionId);
    });

    it("should be idempotent: revoking an already-revoked session throws", async () => {
      const session = await service.create(mockUser);
      await service.revokeOtherSession(session.sessionId, mockUser.id);

      // Second revocation attempt should throw
      await expect(
        service.revokeOtherSession(session.sessionId, mockUser.id),
      ).rejects.toThrow(
        new UnauthorizedException("Session is already revoked"),
      );
    });

    it("should not affect other sessions of the user", async () => {
      const s1 = await service.create(mockUser);
      const s2 = await service.create(mockUser);

      await service.revokeOtherSession(s1.sessionId, mockUser.id);

      // s2 should still be valid
      const identity = await service.validate(s2.token);
      expect(identity.sessionId).toBe(s2.sessionId);
    });

    it("should prevent user from revoking sessions belonging to others", async () => {
      const s1 = await service.create(mockUser);
      const s2 = await service.create(otherUser);

      await expect(
        service.revokeOtherSession(s2.sessionId, mockUser.id),
      ).rejects.toThrow(
        new UnauthorizedException("Session does not belong to you"),
      );

      // s1 should remain unaffected
      const identity = await service.validate(s1.token);
      expect(identity.sessionId).toBe(s1.sessionId);
    });
  });

  // ============================================================================
  // revokeAllOtherSessions() - Bulk Revocation
  // ============================================================================

  describe("revokeAllOtherSessions()", () => {
    it("should revoke all sessions except the current one", async () => {
      const current = await service.create(mockUser);
      const other1 = await service.create(mockUser);
      const other2 = await service.create(mockUser);

      const count = await service.revokeAllOtherSessions(
        mockUser.id,
        current.sessionId,
      );

      expect(count).toBe(2);

      // Current session should remain active
      const identity = await service.validate(current.token);
      expect(identity.sessionId).toBe(current.sessionId);

      // Other sessions should be revoked
      await expect(service.validate(other1.token)).rejects.toThrow(
        "Session has been revoked",
      );
      await expect(service.validate(other2.token)).rejects.toThrow(
        "Session has been revoked",
      );
    });

    it("should return count of 0 if no other sessions exist", async () => {
      const current = await service.create(mockUser);

      const count = await service.revokeAllOtherSessions(
        mockUser.id,
        current.sessionId,
      );

      expect(count).toBe(0);
    });

    it("should set revocationReason on all revoked sessions", async () => {
      const current = await service.create(mockUser);
      const other1 = await service.create(mockUser);
      const other2 = await service.create(mockUser);

      await service.revokeAllOtherSessions(
        mockUser.id,
        current.sessionId,
        "DEVICE_COMPROMISE",
      );

      const s1 = await prisma.authSession.findUnique({
        where: { id: other1.sessionId },
      });
      const s2 = await prisma.authSession.findUnique({
        where: { id: other2.sessionId },
      });

      expect(s1?.revocationReason).toBe("DEVICE_COMPROMISE");
      expect(s2?.revocationReason).toBe("DEVICE_COMPROMISE");
    });

    it("should throw UnauthorizedException if current session not found", async () => {
      await expect(
        service.revokeAllOtherSessions(mockUser.id, "nonexistent-id"),
      ).rejects.toThrow(
        new UnauthorizedException("Current session not found"),
      );
    });

    it("should throw UnauthorizedException if current session belongs to different user", async () => {
      const otherSession = await service.create(otherUser);

      await expect(
        service.revokeAllOtherSessions(mockUser.id, otherSession.sessionId),
      ).rejects.toThrow(
        new UnauthorizedException("Current session does not belong to you"),
      );
    });

    it("should throw UnauthorizedException if current session is already revoked", async () => {
      const current = await service.create(mockUser);
      await service.revoke(current.sessionId);

      await expect(
        service.revokeAllOtherSessions(mockUser.id, current.sessionId),
      ).rejects.toThrow(
        new UnauthorizedException(
          "Cannot use an already-revoked session to revoke others",
        ),
      );
    });

    it("should not affect sessions of other users", async () => {
      const userCurrent = await service.create(mockUser);
      const userOther = await service.create(mockUser);
      const otherUserSession = await service.create(otherUser);

      await service.revokeAllOtherSessions(mockUser.id, userCurrent.sessionId);

      // Other user's session should remain active
      const identity = await service.validate(otherUserSession.token);
      expect(identity.userId).toBe(otherUser.id);
    });

    it("should handle race: only revoke sessions that are still active", async () => {
      const current = await service.create(mockUser);
      const other1 = await service.create(mockUser);
      const other2 = await service.create(mockUser);

      // Manually revoke one before the bulk operation
      await service.revoke(other1.sessionId);

      const count = await service.revokeAllOtherSessions(
        mockUser.id,
        current.sessionId,
      );

      // Should only revoke other2 (other1 was already revoked)
      expect(count).toBe(1);
    });

    it("should prevent user from revoking all sessions for other user", async () => {
      const userSession = await service.create(mockUser);
      const otherSession = await service.create(otherUser);

      await expect(
        service.revokeAllOtherSessions(otherUser.id, userSession.sessionId),
      ).rejects.toThrow();
    });

    it("should protect current session from accidental bulk revocation", async () => {
      const s1 = await service.create(mockUser);
      const s2 = await service.create(mockUser);

      // Attempt to revoke all others using s1's ID
      await service.revokeAllOtherSessions(mockUser.id, s1.sessionId);

      // s1 should remain valid and usable
      const identity = await service.validate(s1.token);
      expect(identity.sessionId).toBe(s1.sessionId);
    });
  });

  // ============================================================================
  // Boundary and Regression Tests
  // ============================================================================

  describe("Boundary and Regression Tests", () => {
    it("should handle empty string session IDs gracefully", async () => {
      await expect(
        service.revokeOtherSession("", mockUser.id),
      ).rejects.toThrow();
    });

    it("should handle concurrent revocation attempts on same session", async () => {
      const session = await service.create(mockUser);

      // Attempt concurrent revocations
      const result = await Promise.allSettled([
        service.revokeOtherSession(session.sessionId, mockUser.id),
        service.revokeOtherSession(session.sessionId, mockUser.id),
      ]);

      // One should succeed, one should fail
      expect(result).toHaveLength(2);
      const fulfilled = result.filter((r) => r.status === "fulfilled");
      const rejected = result.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    });

    it("should handle many concurrent sessions correctly", async () => {
      // Create 10 sessions
      const sessions = await Promise.all(
        Array(10)
          .fill(null)
          .map(() => service.create(mockUser)),
      );

      // Revoke all but the first via bulk operation
      const count = await service.revokeAllOtherSessions(
        mockUser.id,
        sessions[0].sessionId,
      );

      expect(count).toBe(9);

      // Verify correct sessions revoked
      const remaining = await service.getSessions(mockUser.id);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(sessions[0].sessionId);
    });

    it("should maintain consistency: inventory excludes all revoked sessions", async () => {
      const s1 = await service.create(mockUser);
      const s2 = await service.create(mockUser);
      const s3 = await service.create(mockUser);

      // Revoke s1
      await service.revokeOtherSession(s1.sessionId, mockUser.id);

      // Revoke all others via s2
      await service.revokeAllOtherSessions(mockUser.id, s2.sessionId);

      // Only s2 should remain
      const sessions = await service.getSessions(mockUser.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(s2.sessionId);
    });

    it("should allow immediate revocation after creation (race)", async () => {
      const session = await service.create(mockUser);

      // Immediately revoke without delay
      const revokedId = await service.revokeOtherSession(
        session.sessionId,
        mockUser.id,
      );

      expect(revokedId).toBe(session.sessionId);

      // Verify revocation took effect
      const sessions = await service.getSessions(mockUser.id);
      expect(sessions).toHaveLength(0);
    });

    it("should track expiry independently from revocation", async () => {
      const session = await service.create(mockUser);

      // Advance time past expiry
      clock.setNowMs(session.expiresAt.getTime() + 1000);

      // Revoke should still work (checks DB, not expiry)
      const revokedId = await service.revokeOtherSession(
        session.sessionId,
        mockUser.id,
      );
      expect(revokedId).toBe(session.sessionId);

      // But validation should fail on expired session
      await expect(service.validate(session.token)).rejects.toThrow(
        "Session has expired",
      );
    });
  });
});

// ============================================================================
// Test Utilities
// ============================================================================

function mockConfigService() {
  return {
    getOrThrow: (key: string) => {
      if (key === "sessionSecret") {
        return "test-session-secret-12345";
      }
      throw new Error(`Unknown config: ${key}`);
    },
  };
}
