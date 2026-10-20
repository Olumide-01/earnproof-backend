import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DESTRUCTIVE_ACTIONS, RecentAuthService } from "./recent-auth.service";

function buildConfig(): ConfigService {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === "sessionSecret") return "test-secret-32-chars-minimum!!";
      throw new Error(`Unknown key: ${key}`);
    }),
    get: jest.fn((key: string) => {
      if (key === "stellar.networkPassphrase") return "Test SDF Network ; September 2015";
      return undefined;
    }),
  } as unknown as ConfigService;
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    recentAuthAssertion: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ userId: "user_1", resourceId: "res_1" }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    ...overrides,
  };
}

describe("RecentAuthService", () => {
  let service: RecentAuthService;
  let prisma: ReturnType<typeof buildPrisma>;

  beforeEach(() => {
    prisma = buildPrisma();
    service = new RecentAuthService(prisma as never, buildConfig());
  });

  // ── issue ──────────────────────────────────────────────────────────────────

  describe("issue()", () => {
    it("creates a DB row and returns a token + expiresAt", async () => {
      const { token, expiresAt } = await service.issue(
        "user_1", DESTRUCTIVE_ACTIONS.KEY_REVOKE, "key_abc", "https://app.test"
      );
      expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(prisma.recentAuthAssertion.create).toHaveBeenCalledTimes(1);
    });

    it("stores a hash of the token, never the raw token", async () => {
      const { token } = await service.issue(
        "user_1", DESTRUCTIVE_ACTIONS.KEY_REVOKE, "key_abc", "https://app.test"
      );
      const call = (prisma.recentAuthAssertion.create as jest.Mock).mock.calls[0][0] as {
        data: { tokenHash: string };
      };
      expect(call.data.tokenHash).not.toBe(token);
      expect(call.data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("stores the origin hash, not the raw origin", async () => {
      const rawOrigin = "https://app.earnproof.test";
      await service.issue("user_1", DESTRUCTIVE_ACTIONS.KEY_REVOKE, "key_abc", rawOrigin);
      const call = (prisma.recentAuthAssertion.create as jest.Mock).mock.calls[0][0] as {
        data: { originHash: string; network: string };
      };
      expect(call.data.originHash).not.toBe(rawOrigin);
      expect(call.data.originHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("binds the assertion to the Stellar network passphrase", async () => {
      await service.issue("user_1", DESTRUCTIVE_ACTIONS.KEY_REVOKE, "res", "origin");
      const call = (prisma.recentAuthAssertion.create as jest.Mock).mock.calls[0][0] as {
        data: { network: string };
      };
      expect(call.data.network).toBe("Test SDF Network ; September 2015");
    });

    it("generates unique tokens across calls", async () => {
      const t1 = await service.issue("user_1", DESTRUCTIVE_ACTIONS.KEY_REVOKE, "r", "o");
      const t2 = await service.issue("user_1", DESTRUCTIVE_ACTIONS.KEY_REVOKE, "r", "o");
      expect(t1.token).not.toBe(t2.token);
    });
  });

  // ── verify ─────────────────────────────────────────────────────────────────

  describe("verify()", () => {
    it("returns userId and resourceId for a valid assertion", async () => {
      const result = await service.verify({
        token: "sometoken",
        action: DESTRUCTIVE_ACTIONS.KEY_REVOKE,
        origin: "https://app.test",
      });
      expect(result.userId).toBe("user_1");
      expect(result.resourceId).toBe("res_1");
    });

    it("throws 401 when token is empty", async () => {
      await expect(
        service.verify({ token: "", action: DESTRUCTIVE_ACTIONS.KEY_REVOKE, origin: "o" })
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("throws 401 when no matching assertion exists", async () => {
      prisma.recentAuthAssertion.findFirst = jest.fn().mockResolvedValue(null);
      await expect(
        service.verify({ token: "bad", action: DESTRUCTIVE_ACTIONS.KEY_REVOKE, origin: "o" })
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("normal session bearer token cannot substitute — throws without DB row", async () => {
      // A bearer token (wrong format) would yield no DB row for that hash
      prisma.recentAuthAssertion.findFirst = jest.fn().mockResolvedValue(null);
      await expect(
        service.verify({ token: "Bearer session.token", action: DESTRUCTIVE_ACTIONS.ORG_DELETE, origin: "o" })
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  // ── consume ────────────────────────────────────────────────────────────────

  describe("consume()", () => {
    it("marks assertion as used and returns userId", async () => {
      const result = await service.consume({
        token: "sometoken",
        action: DESTRUCTIVE_ACTIONS.KEY_REVOKE,
        resourceId: "res_1",
        origin: "https://app.test",
      });
      expect(result.userId).toBe("user_1");
      expect(prisma.recentAuthAssertion.updateMany).toHaveBeenCalledTimes(1);
    });

    it("throws 401 on replay (0 rows updated)", async () => {
      prisma.recentAuthAssertion.updateMany = jest.fn().mockResolvedValue({ count: 0 });
      prisma.recentAuthAssertion.findFirst = jest.fn().mockResolvedValue({
        usedAt: new Date(), expiresAt: new Date(Date.now() + 60000), action: DESTRUCTIVE_ACTIONS.KEY_REVOKE
      });
      await expect(
        service.consume({
          token: "replay-token",
          action: DESTRUCTIVE_ACTIONS.KEY_REVOKE,
          resourceId: "res_1",
          origin: "https://app.test",
        })
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("throws 401 on expired assertion", async () => {
      prisma.recentAuthAssertion.updateMany = jest.fn().mockResolvedValue({ count: 0 });
      prisma.recentAuthAssertion.findFirst = jest.fn().mockResolvedValue({
        usedAt: null, expiresAt: new Date(Date.now() - 1000), action: DESTRUCTIVE_ACTIONS.KEY_REVOKE
      });
      await expect(
        service.consume({
          token: "expired-token",
          action: DESTRUCTIVE_ACTIONS.KEY_REVOKE,
          resourceId: "res_1",
          origin: "o",
        })
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("throws 401 on wrong action", async () => {
      prisma.recentAuthAssertion.updateMany = jest.fn().mockResolvedValue({ count: 0 });
      prisma.recentAuthAssertion.findFirst = jest.fn().mockResolvedValue({
        usedAt: null, expiresAt: new Date(Date.now() + 60000), action: DESTRUCTIVE_ACTIONS.ORG_DELETE
      });
      await expect(
        service.consume({
          token: "token",
          action: DESTRUCTIVE_ACTIONS.KEY_REVOKE,
          resourceId: "res_1",
          origin: "o",
        })
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("failed operations do not broaden scope — consume is atomic", async () => {
      // consume() uses updateMany WHERE action=X,resourceId=Y,usedAt=null
      // so a wrong resourceId produces 0 rows updated
      prisma.recentAuthAssertion.updateMany = jest.fn().mockResolvedValue({ count: 0 });
      prisma.recentAuthAssertion.findFirst = jest.fn().mockResolvedValue(null);
      await expect(
        service.consume({
          token: "token",
          action: DESTRUCTIVE_ACTIONS.KEY_REVOKE,
          resourceId: "different-resource",
          origin: "o",
        })
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // Only one updateMany call — no broadened scope
      expect(prisma.recentAuthAssertion.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  // ── action binding ─────────────────────────────────────────────────────────

  describe("action binding", () => {
    it("DESTRUCTIVE_ACTIONS contains all required actions", () => {
      expect(DESTRUCTIVE_ACTIONS.ORG_DELETE).toBe("org:delete");
      expect(DESTRUCTIVE_ACTIONS.ISSUER_REVOKE).toBe("issuer:revoke");
      expect(DESTRUCTIVE_ACTIONS.KEY_REVOKE).toBe("key:revoke");
      expect(DESTRUCTIVE_ACTIONS.SESSION_REVOKE_ALL).toBe("session:revoke_all");
    });

    it("stores the bound action in the DB row", async () => {
      await service.issue("user_1", DESTRUCTIVE_ACTIONS.ORG_DELETE, "*", "origin");
      const call = (prisma.recentAuthAssertion.create as jest.Mock).mock.calls[0][0] as {
        data: { action: string };
      };
      expect(call.data.action).toBe(DESTRUCTIVE_ACTIONS.ORG_DELETE);
    });

    it("updateMany includes action in the WHERE clause", async () => {
      await service.consume({
        token: "t", action: DESTRUCTIVE_ACTIONS.ISSUER_REVOKE, resourceId: "r", origin: "o"
      });
      const call = (prisma.recentAuthAssertion.updateMany as jest.Mock).mock.calls[0][0] as {
        where: { action: string };
      };
      expect(call.where.action).toBe(DESTRUCTIVE_ACTIONS.ISSUER_REVOKE);
    });
  });

  // ── expiry / TTL ───────────────────────────────────────────────────────────

  describe("expiry", () => {
    it("expiresAt is ~5 minutes in the future", async () => {
      const before = Date.now();
      const { expiresAt } = await service.issue("user_1", DESTRUCTIVE_ACTIONS.KEY_REVOKE, "r", "o");
      const diff = expiresAt.getTime() - before;
      expect(diff).toBeGreaterThanOrEqual(4 * 60 * 1000);
      expect(diff).toBeLessThanOrEqual(6 * 60 * 1000);
    });

    it("updateMany WHERE includes expiresAt > now", async () => {
      await service.consume({ token: "t", action: DESTRUCTIVE_ACTIONS.KEY_REVOKE, resourceId: "r", origin: "o" });
      const call = (prisma.recentAuthAssertion.updateMany as jest.Mock).mock.calls[0][0] as {
        where: { expiresAt: { gt: Date } };
      };
      expect(call.where.expiresAt.gt).toBeInstanceOf(Date);
      expect(call.where.expiresAt.gt.getTime()).toBeLessThanOrEqual(Date.now() + 100);
    });
  });

  // ── purgeExpired ───────────────────────────────────────────────────────────

  describe("purgeExpired()", () => {
    it("deletes rows with expiresAt < now", async () => {
      prisma.recentAuthAssertion.deleteMany = jest.fn().mockResolvedValue({ count: 5 });
      const count = await service.purgeExpired();
      expect(count).toBe(5);
      expect(prisma.recentAuthAssertion.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { expiresAt: { lt: expect.any(Date) } } })
      );
    });
  });

  // ── privacy ────────────────────────────────────────────────────────────────

  describe("privacy invariants", () => {
    it("never stores the raw assertion token", async () => {
      const { token } = await service.issue("user_1", DESTRUCTIVE_ACTIONS.KEY_REVOKE, "r", "o");
      const call = (prisma.recentAuthAssertion.create as jest.Mock).mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      const stored = JSON.stringify(call.data);
      expect(stored).not.toContain(token);
    });

    it("never stores the raw origin value", async () => {
      const rawOrigin = "https://sensitive.origin.example.com";
      await service.issue("user_1", DESTRUCTIVE_ACTIONS.KEY_REVOKE, "r", rawOrigin);
      const call = (prisma.recentAuthAssertion.create as jest.Mock).mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      const stored = JSON.stringify(call.data);
      expect(stored).not.toContain(rawOrigin);
    });
  });
});