import { ProofStatus, ReminderDeliveryStatus } from "@prisma/client";
import { NotificationsService } from "../notifications/notifications.service";
import { ProofExpirationReminderService } from "./proof-expiration-reminder.service";

describe("ProofExpirationReminderService", () => {
  let service: ProofExpirationReminderService;
  let prismaMock: any;
  let notificationsServiceMock: any;

  beforeEach(() => {
    prismaMock = {
      proofExpirationReminderPreference: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      proofExpirationReminderDelivery: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      proof: {
        findUnique: jest.fn(),
      },
    };

    notificationsServiceMock = {
      emitProofExpirationNotification: jest.fn().mockImplementation((proofId, targetDate, leadHours) => ({
        notificationId: "notif_1",
        type: "PROOF_EXPIRATION_REMINDER",
        proofId,
        targetExpirationDate: targetDate.toISOString(),
        leadWindowHours: leadHours,
        message: "Your proof will expire soon",
        emittedAt: new Date().toISOString(),
      })),
    };

    service = new ProofExpirationReminderService(
      prismaMock as any,
      notificationsServiceMock as NotificationsService,
    );
  });

  describe("scheduleRemindersForProof", () => {
    it("schedules deduplicated deliveries for each configured window", async () => {
      const now = new Date("2026-10-16T12:00:00Z");
      jest.useFakeTimers();
      jest.setSystemTime(now);

      const expiresAt = new Date("2026-10-26T12:00:00Z"); // 10 days later
      prismaMock.proofExpirationReminderPreference.findUnique.mockResolvedValueOnce({
        enabled: true,
        leadTimeHours: [24, 72, 168], // 1d, 3d, 7d
      });

      const count = await service.scheduleRemindersForProof({
        id: "proof_1",
        userId: "user_1",
        expiresAt,
        status: ProofStatus.ACTIVE,
      });

      expect(count).toBe(3);
      expect(prismaMock.proofExpirationReminderDelivery.upsert).toHaveBeenCalledTimes(3);

      // Verify each upsert has the unique constraint proofId_windowHours
      expect(prismaMock.proofExpirationReminderDelivery.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            proofId_windowHours: {
              proofId: "proof_1",
              windowHours: 24,
            },
          },
        }),
      );

      jest.useRealTimers();
    });

    it("does not schedule reminders if proof is not ACTIVE", async () => {
      const count = await service.scheduleRemindersForProof({
        id: "proof_1",
        userId: "user_1",
        expiresAt: new Date(Date.now() + 864000000),
        status: ProofStatus.REVOKED,
      });

      expect(count).toBe(0);
      expect(prismaMock.proofExpirationReminderDelivery.upsert).not.toHaveBeenCalled();
    });

    it("does not schedule reminders if user opted out", async () => {
      prismaMock.proofExpirationReminderPreference.findUnique.mockResolvedValueOnce({
        enabled: false,
        leadTimeHours: [24, 72],
      });

      const count = await service.scheduleRemindersForProof({
        id: "proof_1",
        userId: "user_1",
        expiresAt: new Date(Date.now() + 864000000),
        status: ProofStatus.ACTIVE,
      });

      expect(count).toBe(0);
      expect(prismaMock.proofExpirationReminderDelivery.upsert).not.toHaveBeenCalled();
    });
  });

  describe("cancelRemindersForProof", () => {
    it("deterministically cancels all pending and enqueued reminders when proof transitions status", async () => {
      prismaMock.proofExpirationReminderDelivery.updateMany.mockResolvedValueOnce({ count: 2 });

      const count = await service.cancelRemindersForProof("proof_1", "Proof revoked by issuer");

      expect(count).toBe(2);
      expect(prismaMock.proofExpirationReminderDelivery.updateMany).toHaveBeenCalledWith({
        where: {
          proofId: "proof_1",
          status: { in: [ReminderDeliveryStatus.SCHEDULED, ReminderDeliveryStatus.ENQUEUED] },
        },
        data: expect.objectContaining({
          status: ReminderDeliveryStatus.CANCELLED,
          cancellationReason: "Proof revoked by issuer",
        }),
      });
    });
  });

  describe("processScheduledReminders", () => {
    it("re-evaluates proof state immediately before delivery and cancels if proof is REVOKED or EXPIRED", async () => {
      const asOf = new Date("2026-10-16T12:00:00Z");

      prismaMock.proofExpirationReminderDelivery.findMany.mockResolvedValueOnce([
        {
          id: "del_1",
          proofId: "proof_revoked",
          windowHours: 24,
          targetDate: new Date("2026-10-17T12:00:00Z"),
          proof: {
            id: "proof_revoked",
            status: ProofStatus.REVOKED,
            expiresAt: new Date("2026-10-17T12:00:00Z"),
          },
          user: {
            id: "u1",
            proofExpirationReminderPreference: { enabled: true },
          },
        },
        {
          id: "del_2",
          proofId: "proof_expired",
          windowHours: 24,
          targetDate: new Date("2026-10-15T12:00:00Z"), // in past
          proof: {
            id: "proof_expired",
            status: ProofStatus.ACTIVE,
            expiresAt: new Date("2026-10-15T12:00:00Z"),
          },
          user: {
            id: "u2",
            proofExpirationReminderPreference: { enabled: true },
          },
        },
      ]);

      const result = await service.processScheduledReminders(asOf);

      expect(result.processed).toBe(2);
      expect(result.delivered).toBe(0);
      expect(result.cancelled).toBe(2);

      // Verify delivery 1 was cancelled due to revoked status
      expect(prismaMock.proofExpirationReminderDelivery.update).toHaveBeenCalledWith({
        where: { id: "del_1" },
        data: expect.objectContaining({
          status: ReminderDeliveryStatus.CANCELLED,
          cancellationReason: "Proof state transitioned to REVOKED",
        }),
      });

      // Verify delivery 2 was cancelled due to expiration passed
      expect(prismaMock.proofExpirationReminderDelivery.update).toHaveBeenCalledWith({
        where: { id: "del_2" },
        data: expect.objectContaining({
          status: ReminderDeliveryStatus.CANCELLED,
          cancellationReason: "Proof has already reached or passed expiration timestamp",
        }),
      });

      expect(notificationsServiceMock.emitProofExpirationNotification).not.toHaveBeenCalled();
    });

    it("cancels delivery if user has opted out prior to delivery", async () => {
      const asOf = new Date("2026-10-16T12:00:00Z");

      prismaMock.proofExpirationReminderDelivery.findMany.mockResolvedValueOnce([
        {
          id: "del_optout",
          proofId: "proof_active",
          windowHours: 24,
          targetDate: new Date("2026-10-17T12:00:00Z"),
          proof: {
            id: "proof_active",
            status: ProofStatus.ACTIVE,
            expiresAt: new Date("2026-10-17T12:00:00Z"),
          },
          user: {
            id: "u_optout",
            proofExpirationReminderPreference: { enabled: false, optedOutAt: new Date() },
          },
        },
      ]);

      const result = await service.processScheduledReminders(asOf);

      expect(result.delivered).toBe(0);
      expect(result.cancelled).toBe(1);
      expect(prismaMock.proofExpirationReminderDelivery.update).toHaveBeenCalledWith({
        where: { id: "del_optout" },
        data: expect.objectContaining({
          status: ReminderDeliveryStatus.CANCELLED,
          cancellationReason: "User opted out of reminders",
        }),
      });
    });

    it("delivers privacy-safe notification without any claim values or amounts", async () => {
      const asOf = new Date("2026-10-16T12:00:00Z");

      prismaMock.proofExpirationReminderDelivery.findMany.mockResolvedValueOnce([
        {
          id: "del_ok",
          proofId: "proof_valid",
          windowHours: 24,
          targetDate: new Date("2026-10-17T12:00:00Z"),
          proof: {
            id: "proof_valid",
            status: ProofStatus.ACTIVE,
            expiresAt: new Date("2026-10-17T12:00:00Z"),
          },
          user: {
            id: "u_ok",
            proofExpirationReminderPreference: { enabled: true, optedOutAt: null },
          },
        },
      ]);

      const result = await service.processScheduledReminders(asOf);

      expect(result.delivered).toBe(1);
      expect(result.cancelled).toBe(0);
      expect(notificationsServiceMock.emitProofExpirationNotification).toHaveBeenCalledWith(
        "proof_valid",
        new Date("2026-10-17T12:00:00Z"),
        24,
      );

      // Verify recorded notification metadata does not have amounts or claim values
      const updateCall = prismaMock.proofExpirationReminderDelivery.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe(ReminderDeliveryStatus.DELIVERED);
      expect(updateCall.data.notificationRecord).not.toHaveProperty("amount");
      expect(updateCall.data.notificationRecord).not.toHaveProperty("claim");
    });

    it("correctly handles timezone boundaries using UTC timestamps", async () => {
      // Simulate proof expiring at midnight UTC
      const expiresAt = new Date("2026-10-20T00:00:00.000Z");
      // 24 hours before in UTC is 2026-10-19T00:00:00.000Z
      const scheduledFor = new Date("2026-10-19T00:00:00.000Z");

      prismaMock.proofExpirationReminderDelivery.findMany.mockResolvedValueOnce([
        {
          id: "del_tz",
          proofId: "proof_tz",
          windowHours: 24,
          targetDate: expiresAt,
          proof: {
            id: "proof_tz",
            status: ProofStatus.ACTIVE,
            expiresAt,
          },
          user: {
            id: "u_tz",
            proofExpirationReminderPreference: { enabled: true },
          },
        },
      ]);

      // Query exactly at scheduled time
      const result = await service.processScheduledReminders(scheduledFor);
      expect(result.delivered).toBe(1);
      expect(notificationsServiceMock.emitProofExpirationNotification).toHaveBeenCalledWith(
        "proof_tz",
        expiresAt,
        24,
      );
    });
  });
});
