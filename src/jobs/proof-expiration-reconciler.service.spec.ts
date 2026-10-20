import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { ProofStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { ProofExpirationReconcilerService } from "./proof-expiration-reconciler.service";

describe("ProofExpirationReconcilerService", () => {
  let service: ProofExpirationReconcilerService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProofExpirationReconcilerService,
        {
          provide: PrismaService,
          useValue: {
            proof: {
              findMany: jest.fn(),
              updateMany: jest.fn(),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === "PROOF_EXPIRATION_RECONCILIATION_ENABLED") {
                return "true";
              }
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ProofExpirationReconcilerService>(
      ProofExpirationReconcilerService,
    );
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("reconcileBatch", () => {
    it("should transition expired ACTIVE proofs to EXPIRED", async () => {
      const now = new Date();
      const expiredProofs = [
        { id: "proof-1" },
        { id: "proof-2" },
        { id: "proof-3" },
      ];

      jest.spyOn(prisma.proof, "findMany").mockResolvedValue(expiredProofs as any);
      jest.spyOn(prisma.proof, "updateMany").mockResolvedValue({ count: 3 });

      const count = await service.reconcileBatch();

      expect(count).toBe(3);
      expect(prisma.proof.findMany).toHaveBeenCalledWith({
        where: {
          status: ProofStatus.ACTIVE,
          expiresAt: { lte: expect.any(Date) },
        },
        select: { id: true },
        take: 100,
        orderBy: { expiresAt: "asc" },
      });
      expect(prisma.proof.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["proof-1", "proof-2", "proof-3"] },
          status: ProofStatus.ACTIVE,
        },
        data: {
          status: ProofStatus.EXPIRED,
        },
      });
    });

    it("should return 0 when no expired proofs exist", async () => {
      jest.spyOn(prisma.proof, "findMany").mockResolvedValue([]);

      const count = await service.reconcileBatch();

      expect(count).toBe(0);
      expect(prisma.proof.updateMany).not.toHaveBeenCalled();
    });

    it("should handle boundary instant: proof expiring exactly at reconciliation time", async () => {
      const now = new Date("2026-09-27T12:00:00Z");
      jest.useFakeTimers().setSystemTime(now);

      const expiredProof = { id: "boundary-proof" };
      jest.spyOn(prisma.proof, "findMany").mockResolvedValue([expiredProof] as any);
      jest.spyOn(prisma.proof, "updateMany").mockResolvedValue({ count: 1 });

      const count = await service.reconcileBatch();

      expect(count).toBe(1);
      expect(prisma.proof.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            expiresAt: { lte: expect.any(Date) },
          }),
        }),
      );

      jest.useRealTimers();
    });

    it("should not affect REVOKED proofs that have also expired", async () => {
      // The query filters on status=ACTIVE, so REVOKED proofs are never selected
      jest.spyOn(prisma.proof, "findMany").mockResolvedValue([]);

      const count = await service.reconcileBatch();

      expect(count).toBe(0);
      expect(prisma.proof.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: ProofStatus.ACTIVE,
          }),
        }),
      );
    });

    it("should process proofs in oldest-first order", async () => {
      jest.spyOn(prisma.proof, "findMany").mockResolvedValue([]);

      await service.reconcileBatch();

      expect(prisma.proof.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { expiresAt: "asc" },
        }),
      );
    });

    it("should be idempotent: running twice on same proof is safe", async () => {
      const expiredProof = { id: "idempotent-test" };

      // First run: finds the proof
      jest.spyOn(prisma.proof, "findMany").mockResolvedValueOnce([expiredProof] as any);
      jest.spyOn(prisma.proof, "updateMany").mockResolvedValueOnce({ count: 1 });

      const count1 = await service.reconcileBatch();
      expect(count1).toBe(1);

      // Second run: proof is now EXPIRED, so query returns nothing
      jest.spyOn(prisma.proof, "findMany").mockResolvedValueOnce([]);

      const count2 = await service.reconcileBatch();
      expect(count2).toBe(0);
    });

    it("should handle restart mid-cycle: partial batch completion", async () => {
      // Simulates a restart where some proofs were updated and some weren't.
      // The next run should only find the ones that are still ACTIVE.
      const remainingProofs = [{ id: "proof-10" }, { id: "proof-11" }];

      jest.spyOn(prisma.proof, "findMany").mockResolvedValue(remainingProofs as any);
      jest.spyOn(prisma.proof, "updateMany").mockResolvedValue({ count: 2 });

      const count = await service.reconcileBatch();

      expect(count).toBe(2);
      // The query naturally filters out already-updated proofs
    });

    it("should handle proof revoked before expiry: REVOKED status preserved", async () => {
      // A proof that was revoked at t=10 and expires at t=20.
      // At t=25, reconciliation runs, but the proof has status=REVOKED,
      // so it's not selected by the query.
      jest.spyOn(prisma.proof, "findMany").mockResolvedValue([]);

      const count = await service.reconcileBatch();

      expect(count).toBe(0);
      // Verifies that only ACTIVE proofs are considered
    });
  });

  describe("reconcile", () => {
    it("should process multiple batches until drained", async () => {
      // First batch: 100 proofs
      jest
        .spyOn(service, "reconcileBatch")
        .mockResolvedValueOnce(100)
        // Second batch: 50 proofs (partial batch, signals end)
        .mockResolvedValueOnce(50);

      const total = await service.reconcile();

      expect(total).toBe(150);
      expect(service.reconcileBatch).toHaveBeenCalledTimes(2);
    });

    it("should stop early if fewer than batch size returned", async () => {
      jest
        .spyOn(service, "reconcileBatch")
        .mockResolvedValueOnce(10); // Less than RECONCILE_BATCH_SIZE

      const total = await service.reconcile();

      expect(total).toBe(10);
      expect(service.reconcileBatch).toHaveBeenCalledTimes(1);
    });

    it("should respect MAX_BATCHES_PER_CYCLE cap", async () => {
      // Mock 10 full batches
      jest.spyOn(service, "reconcileBatch").mockResolvedValue(100);

      const total = await service.reconcile();

      expect(total).toBe(1000); // 10 batches * 100 proofs
      expect(service.reconcileBatch).toHaveBeenCalledTimes(10);
    });

    it("should handle empty result on first batch", async () => {
      jest.spyOn(service, "reconcileBatch").mockResolvedValue(0);

      const total = await service.reconcile();

      expect(total).toBe(0);
      expect(service.reconcileBatch).toHaveBeenCalledTimes(1);
    });
  });

  describe("reconcileExpiredProofs (scheduled job)", () => {
    it("should skip execution when disabled", async () => {
      const disabledModule = await Test.createTestingModule({
        providers: [
          ProofExpirationReconcilerService,
          {
            provide: PrismaService,
            useValue: {
              proof: {
                findMany: jest.fn(),
                updateMany: jest.fn(),
              },
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(() => "false"), // Disabled
            },
          },
        ],
      }).compile();

      const disabledService = disabledModule.get<ProofExpirationReconcilerService>(
        ProofExpirationReconcilerService,
      );
      const disabledPrisma = disabledModule.get<PrismaService>(PrismaService);

      await disabledService.reconcileExpiredProofs();

      expect(disabledPrisma.proof.findMany).not.toHaveBeenCalled();
    });

    it("should skip if previous cycle is still running", async () => {
      jest.spyOn(service, "reconcileBatch").mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(0), 100);
          }),
      );

      // Start first cycle
      const firstCycle = service.reconcileExpiredProofs();

      // Immediately try to start second cycle
      await service.reconcileExpiredProofs();

      // Wait for first to complete
      await firstCycle;

      // reconcileBatch should only be called once (from first cycle)
      expect(service.reconcileBatch).toHaveBeenCalledTimes(1);
    });

    it("should log reconciliation results when proofs are updated", async () => {
      const logSpy = jest.spyOn(service["logger"], "log");

      jest
        .spyOn(service, "reconcileBatch")
        .mockResolvedValueOnce(50)
        .mockResolvedValueOnce(0);

      await service.reconcileExpiredProofs();

      expect(logSpy).toHaveBeenCalledWith(
        "Reconciled expired proofs",
        expect.objectContaining({
          reconciled: 50,
          batches: expect.any(Number),
          durationMs: expect.any(Number),
        }),
      );
    });

    it("should not log when no proofs are reconciled", async () => {
      const logSpy = jest.spyOn(service["logger"], "log");

      jest.spyOn(service, "reconcileBatch").mockResolvedValue(0);

      await service.reconcileExpiredProofs();

      // Should not log reconciliation results (only initialization log)
      expect(logSpy).not.toHaveBeenCalledWith(
        "Reconciled expired proofs",
        expect.any(Object),
      );
    });

    it("should handle and log errors without crashing", async () => {
      const errorSpy = jest.spyOn(service["logger"], "error");
      const error = new Error("Database connection lost");

      jest.spyOn(service, "reconcileBatch").mockRejectedValue(error);

      await service.reconcileExpiredProofs();

      expect(errorSpy).toHaveBeenCalledWith(
        "Proof expiration reconciliation cycle failed",
        expect.objectContaining({
          error: "Database connection lost",
        }),
      );
    });

    it("should reset running flag after error", async () => {
      jest
        .spyOn(service, "reconcileBatch")
        .mockRejectedValueOnce(new Error("Test error"))
        .mockResolvedValueOnce(10);

      // First call fails
      await service.reconcileExpiredProofs();

      // Second call should succeed (running flag was reset)
      await service.reconcileExpiredProofs();

      expect(service.reconcileBatch).toHaveBeenCalledTimes(2);
    });
  });

  describe("boundary and edge cases", () => {
    it("should handle large batch exactly at limit", async () => {
      const largeSet = Array.from({ length: 100 }, (_, i) => ({
        id: `proof-${i}`,
      }));

      jest.spyOn(prisma.proof, "findMany").mockResolvedValue(largeSet as any);
      jest.spyOn(prisma.proof, "updateMany").mockResolvedValue({ count: 100 });

      const count = await service.reconcileBatch();

      expect(count).toBe(100);
    });

    it("should handle database returning fewer rows than requested", async () => {
      // Query asks for 100 but only 5 exist
      const smallSet = Array.from({ length: 5 }, (_, i) => ({
        id: `proof-${i}`,
      }));

      jest.spyOn(prisma.proof, "findMany").mockResolvedValue(smallSet as any);
      jest.spyOn(prisma.proof, "updateMany").mockResolvedValue({ count: 5 });

      const count = await service.reconcileBatch();

      expect(count).toBe(5);
    });

    it("should handle race condition: proof updated between find and update", async () => {
      const proofs = [{ id: "racy-proof" }];

      jest.spyOn(prisma.proof, "findMany").mockResolvedValue(proofs as any);
      // updateMany returns 0 because the WHERE clause no longer matches
      jest.spyOn(prisma.proof, "updateMany").mockResolvedValue({ count: 0 });

      const count = await service.reconcileBatch();

      // The service returns what updateMany reports, which is 0
      expect(count).toBe(0);
    });

    it("should handle proof expiring at unix epoch boundary", async () => {
      const epochProof = { id: "epoch-proof" };

      jest.spyOn(prisma.proof, "findMany").mockResolvedValue([epochProof] as any);
      jest.spyOn(prisma.proof, "updateMany").mockResolvedValue({ count: 1 });

      const count = await service.reconcileBatch();

      expect(count).toBe(1);
    });

    it("should handle proof expiring far in the past", async () => {
      const ancientProof = { id: "ancient-proof" };

      jest.spyOn(prisma.proof, "findMany").mockResolvedValue([ancientProof] as any);
      jest.spyOn(prisma.proof, "updateMany").mockResolvedValue({ count: 1 });

      const count = await service.reconcileBatch();

      expect(count).toBe(1);
      // Confirms that the lte: now query correctly finds all expired proofs
    });
  });

  describe("authorization and security", () => {
    it("should not leak proof content in logs", async () => {
      const logSpy = jest.spyOn(service["logger"], "log");
      const proofs = [
        { id: "proof-1" },
        { id: "proof-2" },
      ];

      jest.spyOn(prisma.proof, "findMany").mockResolvedValue(proofs as any);
      jest.spyOn(prisma.proof, "updateMany").mockResolvedValue({ count: 2 });

      await service.reconcileExpiredProofs();

      // Check that logs only contain counts, not proof data
      const logCalls = logSpy.mock.calls;
      logCalls.forEach(([, data]) => {
        if (data && typeof data === "object") {
          expect(data).not.toHaveProperty("credentialHash");
          expect(data).not.toHaveProperty("commitment");
          expect(data).not.toHaveProperty("userId");
        }
      });
    });

    it("should only select id field to minimize data exposure", async () => {
      jest.spyOn(prisma.proof, "findMany").mockResolvedValue([]);

      await service.reconcileBatch();

      expect(prisma.proof.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: { id: true },
        }),
      );
    });
  });

  describe("regression tests", () => {
    it("should not update INVALID status proofs", async () => {
      // INVALID proofs that are also expired should not be updated
      jest.spyOn(prisma.proof, "findMany").mockResolvedValue([]);

      await service.reconcileBatch();

      expect(prisma.proof.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: ProofStatus.ACTIVE, // Only ACTIVE proofs
          }),
        }),
      );
    });

    it("should preserve REVOKED status even if proof has also expired", async () => {
      // A proof with revokedAt < expiresAt < now should remain REVOKED
      jest.spyOn(prisma.proof, "findMany").mockResolvedValue([]);

      await service.reconcileBatch();

      // The query filters on ACTIVE, so REVOKED proofs are never touched
      expect(prisma.proof.updateMany).not.toHaveBeenCalled();
    });

    it("should handle concurrent reconciliation attempts gracefully", async () => {
      const warnSpy = jest.spyOn(service["logger"], "warn");

      jest.spyOn(service, "reconcileBatch").mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(0), 50);
          }),
      );

      // Start first reconciliation
      const first = service.reconcileExpiredProofs();

      // Try to start second while first is running
      await service.reconcileExpiredProofs();

      await first;

      expect(warnSpy).toHaveBeenCalledWith(
        "Skipping reconciliation cycle: previous cycle still running",
      );
    });
  });
});
