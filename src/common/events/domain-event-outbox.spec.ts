import { DomainEventStatus } from "@prisma/client";
import { DomainEventOutboxService } from "./domain-event-outbox.service";
import { DomainEventOutboxWorkerService } from "../../jobs/domain-event-outbox-worker.service";

describe("DomainEventOutboxService", () => {
  let service: DomainEventOutboxService;
  let worker: DomainEventOutboxWorkerService;
  let outboxStore: Map<string, any>;
  let consumerRecordStore: Map<string, any>;
  let mockPrisma: any;

  beforeEach(() => {
    outboxStore = new Map();
    consumerRecordStore = new Map();

    mockPrisma = {
      domainEventOutbox: {
        create: jest.fn(async ({ data }: any) => {
          const id = `evt_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          const record = {
            id,
            ...data,
            attempts: data.attempts ?? 0,
            status: data.status ?? DomainEventStatus.PENDING,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          outboxStore.set(id, record);
          return record;
        }),
        findMany: jest.fn(async ({ where, orderBy, take }: any) => {
          let list = Array.from(outboxStore.values());
          if (where?.status) {
            list = list.filter((item) => item.status === where.status);
          }
          if (orderBy) {
            list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          }
          return list.slice(0, take ?? 50);
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const item = outboxStore.get(where.id);
          if (!item) throw new Error("Event not found");
          const updated = { ...item, ...data, updatedAt: new Date() };
          outboxStore.set(where.id, updated);
          return updated;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const [id, item] of outboxStore.entries()) {
            let match = true;
            if (where.status && item.status !== where.status) match = false;
            if (where.id && item.id !== where.id) match = false;
            if (where.leaseExpiresAt?.lte && item.leaseExpiresAt > where.leaseExpiresAt.lte) match = false;

            if (match) {
              outboxStore.set(id, { ...item, ...data, updatedAt: new Date() });
              count++;
            }
          }
          return { count };
        }),
        deleteMany: jest.fn(async ({ where }: any) => {
          let count = 0;
          for (const [id, item] of Array.from(outboxStore.entries())) {
            let match = true;
            if (where.status?.in && !where.status.in.includes(item.status)) match = false;
            if (where.updatedAt?.lte && item.updatedAt > where.updatedAt.lte) match = false;
            if (match) {
              outboxStore.delete(id);
              count++;
            }
          }
          return { count };
        }),
      },
      domainEventConsumerRecord: {
        findUnique: jest.fn(async ({ where }: any) => {
          const key = `${where.eventId_consumerName.eventId}:${where.eventId_consumerName.consumerName}`;
          return consumerRecordStore.get(key) || null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const key = `${data.eventId}:${data.consumerName}`;
          consumerRecordStore.set(key, { id: `cr_${Date.now()}`, ...data });
          return data;
        }),
      },
    };

    service = new DomainEventOutboxService(mockPrisma);
    worker = new DomainEventOutboxWorkerService(service);
  });

  const orgId = "org-test-events";

  describe("Transactional publishing and redaction", () => {
    it("persists versioned domain events with correlation and causation ids", async () => {
      const event = await service.publish(mockPrisma, {
        organizationId: orgId,
        eventType: "proof.issued",
        eventVersion: 1,
        aggregateType: "proof",
        aggregateId: "proof-456",
        correlationId: "corr-1",
        causationId: "cmd-issue-proof",
        payload: {
          proofId: "proof-456",
          amount: 500,
        },
      });

      expect(event.id).toBeDefined();
      expect(event.status).toBe(DomainEventStatus.PENDING);
      expect(event.aggregateId).toBe("proof-456");
      expect(event.correlationId).toBe("corr-1");
      expect(event.causationId).toBe("cmd-issue-proof");
    });

    it("redacts sensitive fields, apiKeys, and Stellar secret seeds from payload", async () => {
      const stellarSeed = "SB6XQ27VRK7266M7V67J276Y7L7L7L7L7L7L7L7L7L7L7L7L7L7L7L7L";
      const event = await service.publish(mockPrisma, {
        organizationId: orgId,
        eventType: "payment.processed",
        aggregateType: "payment",
        aggregateId: "pay-1",
        payload: {
          walletSeed: stellarSeed,
          apiSecret: "super-secret-pass",
          userToken: "jwt-token-val",
          safeNote: `Generated with seed ${stellarSeed}`,
        },
      });

      expect(event.payload.apiSecret).toBe("[REDACTED]");
      expect(event.payload.userToken).toBe("[REDACTED]");
      expect(event.payload.walletSeed).toBe("[REDACTED]");
      expect(event.payload.safeNote).not.toContain(stellarSeed);
      expect(event.payload.safeNote).toContain("[REDACTED_SECRET_KEY]");
    });

    it("simulates rollback isolation: failed transaction leaves no event", async () => {
      const rollbackClient: any = {
        domainEventOutbox: {
          create: jest.fn(async () => {
            throw new Error("Transaction rolled back due to database constraint");
          }),
        },
      };

      await expect(
        service.publish(rollbackClient, {
          organizationId: orgId,
          eventType: "proof.failed",
          aggregateType: "proof",
          aggregateId: "proof-rollback",
          payload: {},
        }),
      ).rejects.toThrow(/Transaction rolled back/);

      expect(outboxStore.size).toBe(0);
    });
  });

  describe("Leased delivery, ordering, and duplicate prevention", () => {
    it("claims pending events under lease with strict FIFO ordering", async () => {
      // Create two events with distinct timestamps
      const evt1 = await service.publish(mockPrisma, {
        organizationId: orgId,
        eventType: "evt.one",
        aggregateType: "item",
        aggregateId: "1",
        payload: {},
      });
      // Force evt1 older
      outboxStore.get(evt1.id).createdAt = new Date(Date.now() - 5000);

      const evt2 = await service.publish(mockPrisma, {
        organizationId: orgId,
        eventType: "evt.two",
        aggregateType: "item",
        aggregateId: "2",
        payload: {},
      });

      const claimed = await service.claimBatch("worker-1", 10);
      expect(claimed.length).toBe(2);
      expect(claimed[0].id).toBe(evt1.id);
      expect(claimed[1].id).toBe(evt2.id);
      expect(claimed[0].leaseOwner).toBe("worker-1");
      expect(claimed[0].status).toBe(DomainEventStatus.LEASED);
    });

    it("guarantees idempotent consumer execution: duplicate delivery skips side effects", async () => {
      let executionCount = 0;
      const handler = {
        consumerName: "notification-service",
        handle: async () => {
          executionCount++;
        },
      };

      const event = await service.publish(mockPrisma, {
        organizationId: orgId,
        eventType: "user.notified",
        aggregateType: "user",
        aggregateId: "user-100",
        payload: {},
      });

      // First delivery: executed
      const first = await service.processEventWithConsumer(event, handler);
      expect(first.outcome).toBe("processed");
      expect(executionCount).toBe(1);

      // Re-delivery (e.g. retry or concurrent lease replay): skipped
      const second = await service.processEventWithConsumer(event, handler);
      expect(second.outcome).toBe("duplicate_skipped");
      expect(executionCount).toBe(1); // handler was not executed again
    });
  });

  describe("Crash recovery, poison events, and quarantine", () => {
    it("reclaims expired leases abandoned after worker crash", async () => {
      const event = await service.publish(mockPrisma, {
        organizationId: orgId,
        eventType: "task.pending",
        aggregateType: "task",
        aggregateId: "task-1",
        payload: {},
      });

      // Claim under worker-A
      await service.claimBatch("worker-A", 1, 1000);
      expect(outboxStore.get(event.id).status).toBe(DomainEventStatus.LEASED);

      // Simulate lease expiration (time passes)
      outboxStore.get(event.id).leaseExpiresAt = new Date(Date.now() - 2000);

      const reclaimed = await service.releaseExpiredLeases();
      expect(reclaimed).toBe(1);
      expect(outboxStore.get(event.id).status).toBe(DomainEventStatus.PENDING);
      expect(outboxStore.get(event.id).leaseOwner).toBeNull();
    });

    it("quarantines poison events that repeatedly fail until max attempts", async () => {
      const failingHandler = {
        consumerName: "flaky-consumer",
        handle: async () => {
          throw new Error("Permanent schema error");
        },
      };

      const event = await service.publish(mockPrisma, {
        organizationId: orgId,
        eventType: "poison.event",
        aggregateType: "poison",
        aggregateId: "p-1",
        maxAttempts: 3,
        payload: {},
      });

      // Attempts 1 and 2: retryable failures
      const res1 = await service.processEventWithConsumer(event, failingHandler);
      expect(res1.outcome).toBe("failed_retryable");

      const res2 = await service.processEventWithConsumer(
        outboxStore.get(event.id),
        failingHandler,
      );
      expect(res2.outcome).toBe("failed_retryable");

      // Attempt 3: exceeds max attempts -> QUARANTINED
      const res3 = await service.processEventWithConsumer(
        outboxStore.get(event.id),
        failingHandler,
      );
      expect(res3.outcome).toBe("quarantined");

      const finalRecord = outboxStore.get(event.id);
      expect(finalRecord.status).toBe(DomainEventStatus.QUARANTINED);
      expect(finalRecord.lastError).toContain("Permanent schema error");
    });

    it("sweeps processed and quarantined records older than retention cutoff", async () => {
      const event1 = await service.publish(mockPrisma, {
        organizationId: orgId,
        eventType: "old.event",
        aggregateType: "old",
        aggregateId: "1",
        payload: {},
      });
      outboxStore.get(event1.id).status = DomainEventStatus.PROCESSED;
      outboxStore.get(event1.id).updatedAt = new Date(Date.now() - 100_000);

      const swept = await service.sweepProcessed(new Date(Date.now() - 50_000));
      expect(swept).toBe(1);
      expect(outboxStore.has(event1.id)).toBe(false);
    });
  });

  describe("Worker lifecycle and graceful shutdown draining", () => {
    it("drains gracefully during application shutdown", async () => {
      expect(worker.isDraining()).toBe(false);

      worker.onApplicationShutdown();
      expect(worker.isDraining()).toBe(true);

      // Subsequent poll stops immediately when draining
      const processBatchSpy = jest.spyOn(service, "processBatch");
      await worker.poll();
      expect(processBatchSpy).not.toHaveBeenCalled();
    });
  });
});
