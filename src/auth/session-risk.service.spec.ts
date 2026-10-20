import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SessionRiskSeverity, SessionRiskType } from "@prisma/client";
import { SessionRiskService } from "./session-risk.service";

describe("SessionRiskService", () => {
  let service: SessionRiskService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      sessionRiskEvent: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      authSession: {
        updateMany: jest.fn(),
      },
      recentAuthAssertion: {
        findMany: jest.fn(),
      },
    };
    service = new SessionRiskService(prisma);
  });

  describe("recordRiskEvent", () => {
    it("persists a risk event with sanitized signals (no raw IP or fingerprint)", async () => {
      const now = new Date();
      prisma.sessionRiskEvent.create.mockImplementation(({ data }: any) => ({
        id: "risk_1",
        ...data,
        resolvedAt: null,
        createdAt: now,
      }));

      const result = await service.recordRiskEvent("user_1", {
        sessionId: "sess_1",
        riskType: SessionRiskType.REPLAY_SUSPECTED,
        signals: {
          ip: "192.168.1.1",
          deviceFingerprint: "sha256:abc",
          token: "secret_token",
          reason: "Rapid challenge consumption",
          originDomain: "https://app.earnproof.io",
        },
      });

      expect(result.id).toBe("risk_1");
      expect(result.severity).toBe(SessionRiskSeverity.CRITICAL);
      expect(result.signals).toEqual({
        reason: "Rapid challenge consumption",
        originDomain: "https://app.earnproof.io",
      });
      expect(result.signals).not.toHaveProperty("ip");
      expect(result.signals).not.toHaveProperty("deviceFingerprint");
      expect(result.signals).not.toHaveProperty("token");

      expect(prisma.sessionRiskEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user_1",
          sessionId: "sess_1",
          riskType: SessionRiskType.REPLAY_SUSPECTED,
          severity: SessionRiskSeverity.CRITICAL,
          retainUntil: expect.any(Date),
        }),
      });
    });

    it("assigns appropriate default severity based on risk type", async () => {
      prisma.sessionRiskEvent.create.mockImplementation(({ data }: any) => ({
        id: "risk_2",
        ...data,
        resolvedAt: null,
        createdAt: new Date(),
      }));

      const res1 = await service.recordRiskEvent("user_1", {
        riskType: SessionRiskType.ORIGIN_ANOMALY,
      });
      expect(res1.severity).toBe(SessionRiskSeverity.MEDIUM);

      const res2 = await service.recordRiskEvent("user_1", {
        riskType: SessionRiskType.UNRECOGNIZED_DEVICE,
      });
      expect(res2.severity).toBe(SessionRiskSeverity.LOW);
    });
  });

  describe("listRiskEvents", () => {
    it("lists events scoped to user with pagination", async () => {
      const mockEvents = [
        {
          id: "risk_1",
          userId: "user_1",
          sessionId: "sess_1",
          riskType: SessionRiskType.ORIGIN_ANOMALY,
          severity: SessionRiskSeverity.MEDIUM,
          signals: { origin: "https://unknown.com" },
          resolvedAt: null,
          createdAt: new Date("2026-10-01T00:00:00Z"),
        },
      ];
      prisma.sessionRiskEvent.findMany.mockResolvedValue(mockEvents);

      const result = await service.listRiskEvents("user_1", { limit: 10 });
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe("risk_1");
      expect(result.nextCursor).toBeUndefined();

      expect(prisma.sessionRiskEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user_1" },
          take: 11,
        }),
      );
    });
  });

  describe("revokeRelatedSessions", () => {
    it("revokes linked session for specific risk event", async () => {
      prisma.sessionRiskEvent.findUnique.mockResolvedValue({
        id: "risk_1",
        userId: "user_1",
        sessionId: "sess_flagged",
        riskType: SessionRiskType.WALLET_MISMATCH,
      });
      prisma.authSession.updateMany.mockResolvedValue({ count: 1 });
      prisma.sessionRiskEvent.update.mockResolvedValue({});

      const result = await service.revokeRelatedSessions("user_1", "risk_1");
      expect(result.revokedCount).toBe(1);
      expect(result.affectedSessionId).toBe("sess_flagged");

      expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
        where: {
          id: "sess_flagged",
          userId: "user_1",
          revokedAt: null,
        },
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          revocationReason: "RISK_EVENT_WALLET_MISMATCH",
        }),
      });
      expect(prisma.sessionRiskEvent.update).toHaveBeenCalledWith({
        where: { id: "risk_1" },
        data: { resolvedAt: expect.any(Date) },
      });
    });

    it("revokes all active sessions when no specific sessionId is linked", async () => {
      prisma.sessionRiskEvent.findUnique.mockResolvedValue({
        id: "risk_2",
        userId: "user_1",
        sessionId: null,
        riskType: SessionRiskType.REPLAY_SUSPECTED,
      });
      prisma.authSession.updateMany.mockResolvedValue({ count: 3 });
      prisma.sessionRiskEvent.update.mockResolvedValue({});

      const result = await service.revokeRelatedSessions("user_1", "risk_2");
      expect(result.revokedCount).toBe(3);
      expect(result.affectedSessionId).toBeUndefined();

      expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
        where: {
          userId: "user_1",
          revokedAt: null,
        },
        data: expect.objectContaining({
          revocationReason: "RISK_EVENT_REPLAY_SUSPECTED_ALL",
        }),
      });
    });

    it("fails with NotFoundException if risk event does not exist", async () => {
      prisma.sessionRiskEvent.findUnique.mockResolvedValue(null);

      await expect(
        service.revokeRelatedSessions("user_1", "risk_unknown"),
      ).rejects.toThrow(NotFoundException);
    });

    it("enforces tenant/user isolation: rejects if event belongs to another user", async () => {
      prisma.sessionRiskEvent.findUnique.mockResolvedValue({
        id: "risk_other",
        userId: "user_other",
        sessionId: "sess_other",
      });

      await expect(
        service.revokeRelatedSessions("user_1", "risk_other"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("getReauthenticationHistory", () => {
    it("returns user-scoped assertions without sensitive tokens", async () => {
      const now = new Date();
      prisma.recentAuthAssertion.findMany.mockResolvedValue([
        {
          id: "assert_1",
          action: "org:delete",
          resourceId: "org_123",
          network: "testnet",
          createdAt: now,
          expiresAt: new Date(now.getTime() + 300000),
          usedAt: now,
        },
      ]);

      const result = await service.getReauthenticationHistory("user_1");
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: "assert_1",
        action: "org:delete",
        resourceId: "org_123",
        network: "testnet",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 300000).toISOString(),
        usedAt: now.toISOString(),
      });
      expect(result.data[0]).not.toHaveProperty("token");
      expect(result.data[0]).not.toHaveProperty("tokenHash");
    });
  });
});
