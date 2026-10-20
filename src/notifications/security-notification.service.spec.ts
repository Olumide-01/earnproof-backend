import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  ResourceStatus,
  SecurityNotificationSeverity,
  SecurityNotificationType,
} from "@prisma/client";
import { SecurityNotificationService } from "./security-notification.service";

describe("SecurityNotificationService", () => {
  let service: SecurityNotificationService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      organization: {
        findUnique: jest.fn(),
      },
      organizationMember: {
        findUnique: jest.fn(),
      },
      securityNotification: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
    };

    service = new SecurityNotificationService(prisma);
  });

  describe("createNotification", () => {
    it("creates an inbox notification with sensitive data redacted and retention set", async () => {
      prisma.organization.findUnique.mockResolvedValue({
        id: "org_1",
        status: ResourceStatus.ACTIVE,
      });

      const now = new Date();
      prisma.securityNotification.create.mockImplementation(({ data }: any) => ({
        id: "notif_1",
        ...data,
        createdAt: now,
        updatedAt: now,
        acknowledgedAt: null,
        acknowledgedById: null,
      }));

      const res = await service.createNotification("org_1", {
        type: SecurityNotificationType.SUSPICIOUS_LOGIN,
        severity: SecurityNotificationSeverity.HIGH,
        title: "Suspicious login anomaly",
        summary: "Login from unrecognized origin",
        data: {
          token: "super-secret-token",
          signingKey: "raw-private-key",
          browser: "Chrome",
          origin: "https://unknown.com",
        },
        resolutionUrl: "https://app.earnproof.io/security/incidents/1",
      });

      expect(res.id).toBe("notif_1");
      expect(res.data).toEqual({
        token: "[REDACTED]",
        signingKey: "[REDACTED]",
        browser: "Chrome",
        origin: "https://unknown.com",
      });
      expect(res.acknowledged).toBe(false);

      expect(prisma.securityNotification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: "org_1",
          type: SecurityNotificationType.SUSPICIOUS_LOGIN,
          severity: SecurityNotificationSeverity.HIGH,
          retainUntil: expect.any(Date),
        }),
      });
    });
  });

  describe("listNotifications", () => {
    it("lists notifications enforcing membership and user visibility", async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ id: "m_1" });

      const now = new Date();
      prisma.securityNotification.findMany.mockResolvedValue([
        {
          id: "notif_tenant",
          organizationId: "org_1",
          userId: null, // Tenant-wide
          type: SecurityNotificationType.CIRCUIT_BREAKER_TRIPPED,
          severity: SecurityNotificationSeverity.WARNING,
          title: "Circuit Breaker Tripped",
          summary: "Webhook circuit opened",
          data: {},
          acknowledgedAt: null,
          acknowledgedById: null,
          resolutionUrl: null,
          createdAt: now,
        },
      ]);

      const res = await service.listNotifications("org_1", "user_1", { limit: 10 });

      expect(res.data).toHaveLength(1);
      expect(res.data[0].id).toBe("notif_tenant");
      expect(prisma.securityNotification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: "org_1",
            OR: [{ userId: null }, { userId: "user_1" }],
          }),
        }),
      );
    });

    it("rejects non-members with ForbiddenException", async () => {
      prisma.organizationMember.findUnique.mockResolvedValue(null);

      await expect(
        service.listNotifications("org_1", "unauthorized_user"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("getUnreadCount", () => {
    it("returns unread count visible to user", async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ id: "m_1" });
      prisma.securityNotification.count.mockResolvedValue(4);

      const res = await service.getUnreadCount("org_1", "user_1");
      expect(res.unreadCount).toBe(4);
      expect(prisma.securityNotification.count).toHaveBeenCalledWith({
        where: {
          organizationId: "org_1",
          acknowledgedAt: null,
          OR: [{ userId: null }, { userId: "user_1" }],
        },
      });
    });
  });

  describe("acknowledgeNotification", () => {
    it("acknowledges an unacknowledged notification", async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ id: "m_1" });
      prisma.securityNotification.findUnique.mockResolvedValue({
        id: "notif_1",
        organizationId: "org_1",
        userId: null,
        acknowledgedAt: null,
        acknowledgedById: null,
      });

      const now = new Date();
      prisma.securityNotification.update.mockResolvedValue({
        id: "notif_1",
        acknowledgedAt: now,
        acknowledgedById: "user_1",
      });

      const res = await service.acknowledgeNotification("org_1", "notif_1", "user_1");
      expect(res.acknowledged).toBe(true);
      expect(res.acknowledgedById).toBe("user_1");
      expect(prisma.securityNotification.update).toHaveBeenCalledWith({
        where: { id: "notif_1" },
        data: expect.objectContaining({
          acknowledgedAt: expect.any(Date),
          acknowledgedById: "user_1",
        }),
      });
    });

    it("is idempotent: does not re-acknowledge or overwrite timestamp if already acknowledged", async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ id: "m_1" });
      const previousDate = new Date("2026-10-01T12:00:00Z");
      prisma.securityNotification.findUnique.mockResolvedValue({
        id: "notif_1",
        organizationId: "org_1",
        userId: null,
        acknowledgedAt: previousDate,
        acknowledgedById: "original_user",
      });

      const res = await service.acknowledgeNotification("org_1", "notif_1", "user_2");
      expect(res.acknowledged).toBe(true);
      expect(res.acknowledgedAt).toBe(previousDate.toISOString());
      expect(res.acknowledgedById).toBe("original_user");
      expect(prisma.securityNotification.update).not.toHaveBeenCalled();
    });

    it("throws NotFoundException if notification does not exist or belongs to another org", async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ id: "m_1" });
      prisma.securityNotification.findUnique.mockResolvedValue({
        id: "notif_other",
        organizationId: "other_org",
      });

      await expect(
        service.acknowledgeNotification("org_1", "notif_other", "user_1"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getResolutionLink", () => {
    it("returns resolution url for notification", async () => {
      prisma.organizationMember.findUnique.mockResolvedValue({ id: "m_1" });
      prisma.securityNotification.findUnique.mockResolvedValue({
        id: "notif_1",
        organizationId: "org_1",
        userId: null,
        resolutionUrl: "https://app.earnproof.io/fix-key",
        data: {},
        createdAt: new Date(),
        acknowledgedAt: null,
        acknowledgedById: null,
      });

      const res = await service.getResolutionLink("org_1", "notif_1", "user_1");
      expect(res.resolutionUrl).toBe("https://app.earnproof.io/fix-key");
    });
  });
});
