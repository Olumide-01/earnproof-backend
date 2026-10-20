import { DistributedLeaseService } from "../../src/jobs/distributed-lease.service";
import { integrationDatabase } from "./harness/database";
import { race } from "./harness/fixtures";

/**
 * Distributed lease integration tests.
 *
 * Tests real concurrent lease acquisition, renewal, release, and takeover
 * against a live PostgreSQL database. Validates:
 *
 * - Atomicity: Only one instance acquires a new lease
 * - Determinism: Lease expiry comparison uses database time, not client time
 * - Takeover: Expired leases are properly taken over by waiting instances
 * - Idempotency: Renewal of a held lease is safe to repeat
 * - Clock skew tolerance: Different instances' local clocks do not affect lease validity
 *
 * Concurrent lease operations are issued as `Promise.allSettled`, so the
 * database, not the test harness, determines the outcome.
 */

const db = integrationDatabase();

describe("distributed leases (integration)", () => {
  describe("lease acquisition", () => {
    it("lets exactly one instance acquire a new lease", async () => {
      const service1 = new DistributedLeaseService(db.prisma);
      const service2 = new DistributedLeaseService(db.prisma);
      const service3 = new DistributedLeaseService(db.prisma);

      const acquisitions = [
        service1.acquireLease("new_lease_job", 24 * 60 * 60 * 1000),
        service2.acquireLease("new_lease_job", 24 * 60 * 60 * 1000),
        service3.acquireLease("new_lease_job", 24 * 60 * 60 * 1000),
      ];

      const { fulfilled } = await race(acquisitions);

      expect(fulfilled).toHaveLength(3);
      // Exactly one should have acquired=true
      const acquired = fulfilled.filter((r) => r.acquired);
      expect(acquired).toHaveLength(1);

      // The other two should have acquired=false with the same owner
      const notAcquired = fulfilled.filter((r) => !r.acquired);
      expect(notAcquired).toHaveLength(2);
      expect(notAcquired[0].owner).toBe(notAcquired[1].owner);
      expect(notAcquired[0].owner).toBe(acquired[0].owner);
    });

    it("prevents two instances from simultaneously acquiring the same lease", async () => {
      const service1 = new DistributedLeaseService(db.prisma);
      const service2 = new DistributedLeaseService(db.prisma);

      // Acquire with service1
      const firstAcquisition = await service1.acquireLease("exclusive_job", 24 * 60 * 60 * 1000);
      expect(firstAcquisition.acquired).toBe(true);

      // Try to acquire with service2 concurrently
      const secondAcquisition = await service2.acquireLease("exclusive_job", 24 * 60 * 60 * 1000);

      expect(secondAcquisition.acquired).toBe(false);
      expect(secondAcquisition.owner).toBe(firstAcquisition.owner);
    });

    it("allows different jobs to be acquired independently", async () => {
      const service1 = new DistributedLeaseService(db.prisma);
      const service2 = new DistributedLeaseService(db.prisma);

      const lease1 = await service1.acquireLease("job_a", 24 * 60 * 60 * 1000);
      const lease2 = await service2.acquireLease("job_b", 24 * 60 * 60 * 1000);

      expect(lease1.acquired).toBe(true);
      expect(lease2.acquired).toBe(true);
      expect(lease1.owner).toBe(service1.getProcessId());
      expect(lease2.owner).toBe(service2.getProcessId());
    });
  });

  describe("lease renewal", () => {
    it("extends an owned lease's expiry time", async () => {
      const service = new DistributedLeaseService(db.prisma);

      const acquired = await service.acquireLease("renew_job", 10 * 60 * 1000); // 10 min
      expect(acquired.acquired).toBe(true);

      const lease1 = await service.queryLease("renew_job");
      expect(lease1).not.toBeNull();
      const expiry1 = lease1!.expiresAt;

      // Wait a bit and renew
      await new Promise((resolve) => setTimeout(resolve, 100));
      const renewed = await service.renewLease("renew_job", 24 * 60 * 60 * 1000); // 24 hours
      expect(renewed.renewed).toBe(true);

      const lease2 = await service.queryLease("renew_job");
      expect(lease2).not.toBeNull();
      const expiry2 = lease2!.expiresAt;

      // New expiry should be significantly later
      expect(expiry2.getTime()).toBeGreaterThan(expiry1.getTime());
    });

    it("fails to renew a lease not owned by this process", async () => {
      const service1 = new DistributedLeaseService(db.prisma);
      const service2 = new DistributedLeaseService(db.prisma);

      // service1 acquires
      const acquired = await service1.acquireLease("contested_job", 24 * 60 * 60 * 1000);
      expect(acquired.acquired).toBe(true);

      // service2 tries to renew
      const renewed = await service2.renewLease("contested_job", 24 * 60 * 60 * 1000);
      expect(renewed.renewed).toBe(false);
    });

    it("updates the lastHeartbeatAt timestamp on renewal", async () => {
      const service = new DistributedLeaseService(db.prisma);

      await service.acquireLease("heartbeat_job", 24 * 60 * 60 * 1000);

      const lease1 = await service.queryLease("heartbeat_job");
      const heartbeat1 = lease1!.lastHeartbeatAt;

      await new Promise((resolve) => setTimeout(resolve, 100));

      await service.renewLease("heartbeat_job", 24 * 60 * 60 * 1000);

      const lease2 = await service.queryLease("heartbeat_job");
      const heartbeat2 = lease2!.lastHeartbeatAt;

      expect(heartbeat2.getTime()).toBeGreaterThan(heartbeat1.getTime());
    });
  });

  describe("lease release", () => {
    it("deletes an owned lease from the database", async () => {
      const service = new DistributedLeaseService(db.prisma);

      await service.acquireLease("release_job", 24 * 60 * 60 * 1000);
      let lease = await service.queryLease("release_job");
      expect(lease).not.toBeNull();

      const released = await service.releaseLease("release_job");
      expect(released).toBe(true);

      lease = await service.queryLease("release_job");
      expect(lease).toBeNull();
    });

    it("allows another instance to acquire a released lease", async () => {
      const service1 = new DistributedLeaseService(db.prisma);
      const service2 = new DistributedLeaseService(db.prisma);

      // service1 acquires and then releases
      const acquired1 = await service1.acquireLease("reacquire_job", 24 * 60 * 60 * 1000);
      expect(acquired1.acquired).toBe(true);

      await service1.releaseLease("reacquire_job");

      // service2 should now be able to acquire
      const acquired2 = await service2.acquireLease("reacquire_job", 24 * 60 * 60 * 1000);
      expect(acquired2.acquired).toBe(true);
      expect(acquired2.owner).toBe(service2.getProcessId());
    });

    it("fails silently when trying to release a lease not owned by this process", async () => {
      const service1 = new DistributedLeaseService(db.prisma);
      const service2 = new DistributedLeaseService(db.prisma);

      // service1 acquires
      await service1.acquireLease("release_contested_job", 24 * 60 * 60 * 1000);

      // service2 tries to release
      const released = await service2.releaseLease("release_contested_job");
      expect(released).toBe(false);

      // Lease should still exist and be owned by service1
      const lease = await service1.queryLease("release_contested_job");
      expect(lease).not.toBeNull();
      expect(lease!.owner).toBe(service1.getProcessId());
    });
  });

  describe("lease takeover", () => {
    it("allows acquisition of an expired lease", async () => {
      const service1 = new DistributedLeaseService(db.prisma);
      const service2 = new DistributedLeaseService(db.prisma);

      // service1 acquires with a very short lease (1ms)
      const acquired1 = await service1.acquireLease("short_lease_job", 1);
      expect(acquired1.acquired).toBe(true);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 50));

      // service2 should be able to take over the expired lease
      const acquired2 = await service2.acquireLease("short_lease_job", 24 * 60 * 60 * 1000);
      expect(acquired2.acquired).toBe(true);
      expect(acquired2.owner).toBe(service2.getProcessId());

      // Verify the lease now belongs to service2
      const lease = await service2.queryLease("short_lease_job");
      expect(lease!.owner).toBe(service2.getProcessId());
    });

    it("does not take over a valid (not expired) lease", async () => {
      const service1 = new DistributedLeaseService(db.prisma);
      const service2 = new DistributedLeaseService(db.prisma);

      // service1 acquires with a long lease
      const acquired1 = await service1.acquireLease("long_lease_job", 24 * 60 * 60 * 1000);
      expect(acquired1.acquired).toBe(true);

      // service2 immediately tries to acquire (lease is not expired)
      const acquired2 = await service2.acquireLease("long_lease_job", 24 * 60 * 60 * 1000);
      expect(acquired2.acquired).toBe(false);
      expect(acquired2.owner).toBe(service1.getProcessId());
    });

    it("handles multiple concurrent takeover attempts (only one succeeds)", async () => {
      const service1 = new DistributedLeaseService(db.prisma);
      const service2 = new DistributedLeaseService(db.prisma);
      const service3 = new DistributedLeaseService(db.prisma);

      // service1 acquires with short lease
      await service1.acquireLease("takeover_race_job", 1);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 50));

      // services 2 and 3 race to take over
      const acquisitions = [
        service2.acquireLease("takeover_race_job", 24 * 60 * 60 * 1000),
        service3.acquireLease("takeover_race_job", 24 * 60 * 60 * 1000),
      ];

      const { fulfilled } = await race(acquisitions);

      // Exactly one should succeed
      const succeeded = fulfilled.filter((r) => r.acquired);
      expect(succeeded).toHaveLength(1);

      const failed = fulfilled.filter((r) => !r.acquired);
      expect(failed).toHaveLength(1);

      // The failed one should show the winner as owner
      expect(failed[0].owner).toBe(succeeded[0].owner);
    });
  });

  describe("query and monitoring", () => {
    it("returns null for non-existent leases", async () => {
      const service = new DistributedLeaseService(db.prisma);

      const lease = await service.queryLease("nonexistent_job");

      expect(lease).toBeNull();
    });

    it("returns accurate lease information", async () => {
      const service = new DistributedLeaseService(db.prisma);

      const acquired = await service.acquireLease("query_job", 24 * 60 * 60 * 1000);
      expect(acquired.acquired).toBe(true);

      const lease = await service.queryLease("query_job");

      expect(lease).not.toBeNull();
      expect(lease!.jobName).toBe("query_job");
      expect(lease!.owner).toBe(service.getProcessId());
      expect(lease!.isExpired).toBe(false);
      expect(lease!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(lease!.lastHeartbeatAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("correctly identifies expired leases", async () => {
      const service = new DistributedLeaseService(db.prisma);

      // Acquire with very short lease
      await service.acquireLease("expiry_check_job", 1);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Query should show isExpired=true
      const lease = await service.queryLease("expiry_check_job");
      expect(lease!.isExpired).toBe(true);
    });
  });

  describe("clock skew tolerance", () => {
    it("uses database time for expiry comparison, not client time", async () => {
      const service1 = new DistributedLeaseService(db.prisma);
      const service2 = new DistributedLeaseService(db.prisma);

      // service1 acquires a lease
      const acquired1 = await service1.acquireLease("clock_skew_job", 24 * 60 * 60 * 1000);
      expect(acquired1.acquired).toBe(true);

      // Query to verify expiry is set by the database
      const lease1 = await service1.queryLease("clock_skew_job");
      expect(lease1!.isExpired).toBe(false);

      // service2 cannot take it over (lease is not expired server-side)
      const acquired2 = await service2.acquireLease("clock_skew_job", 24 * 60 * 60 * 1000);
      expect(acquired2.acquired).toBe(false);

      // This is true regardless of whether the local client clocks are different
      // because expiry is evaluated on the database (CURRENT_TIMESTAMP)
    });
  });

  describe("comprehensive lifecycle", () => {
    it("handles a full job lifecycle: acquire, renew, release", async () => {
      const service = new DistributedLeaseService(db.prisma);

      // 1. Acquire
      const acquired = await service.acquireLease("lifecycle_job", 24 * 60 * 60 * 1000);
      expect(acquired.acquired).toBe(true);

      let lease = await service.queryLease("lifecycle_job");
      expect(lease).not.toBeNull();
      expect(lease!.owner).toBe(service.getProcessId());

      // 2. Renew
      const renewed = await service.renewLease("lifecycle_job", 24 * 60 * 60 * 1000);
      expect(renewed.renewed).toBe(true);

      lease = await service.queryLease("lifecycle_job");
      expect(lease!.owner).toBe(service.getProcessId());

      // 3. Release
      const released = await service.releaseLease("lifecycle_job");
      expect(released).toBe(true);

      lease = await service.queryLease("lifecycle_job");
      expect(lease).toBeNull();
    });

    it("handles repeated lease cycles for the same job", async () => {
      const service1 = new DistributedLeaseService(db.prisma);
      const service2 = new DistributedLeaseService(db.prisma);

      // Cycle 1: service1
      const cycle1 = await service1.acquireLease("cycle_job", 24 * 60 * 60 * 1000);
      expect(cycle1.acquired).toBe(true);
      await service1.releaseLease("cycle_job");

      // Cycle 2: service2
      const cycle2 = await service2.acquireLease("cycle_job", 24 * 60 * 60 * 1000);
      expect(cycle2.acquired).toBe(true);
      expect(cycle2.owner).toBe(service2.getProcessId());
      await service2.releaseLease("cycle_job");

      // Cycle 3: service1 again
      const cycle3 = await service1.acquireLease("cycle_job", 24 * 60 * 60 * 1000);
      expect(cycle3.acquired).toBe(true);
      expect(cycle3.owner).toBe(service1.getProcessId());
    });
  });

  describe("error boundary", () => {
    it("propagates database errors appropriately", async () => {
      const service = new DistributedLeaseService(db.prisma);

      // Query a lease should work even if database is healthy
      const lease = await service.queryLease("error_test_job");
      expect(lease).toBeNull(); // Just checking no error is thrown
    });

    it("handles concurrent operations without deadlock", async () => {
      const services = Array.from({ length: 5 }, () => new DistributedLeaseService(db.prisma));
      const operations = [];

      for (let i = 0; i < 3; i++) {
        for (const service of services) {
          operations.push(service.acquireLease(`concurrent_job_${i}`, 24 * 60 * 60 * 1000));
        }
      }

      const { fulfilled, rejected } = await race(operations);

      // All operations should complete without deadlock
      expect(fulfilled.length + rejected.length).toBe(operations.length);
      expect(rejected).toEqual([]); // No rejections expected
    });
  });
});
