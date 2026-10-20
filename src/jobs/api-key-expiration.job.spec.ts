import { ResourceStatus } from "@prisma/client";
import { ApiKeyExpirationJob } from "./api-key-expiration.job";
import { Clock } from "../common/time/clock";

class FixedClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return new Date(this.current);
  }
  set(instant: Date): void {
    this.current = new Date(instant);
  }
}

describe("ApiKeyExpirationJob", () => {
  let job: ApiKeyExpirationJob;
  let prismaMock: any;
  let usageServiceMock: any;
  let apiKeyServiceMock: any;
  let clock: FixedClock;

  const baseTime = new Date("2026-10-20T12:00:00Z");

  beforeEach(() => {
    clock = new FixedClock(baseTime);

    prismaMock = {
      apiKey: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: "audit_1" }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ now: baseTime }]),
    };

    usageServiceMock = {
      freezeOnRevocation: jest.fn().mockResolvedValue(undefined),
    };

    apiKeyServiceMock = {
      getDatabaseTime: jest.fn().mockResolvedValue(baseTime),
      invalidateKeyCache: jest.fn(),
    };

    job = new ApiKeyExpirationJob(
      prismaMock,
      usageServiceMock,
      apiKeyServiceMock,
      clock,
    );
  });

  describe("sweep - cleanup & boundary behavior", () => {
    it("sweeps and revokes expired keys at exact expiration boundary", async () => {
      const expiredKey = {
        id: "key_expired_1",
        prefix: "abcd1234",
        name: "Test Expired Key",
        organizationId: "org_1",
        expiresAt: new Date("2026-10-20T12:00:00Z"), // exactly now
      };

      prismaMock.apiKey.findMany.mockResolvedValue([expiredKey]);
      prismaMock.apiKey.updateMany.mockResolvedValue({ count: 1 });

      const count = await job.sweep(baseTime);

      expect(count).toBe(1);
      expect(prismaMock.apiKey.findMany).toHaveBeenCalledWith({
        where: {
          status: ResourceStatus.ACTIVE,
          expiresAt: { lte: baseTime },
        },
        select: {
          id: true,
          prefix: true,
          name: true,
          organizationId: true,
          expiresAt: true,
        },
      });

      expect(prismaMock.apiKey.updateMany).toHaveBeenCalledWith({
        where: {
          id: expiredKey.id,
          status: ResourceStatus.ACTIVE,
        },
        data: {
          status: ResourceStatus.REVOKED,
          revokedAt: baseTime,
        },
      });

      expect(apiKeyServiceMock.invalidateKeyCache).toHaveBeenCalledWith(expiredKey.id);
      expect(usageServiceMock.freezeOnRevocation).toHaveBeenCalledWith(expiredKey.id);
    });

    it("does nothing when no keys have expired", async () => {
      prismaMock.apiKey.findMany.mockResolvedValue([]);

      const count = await job.sweep(baseTime);

      expect(count).toBe(0);
      expect(prismaMock.apiKey.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
      expect(usageServiceMock.freezeOnRevocation).not.toHaveBeenCalled();
    });

    it("is idempotent: sweeping again after revocation finds no candidates", async () => {
      prismaMock.apiKey.findMany.mockResolvedValueOnce([
        {
          id: "key_1",
          prefix: "pref1234",
          name: "K1",
          organizationId: "org_1",
          expiresAt: new Date("2026-10-20T11:00:00Z"),
        },
      ]);
      prismaMock.apiKey.updateMany.mockResolvedValueOnce({ count: 1 });

      const firstRun = await job.sweep(baseTime);
      expect(firstRun).toBe(1);

      // Second run: no active candidates left
      prismaMock.apiKey.findMany.mockResolvedValueOnce([]);
      const secondRun = await job.sweep(baseTime);
      expect(secondRun).toBe(0);
    });
  });

  describe("multi-worker safety", () => {
    it("handles concurrent workers gracefully: only winning worker logs audit and freezes summaries", async () => {
      const candidateKey = {
        id: "key_raced_1",
        prefix: "race1234",
        name: "Raced Key",
        organizationId: "org_race",
        expiresAt: new Date("2026-10-20T11:59:00Z"),
      };

      // Both workers find the candidate
      prismaMock.apiKey.findMany.mockResolvedValue([candidateKey]);

      // Worker 2 attempts updateMany, but worker 1 already transitioned it (count === 0)
      prismaMock.apiKey.updateMany.mockResolvedValue({ count: 0 });

      const count = await job.sweep(baseTime);

      expect(count).toBe(0);
      // Losing worker must not emit duplicate audit log
      expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
      // Losing worker must not re-trigger usage freeze
      expect(usageServiceMock.freezeOnRevocation).not.toHaveBeenCalled();
      expect(apiKeyServiceMock.invalidateKeyCache).not.toHaveBeenCalled();
    });
  });

  describe("audit trail & privacy guarantees", () => {
    it("emits system audit event without leaking secret or key material", async () => {
      const candidateKey = {
        id: "key_secure_1",
        prefix: "secr1234",
        name: "Security Audited Key",
        organizationId: "org_secure",
        expiresAt: new Date("2026-10-20T10:00:00Z"),
      };

      prismaMock.apiKey.findMany.mockResolvedValue([candidateKey]);
      prismaMock.apiKey.updateMany.mockResolvedValue({ count: 1 });

      await job.sweep(baseTime);

      expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
      const auditPayload = prismaMock.auditLog.create.mock.calls[0][0].data;

      expect(auditPayload.actorType).toBe("system");
      expect(auditPayload.actorId).toBe("api-key-expiration-job");
      expect(auditPayload.action).toBe("api_key.revoked");
      expect(auditPayload.resourceType).toBe("api_key");
      expect(auditPayload.resourceId).toBe(candidateKey.id);
      expect(auditPayload.metadata).toEqual({
        prefix: candidateKey.prefix,
        name: candidateKey.name,
        organizationId: candidateKey.organizationId,
        revokedAt: baseTime.toISOString(),
        expiresAt: candidateKey.expiresAt.toISOString(),
        reason: "expired",
      });

      // Crucial privacy check: no key material / secret / hash present
      expect(auditPayload.metadata).not.toHaveProperty("secret");
      expect(auditPayload.metadata).not.toHaveProperty("keyHash");
      expect(auditPayload.metadata).not.toHaveProperty("hash");
    });
  });
});
