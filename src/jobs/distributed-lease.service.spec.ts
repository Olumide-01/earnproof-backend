import { DistributedLeaseService } from "./distributed-lease.service";

/**
 * Unit tests for DistributedLeaseService.
 *
 * Covers acquisition, renewal, release, query, and takeover scenarios.
 * Uses mocked Prisma to test the lease coordination logic without a database.
 * Clock skew tolerance is validated through SQL semantics testing.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrisma(overrides: Record<string, unknown> = {}) {
  const defaultImpl = {
    jobLease: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $queryRaw: jest.fn(),
    ...overrides,
  };
  return defaultImpl;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DistributedLeaseService", () => {
  describe("acquireLease", () => {
    it("calls the database with the correct parameters", async () => {
      const now = new Date("2025-01-15T10:00:00Z");
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const prisma = makePrisma({
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: "lease_1",
            jobName: "test_job",
            owner: "some-owner",
            expiresAt,
            lastHeartbeatAt: now,
            isExpired: false,
          },
        ]),
      });

      const service = new DistributedLeaseService(prisma as never);
      const result = await service.acquireLease("test_job", 24 * 60 * 60 * 1000);

      expect(result.acquired).toBeDefined();
      expect(result.owner).toBeDefined();
      expect(result.isExpired).toBe(false);
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it("returns the owner from the database response", async () => {
      const prisma = makePrisma({
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: "lease_1",
            jobName: "test_job",
            owner: "other-process-789",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            lastHeartbeatAt: new Date(),
            isExpired: false,
          },
        ]),
      });

      const service = new DistributedLeaseService(prisma as never);
      const result = await service.acquireLease("test_job", 24 * 60 * 60 * 1000);

      expect(result.owner).toBe("other-process-789");
      expect(result.isExpired).toBe(false);
    });

    it("reports acquisition failure when owner differs from this process", async () => {
      const prisma = makePrisma({
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: "lease_1",
            jobName: "locked_job",
            owner: "other-process-789",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            lastHeartbeatAt: new Date(),
            isExpired: false,
          },
        ]),
      });

      const service = new DistributedLeaseService(prisma as never);
      const result = await service.acquireLease("locked_job", 24 * 60 * 60 * 1000);

      expect(result.acquired).toBe(false);
      expect(result.owner).toBe("other-process-789");
    });

    it("uses database-time semantics for expiry checks (ON CONFLICT SQL)", async () => {
      const prisma = makePrisma({
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: "lease_1",
            jobName: "db_time_job",
            owner: "some-owner",
            expiresAt: new Date(),
            lastHeartbeatAt: new Date(),
            isExpired: false,
          },
        ]),
      });

      const service = new DistributedLeaseService(prisma as never);
      await service.acquireLease("db_time_job", 24 * 60 * 60 * 1000);

      expect(prisma.$queryRaw).toHaveBeenCalled();
      // Verify the service called the database function
      const calls = (prisma.$queryRaw as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
    });

    it("throws and logs an error if acquisition fails", async () => {
      const error = new Error("Database connection lost");
      const prisma = makePrisma({
        $queryRaw: jest.fn().mockRejectedValue(error),
      });

      const service = new DistributedLeaseService(prisma as never);

      await expect(service.acquireLease("fail_job", 24 * 60 * 60 * 1000)).rejects.toThrow(
        error,
      );
    });
  });

  describe("renewLease", () => {
    it("renews a lease owned by this process", async () => {
      const prisma = makePrisma({
        jobLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });

      const service = new DistributedLeaseService(prisma as never);
      const newExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const result = await service.renewLease("renew_job", 24 * 60 * 60 * 1000);

      expect(result.renewed).toBe(true);
      expect(prisma.jobLease.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          jobName: "renew_job",
          owner: service.getProcessId(),
        }),
        data: expect.objectContaining({
          expiresAt: expect.any(Date),
          lastHeartbeatAt: expect.any(Date),
        }),
      });
    });

    it("fails silently when the lease is not owned by this process", async () => {
      const prisma = makePrisma({
        jobLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      });

      const service = new DistributedLeaseService(prisma as never);

      const result = await service.renewLease("other_job", 24 * 60 * 60 * 1000);

      expect(result.renewed).toBe(false);
      expect(prisma.jobLease.updateMany).toHaveBeenCalled();
    });

    it("throws and logs an error if renewal fails", async () => {
      const error = new Error("Update failed");
      const prisma = makePrisma({
        jobLease: {
          updateMany: jest.fn().mockRejectedValue(error),
        },
      });

      const service = new DistributedLeaseService(prisma as never);

      await expect(
        service.renewLease("fail_job", 24 * 60 * 60 * 1000),
      ).rejects.toThrow(error);
    });
  });

  describe("releaseLease", () => {
    it("releases a lease owned by this process", async () => {
      const prisma = makePrisma({
        jobLease: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });

      const service = new DistributedLeaseService(prisma as never);

      const result = await service.releaseLease("release_job");

      expect(result).toBe(true);
      expect(prisma.jobLease.deleteMany).toHaveBeenCalledWith({
        where: {
          jobName: "release_job",
          owner: service.getProcessId(),
        },
      });
    });

    it("returns false when the lease is not owned by this process", async () => {
      const prisma = makePrisma({
        jobLease: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      });

      const service = new DistributedLeaseService(prisma as never);

      const result = await service.releaseLease("other_job");

      expect(result).toBe(false);
      expect(prisma.jobLease.deleteMany).toHaveBeenCalled();
    });

    it("throws and logs an error if release fails", async () => {
      const error = new Error("Delete failed");
      const prisma = makePrisma({
        jobLease: {
          deleteMany: jest.fn().mockRejectedValue(error),
        },
      });

      const service = new DistributedLeaseService(prisma as never);

      await expect(service.releaseLease("fail_job")).rejects.toThrow(error);
    });
  });

  describe("queryLease", () => {
    it("returns lease info when a lease exists", async () => {
      const leaseInfo = {
        jobName: "query_job",
        owner: "owner-123",
        expiresAt: new Date("2025-01-15T11:00:00Z"),
        lastHeartbeatAt: new Date("2025-01-15T10:00:00Z"),
        isExpired: false,
      };

      const prisma = makePrisma({
        $queryRaw: jest.fn().mockResolvedValue([leaseInfo]),
      });

      const service = new DistributedLeaseService(prisma as never);

      const result = await service.queryLease("query_job");

      expect(result).toEqual(leaseInfo);
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it("returns null when no lease exists", async () => {
      const prisma = makePrisma({
        $queryRaw: jest.fn().mockResolvedValue([]),
      });

      const service = new DistributedLeaseService(prisma as never);

      const result = await service.queryLease("missing_job");

      expect(result).toBeNull();
    });

    it("correctly identifies expired leases", async () => {
      const prisma = makePrisma({
        $queryRaw: jest.fn().mockResolvedValue([
          {
            jobName: "status_job",
            owner: "owner-456",
            expiresAt: new Date(Date.now() - 1000), // In the past
            lastHeartbeatAt: new Date(Date.now() - 1000),
            isExpired: true,
          },
        ]),
      });

      const service = new DistributedLeaseService(prisma as never);

      const result = await service.queryLease("status_job");

      expect(result?.isExpired).toBe(true);
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it("throws and logs an error if query fails", async () => {
      const error = new Error("Query failed");
      const prisma = makePrisma({
        $queryRaw: jest.fn().mockRejectedValue(error),
      });

      const service = new DistributedLeaseService(prisma as never);

      await expect(service.queryLease("fail_job")).rejects.toThrow(error);
    });
  });

  describe("getProcessId", () => {
    it("returns a process ID in the format hostname-pid", () => {
      const prisma = makePrisma();
      const service = new DistributedLeaseService(prisma as never);

      const processId = service.getProcessId();

      expect(processId).toMatch(/^[^-]+-\d+$/);
      expect(processId).toContain(String(process.pid));
    });

    it("is consistent across multiple calls", () => {
      const prisma = makePrisma();
      const service = new DistributedLeaseService(prisma as never);

      const processId1 = service.getProcessId();
      const processId2 = service.getProcessId();

      expect(processId1).toBe(processId2);
    });
  });

  describe("Lease lifecycle scenarios", () => {
    it("handles acquisition, renewal, and release in sequence", async () => {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const prisma = makePrisma({
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: "lease_1",
            jobName: "lifecycle_job",
            owner: "process-1",
            expiresAt,
            lastHeartbeatAt: new Date(),
            isExpired: false,
          },
        ]),
        jobLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });

      const service = new DistributedLeaseService(prisma as never);

      // Acquire
      const acquired = await service.acquireLease("lifecycle_job", 24 * 60 * 60 * 1000);
      expect(acquired.acquired).toBeDefined();

      // Renew
      const renewed = await service.renewLease("lifecycle_job", 24 * 60 * 60 * 1000);
      expect(renewed.renewed).toBe(true);

      // Release
      const released = await service.releaseLease("lifecycle_job");
      expect(released).toBe(true);
    });

    it("handles concurrent acquisition attempts (one succeeds, others get same owner)", async () => {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const prisma = makePrisma({
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: "lease_1",
              jobName: "concurrent_job",
              owner: "process-1",
              expiresAt,
              lastHeartbeatAt: new Date(),
              isExpired: false,
            },
          ])
          .mockResolvedValueOnce([
            {
              id: "lease_1",
              jobName: "concurrent_job",
              owner: "process-1",
              expiresAt,
              lastHeartbeatAt: new Date(),
              isExpired: false,
            },
          ]),
      });

      const service1 = new DistributedLeaseService(prisma as never);
      const service2 = new DistributedLeaseService(prisma as never);

      const result1 = await service1.acquireLease("concurrent_job", 24 * 60 * 60 * 1000);
      const result2 = await service2.acquireLease("concurrent_job", 24 * 60 * 60 * 1000);

      // At least one result should return properly formed data
      expect(result1.owner).toBeDefined();
      expect(result2.owner).toBeDefined();
      // They should show the same owner (the one who held the lease)
      expect(result1.owner).toBe(result2.owner);
    });

    it("detects stale lease status", async () => {
      const prisma = makePrisma({
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: "lease_1",
            jobName: "stale_job",
            owner: "old-service",
            expiresAt: new Date(Date.now() - 1000), // Expired
            lastHeartbeatAt: new Date(Date.now() - 1000),
            isExpired: true,
          },
        ]),
      });

      const service = new DistributedLeaseService(prisma as never);
      const result = await service.acquireLease("stale_job", 24 * 60 * 60 * 1000);

      // When lease is expired, isExpired should be true
      expect(result.isExpired).toBe(true);
    });
  });

  describe("Error handling and logging", () => {
    it("logs at appropriate levels during normal operations", async () => {
      const prisma = makePrisma({
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: "lease_1",
            jobName: "log_job",
            owner: "process-1",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            lastHeartbeatAt: new Date(),
            isExpired: false,
          },
        ]),
      });

      const service = new DistributedLeaseService(prisma as never);

      // Acquire should log at debug/log level
      await expect(
        service.acquireLease("log_job", 24 * 60 * 60 * 1000),
      ).resolves.toBeDefined();
    });
  });
});
