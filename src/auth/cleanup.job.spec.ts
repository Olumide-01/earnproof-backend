import { ConfigService } from "@nestjs/config";
import { AuthAuditService } from "./auth-audit.service";
import { CleanupJob } from "./cleanup.job";
import { SessionService } from "./session.service";

describe("CleanupJob", () => {
  function makePrismaMock() {
    return {
      walletChallenge: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      walletRotation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
  }

  const config = {
    get: (key: string) => {
      const defaults: Record<string, number> = {
        "auth.challengeRetentionDays": 7,
        "auth.auditRetentionDays": 90,
      };
      return defaults[key];
    },
  } as ConfigService;

  it("deletes expired sessions when the scheduled task runs", async () => {
    const prisma = makePrismaMock();
    const sessionService = {
      deleteExpired: jest.fn().mockResolvedValue(3),
    } as unknown as SessionService;
    const auditService = {
      cleanupOldEvents: jest.fn().mockResolvedValue(0),
    } as unknown as AuthAuditService;
    const job = new CleanupJob(sessionService, auditService, prisma as never, config);

    await job.deleteExpiredSessions();

    expect(sessionService.deleteExpired).toHaveBeenCalledTimes(1);
  });

  it("deletes old challenges in two phases", async () => {
    const prisma = makePrismaMock();
    prisma.walletChallenge.deleteMany
      .mockResolvedValueOnce({ count: 10 }) // Expired
      .mockResolvedValueOnce({ count: 5 }); // Old used

    const sessionService = {
      deleteExpired: jest.fn().mockResolvedValue(0),
    } as unknown as SessionService;
    const auditService = {
      cleanupOldEvents: jest.fn().mockResolvedValue(0),
    } as unknown as AuthAuditService;

    const job = new CleanupJob(sessionService, auditService, prisma as never, config);

    await job.deleteOldChallenges();

    expect(prisma.walletChallenge.deleteMany).toHaveBeenCalledTimes(2);
  });

  it("deletes old audit events with configured retention", async () => {
    const prisma = makePrismaMock();
    const sessionService = {
      deleteExpired: jest.fn().mockResolvedValue(0),
    } as unknown as SessionService;
    const auditService = {
      cleanupOldEvents: jest.fn().mockResolvedValue(150),
    } as unknown as AuthAuditService;

    const job = new CleanupJob(sessionService, auditService, prisma as never, config);

    await job.deleteOldAuditEvents();

    expect(auditService.cleanupOldEvents).toHaveBeenCalledWith(90);
  });

  it("deletes wallet rotations whose deadline passed before the retention window", async () => {
    const prisma = makePrismaMock();
    prisma.walletRotation.deleteMany.mockResolvedValue({ count: 4 });
    const job = new CleanupJob({} as never, {} as never, prisma as never, config);
    const now = new Date("2030-01-08T00:00:00.000Z");

    await expect(job.cleanupWalletRotations(now)).resolves.toBe(4);

    expect(prisma.walletRotation.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: new Date("2030-01-01T00:00:00.000Z") } },
    });
  });

  it("reports zero instead of throwing when rotation cleanup fails", async () => {
    const prisma = makePrismaMock();
    prisma.walletRotation.deleteMany.mockRejectedValue(new Error("db down"));
    const job = new CleanupJob({} as never, {} as never, prisma as never, config);

    await expect(job.cleanupWalletRotations()).resolves.toBe(0);
  });
});
