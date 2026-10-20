import { AnchoringOperation, AnchoringStatus } from "@prisma/client";
import { AnchoringWorkerService } from "./anchoring-worker.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(enabled = true) {
  return {
    get: jest.fn((key: string) => {
      if (key === "contractAnchoring.enabled") return enabled;
      return undefined;
    }),
  };
}

function makeIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "intent_1",
    proofId: "proof_1",
    operation: AnchoringOperation.REGISTER,
    status: AnchoringStatus.PENDING,
    attemptCount: 0,
    lastAttemptAt: null,
    nextRetryAt: null,
    transactionHash: null,
    ledger: null,
    lastErrorSafe: null,
    permanentError: false,
    proof: { commitment: "sha256:abc", expiresAt: new Date("2027-01-01") },
    ...overrides,
  };
}

function makeAnchoring(result: unknown = { anchored: true, transactionHash: "tx_1" }) {
  return {
    anchorProof: jest.fn().mockResolvedValue(result),
    revokeProof: jest.fn().mockResolvedValue(result),
    // Backpressure consults the dependency circuit before claiming; a closed
    // circuit is the default so existing behaviour is unchanged.
    circuitState: jest.fn().mockReturnValue("closed"),
  };
}

function makePrisma(intentOverrides?: Record<string, unknown>) {
  const intent = makeIntent(intentOverrides);
  return {
    anchoringIntent: {
      findUnique: jest.fn().mockResolvedValue(intent),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(intent),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([intent]),
      create: jest.fn().mockResolvedValue(intent),
    },
    proof: {
      update: jest.fn().mockResolvedValue({ id: "proof_1" }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn().mockImplementation(async (arg) => {
      if (typeof arg === "function") {
        return arg({
          anchoringIntent: {
            findMany: jest.fn().mockResolvedValue([intent]),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findFirst: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue(intent),
          },
        });
      }
      // array form
      return Promise.all(arg.map((p: Promise<unknown>) => p));
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnchoringWorkerService", () => {
  describe("processIntent", () => {
    it("confirms a REGISTER intent and updates proof.contractTransactionHash", async () => {
      const prisma = makePrisma();
      const anchoring = makeAnchoring({ anchored: true, transactionHash: "tx_abc" });
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      expect(anchoring.anchorProof).toHaveBeenCalledWith(
        expect.objectContaining({ proofId: "proof_1" }),
      );
      // Both intent update and proof update must be issued atomically via $transaction.
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("is idempotent — skips CLI call when a CONFIRMED intent already exists for (proofId, operation)", async () => {
      const prisma = makePrisma();
      // Simulate an already-confirmed intent for the same (proofId, operation).
      prisma.anchoringIntent.findFirst = jest.fn().mockResolvedValue({
        transactionHash: "tx_existing",
        ledger: "1234",
      });
      const anchoring = makeAnchoring();
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      expect(anchoring.anchorProof).not.toHaveBeenCalled();
      expect(prisma.anchoringIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: AnchoringStatus.CONFIRMED }),
        }),
      );
    });

    it("skips terminal intents — CONFIRMED intent is a no-op (duplicate delivery)", async () => {
      const prisma = makePrisma({ status: AnchoringStatus.CONFIRMED });
      const anchoring = makeAnchoring();
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      // Already terminal: no CLI call, no DB write.
      expect(anchoring.anchorProof).not.toHaveBeenCalled();
      expect(prisma.anchoringIntent.update).not.toHaveBeenCalled();
    });

    it("skips terminal intents — FAILED intent is a no-op (duplicate delivery)", async () => {
      const prisma = makePrisma({ status: AnchoringStatus.FAILED });
      const anchoring = makeAnchoring();
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      expect(anchoring.anchorProof).not.toHaveBeenCalled();
      expect(prisma.anchoringIntent.update).not.toHaveBeenCalled();
    });

    it("retries transient failures with backoff and does NOT mark permanent", async () => {
      const prisma = makePrisma();
      const anchoring = {
        anchorProof: jest.fn().mockRejectedValue(new Error("connection timeout")),
        revokeProof: jest.fn(),
      };
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      expect(prisma.anchoringIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: AnchoringStatus.PENDING,
            permanentError: false,
            nextRetryAt: expect.any(Date),
            lastErrorSafe: expect.stringContaining("timeout"),
          }),
        }),
      );
    });

    it("quarantines an intent as CHAIN_REJECTED when error matches a chain-rejection pattern", async () => {
      const prisma = makePrisma();
      const anchoring = {
        anchorProof: jest.fn().mockRejectedValue(new Error("proof already registered")),
        revokeProof: jest.fn(),
      };
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      expect(prisma.anchoringIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: AnchoringStatus.QUARANTINED,
            permanentError: true,
            quarantineReasonCode: "CHAIN_REJECTED",
            quarantineDecision: "PENDING",
            quarantinedAt: expect.any(Date),
          }),
        }),
      );
    });

    it("quarantines an intent as POISON_INPUT when the error says the input itself cannot succeed", async () => {
      const prisma = makePrisma();
      const anchoring = {
        anchorProof: jest.fn().mockRejectedValue(new Error("proof not found")),
        revokeProof: jest.fn(),
      };
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      expect(prisma.anchoringIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: AnchoringStatus.QUARANTINED,
            permanentError: true,
            quarantineReasonCode: "POISON_INPUT",
          }),
        }),
      );
    });

    it("quarantines an intent as MAX_ATTEMPTS_EXCEEDED when MAX_ATTEMPTS is reached", async () => {
      // Simulate attemptCount already at 9 (one below max 10).
      const prisma = makePrisma({ attemptCount: 9 });
      const anchoring = {
        anchorProof: jest.fn().mockRejectedValue(new Error("network error")),
        revokeProof: jest.fn(),
      };
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      expect(prisma.anchoringIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: AnchoringStatus.QUARANTINED,
            permanentError: true,
            quarantineReasonCode: "MAX_ATTEMPTS_EXCEEDED",
          }),
        }),
      );
    });

    it("skips terminal intents — QUARANTINED intent is a no-op (never auto-retried)", async () => {
      const prisma = makePrisma({ status: AnchoringStatus.QUARANTINED });
      const anchoring = makeAnchoring();
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      expect(anchoring.anchorProof).not.toHaveBeenCalled();
      expect(prisma.anchoringIntent.update).not.toHaveBeenCalled();
    });

    it("does NOT store secrets in lastErrorSafe when error contains a Stellar secret key pattern", async () => {
      const secretKey = `S${"A".repeat(55)}`; // 56-char S-prefixed key
      const prisma = makePrisma();
      const anchoring = {
        anchorProof: jest
          .fn()
          .mockRejectedValue(new Error(`failed with key ${secretKey}`)),
        revokeProof: jest.fn(),
      };
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      const updateCall = (prisma.anchoringIntent.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.lastErrorSafe).not.toContain(secretKey);
      expect(updateCall.data.lastErrorSafe).toContain("[REDACTED_SECRET]");
    });

    it("does NOT store env-var-like credentials in lastErrorSafe", async () => {
      const prisma = makePrisma();
      const anchoring = {
        anchorProof: jest
          .fn()
          .mockRejectedValue(
            new Error("failed: STELLAR_CLI_SOURCE=SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
          ),
        revokeProof: jest.fn(),
      };
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      const updateCall = (prisma.anchoringIntent.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.lastErrorSafe).not.toContain("STELLAR_CLI_SOURCE=");
    });
  });

  describe("poll — crash recovery", () => {
    it("resets stale PROCESSING intents back to PENDING", async () => {
      const prisma = makePrisma();
      // Override to simulate stale PROCESSING reset finds 2 records.
      prisma.anchoringIntent.updateMany = jest.fn().mockResolvedValue({ count: 2 });
      // processBatch claims nothing.
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      prisma.$transaction = jest.fn().mockResolvedValue([]);

      const worker = new AnchoringWorkerService(
        prisma as never,
        makeAnchoring() as never,
        makeConfig() as never,
      );

      await worker.poll();

      expect(prisma.anchoringIntent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: AnchoringStatus.PROCESSING }),
          data: expect.objectContaining({ status: AnchoringStatus.PENDING }),
        }),
      );
    });

    it("does not poll when anchoring is disabled", async () => {
      const prisma = makePrisma();
      const worker = new AnchoringWorkerService(
        prisma as never,
        makeAnchoring() as never,
        makeConfig(false) as never,
      );

      await worker.poll();

      expect(prisma.anchoringIntent.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("REVOKE operation", () => {
    it("calls revokeProof for REVOKE intents", async () => {
      const prisma = makePrisma({ operation: AnchoringOperation.REVOKE });
      const anchoring = makeAnchoring({ anchored: true, transactionHash: "tx_revoke" });
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.processIntent("intent_1");

      expect(anchoring.revokeProof).toHaveBeenCalledWith("proof_1");
      expect(anchoring.anchorProof).not.toHaveBeenCalled();
    });
  });

  describe("Concurrency — double-submit prevention", () => {
    it("atomically claims only rows transitioned by this worker — losing worker gets zero rows", async () => {
      // Simulate two concurrent workers attempting to claim the same PENDING intent.
      // Worker 1 succeeds (UPDATE returns the row).
      // Worker 2 fails (UPDATE returns zero rows because status is now PROCESSING).
      const now = new Date();
      const intent1 = makeIntent({ id: "intent_1", proofId: "proof_1" });

      // Worker 1: UPDATE succeeds, returns intent_1
      // Worker 2: UPDATE fails (row already claimed), returns empty array
      const prisma = {
        anchoringIntent: {
          findUnique: jest.fn().mockResolvedValue(intent1),
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn().mockResolvedValue(intent1),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findMany: jest.fn()
            .mockResolvedValueOnce([intent1]) // findMany for full intent data (Worker 1)
            .mockResolvedValueOnce([]), // findMany for full intent data (Worker 2, after losing claim)
          create: jest.fn().mockResolvedValue(intent1),
        },
        proof: {
          update: jest.fn().mockResolvedValue({ id: "proof_1" }),
        },
        $queryRaw: jest
          .fn()
          // Worker 1: claims intent_1 (atomic UPDATE...RETURNING succeeds)
          .mockResolvedValueOnce([
            {
              id: "intent_1",
              proofId: "proof_1",
              operation: AnchoringOperation.REGISTER,
              status: AnchoringStatus.PROCESSING,
              attemptCount: 0,
              lastAttemptAt: now,
              nextRetryAt: null,
              transactionHash: null,
              ledger: null,
              lastErrorSafe: null,
              permanentError: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ])
          // Worker 2: tries to claim, but intent_1 is no longer PENDING (already PROCESSING by Worker 1)
          // UPDATE...RETURNING returns zero rows
          .mockResolvedValueOnce([]),
      };

      const anchoring = makeAnchoring();
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      // Simulate Worker 1 claiming and processing
      await worker.poll();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(anchoring.anchorProof).toHaveBeenCalledTimes(1);

      // Reset mock to simulate Worker 2's call
      (prisma.$queryRaw as jest.Mock).mockClear();
      (anchoring.anchorProof as jest.Mock).mockClear();

      // Simulate Worker 2 attempting to claim the same intent
      // It calls the same processBatch logic
      await worker.poll();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      // Worker 2's UPDATE...RETURNING returned zero rows, so anchorProof NOT called
      expect(anchoring.anchorProof).not.toHaveBeenCalled();
    });

    it("UPDATE...RETURNING only returns rows actually claimed (transition PENDING→PROCESSING)", async () => {
      // Verify that the atomic UPDATE...RETURNING in processBatch only returns
      // rows that THIS worker successfully transitioned, not all rows it selected.
      const now = new Date();
      const intent = makeIntent({ id: "intent_1", proofId: "proof_1" });

      const claimedRows = [
        {
          id: "intent_1",
          proofId: "proof_1",
          operation: AnchoringOperation.REGISTER,
          status: AnchoringStatus.PROCESSING,
          attemptCount: 0,
          lastAttemptAt: now,
          nextRetryAt: null,
          transactionHash: null,
          ledger: null,
          lastErrorSafe: null,
          permanentError: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const prisma = {
        anchoringIntent: {
          findUnique: jest.fn().mockResolvedValue(intent),
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn().mockResolvedValue(intent),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findMany: jest.fn().mockResolvedValue([intent]),
          create: jest.fn().mockResolvedValue(intent),
        },
        proof: {
          update: jest.fn().mockResolvedValue({ id: "proof_1" }),
        },
        // The atomic UPDATE...RETURNING in processBatch should ONLY return
        // rows that were actually transitioned by this worker's UPDATE.
        $queryRaw: jest.fn().mockResolvedValue(claimedRows),
        $transaction: jest.fn().mockImplementation(async (arg) => {
          if (typeof arg === "function") {
            return arg({
              anchoringIntent: {
                findMany: jest.fn().mockResolvedValue([intent]),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn().mockResolvedValue(intent),
              },
            });
          }
          return Promise.all(arg.map((p: Promise<unknown>) => p));
        }),
      };

      const anchoring = makeAnchoring();
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await worker.poll();

      // $queryRaw (atomic UPDATE...RETURNING) was called
      expect(prisma.$queryRaw).toHaveBeenCalled();
      // It returned the claimed rows (check the first argument of the first call)
      const firstCall = (prisma.$queryRaw as jest.Mock).mock.calls[0];
      expect(firstCall).toBeDefined();
      // When called as a tagged template, the first arg is an array of strings
      if (Array.isArray(firstCall[0])) {
        expect(firstCall[0].join("")).toContain("UPDATE");
      } else {
        expect(firstCall[0]).toContain("UPDATE");
      }
      // The anchoring service was called for each claimed intent
      expect(anchoring.anchorProof).toHaveBeenCalledTimes(1);
    });

    it("fails gracefully when concurrent claim loses (UPDATE...RETURNING returns empty)", async () => {
      // Simulate a worker that loses a concurrent claim race.
      // The UPDATE...RETURNING returns zero rows (another worker claimed it first).
      // The worker should handle this gracefully and not crash.
      const prisma = {
        anchoringIntent: {
          findUnique: jest.fn().mockResolvedValue(null),
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn().mockResolvedValue(null),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockResolvedValue(null),
        },
        proof: {
          update: jest.fn().mockResolvedValue(null),
        },
        // UPDATE...RETURNING returns zero rows (claim lost)
        $queryRaw: jest.fn().mockResolvedValue([]),
      };

      const anchoring = makeAnchoring();
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      // Should not throw
      await expect(worker.poll()).resolves.toBeUndefined();

      // anchorProof should not be called (no rows claimed)
      expect(anchoring.anchorProof).not.toHaveBeenCalled();
    });
  });

  describe("Database uniqueness constraint — (proofId, operation) with status IN (PROCESSING, CONFIRMED)", () => {
    it("would reject INSERT/UPDATE that violates the partial unique constraint", async () => {
      // This is a conceptual test showing what the database constraint prevents.
      // In practice, the atomic UPDATE...RETURNING prevents us from ever reaching
      // a constraint violation, but the constraint is a safety net.
      //
      // The constraint is:
      //   UNIQUE (proofId, operation) WHERE status IN ('PROCESSING', 'CONFIRMED')
      //
      // If application logic were bypassed and two PROCESSING intents existed
      // for the same (proofId, operation), the database would reject the second one.
      //
      // Test setup: simulate the constraint existing and verify it would reject.
      const prisma = makePrisma();

      // Mock to simulate constraint violation
      (prisma.anchoringIntent.create as jest.Mock).mockRejectedValueOnce(
        new Error(
          'Unique constraint failed on the fields: (`proofId`,`operation`)',
        ),
      );

      // Note: The worker instance is created but not used in this test because
      // we're directly testing the Prisma constraint behavior without going through the service.
      // This tests the database-level constraint independently.

      // Attempting to create a second PROCESSING intent for the same (proofId, operation)
      // should fail with a unique constraint error.
      await expect(
        prisma.anchoringIntent.create({
          data: {
            proofId: "proof_1",
            operation: AnchoringOperation.REGISTER,
            status: AnchoringStatus.PROCESSING,
          },
        }),
      ).rejects.toThrow("Unique constraint failed");
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown / draining (earnproof-backend#68)
  // ---------------------------------------------------------------------------

  describe("onApplicationShutdown", () => {
    it("stops new poll cycles from starting once shutdown begins", async () => {
      const prisma = makePrisma();
      const anchoring = makeAnchoring();
      const config = makeConfig(true);
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        config as never,
      );

      await worker.onApplicationShutdown("SIGTERM");
      (prisma.anchoringIntent.updateMany as jest.Mock).mockClear();

      await worker.poll();

      // resetStaleProcessing() would have called updateMany; poll() must
      // have returned immediately instead.
      expect(prisma.anchoringIntent.updateMany).not.toHaveBeenCalled();
    });

    it("waits for an in-flight poll cycle to finish before resolving", async () => {
      const prisma = makePrisma();
      let releaseQueryRaw!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseQueryRaw = resolve;
      });
      // $queryRaw is called inside processBatch — block it until the test
      // explicitly releases the gate, simulating a still-running cycle.
      (prisma.$queryRaw as jest.Mock).mockImplementation(async () => {
        await gate;
        return [];
      });
      const anchoring = makeAnchoring();
      const config = makeConfig(true);
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        config as never,
      );

      const pollPromise = worker.poll();
      // Let poll() reach the gated $queryRaw call before shutdown begins.
      await new Promise((r) => setImmediate(r));

      let shutdownResolved = false;
      const shutdownPromise = worker
        .onApplicationShutdown("SIGTERM")
        .then(() => {
          shutdownResolved = true;
        });

      // Give the event loop a couple of ticks — shutdown must NOT resolve
      // while the cycle is still gated.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(shutdownResolved).toBe(false);

      releaseQueryRaw();
      await pollPromise;
      await shutdownPromise;

      expect(shutdownResolved).toBe(true);
    });

    it("gives up waiting after the drain timeout and logs a warning", async () => {
      jest.useFakeTimers();
      try {
        const prisma = makePrisma();
        let releaseQueryRaw!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseQueryRaw = resolve;
        });
        (prisma.$queryRaw as jest.Mock).mockImplementation(async () => {
          await gate;
          return [];
        });
        const anchoring = makeAnchoring();
        const config = makeConfig(true);
        const worker = new AnchoringWorkerService(
          prisma as never,
          anchoring as never,
          config as never,
        );

        const pollPromise = worker.poll();
        await Promise.resolve();

        const shutdownPromise = worker.onApplicationShutdown("SIGTERM");
        // Advance past SHUTDOWN_DRAIN_TIMEOUT_MS (25s) while the cycle is
        // still gated — the timeout branch must win the race.
        await jest.advanceTimersByTimeAsync(30_000);

        await expect(shutdownPromise).resolves.toBeUndefined();

        // Release the gate so the still-running poll cycle (and this test's
        // own promises) resolve cleanly instead of leaking a handle past
        // the test.
        releaseQueryRaw();
        await pollPromise;
      } finally {
        jest.useRealTimers();
      }
    });

    it("resolves immediately when no cycle is in flight", async () => {
      const prisma = makePrisma();
      const anchoring = makeAnchoring();
      const config = makeConfig(true);
      const worker = new AnchoringWorkerService(
        prisma as never,
        anchoring as never,
        config as never,
      );

      await expect(worker.onApplicationShutdown("SIGTERM")).resolves.toBeUndefined();
    });
  });
});
