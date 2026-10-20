import { Injectable, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { ProofStatus } from "@prisma/client";
import { StructuredLogger } from "../common/logger";
import { PrismaService } from "../database/prisma.service";

/**
 * Maximum number of proofs to reconcile per cycle to bound execution time.
 * Keeps a single tick from monopolising the database or running longer than
 * the interval.
 */
const RECONCILE_BATCH_SIZE = 100;

/**
 * Maximum concurrent batches per reconciliation cycle.
 * Each batch is a single transaction updating at most RECONCILE_BATCH_SIZE rows.
 * If more expired proofs exist, they are deferred to the next cycle.
 */
const MAX_BATCHES_PER_CYCLE = 10;

/**
 * ProofExpirationReconcilerService
 *
 * Runs every 5 minutes. Finds proofs that have passed their expiresAt timestamp
 * but still have status=ACTIVE, and transitions them to status=EXPIRED.
 *
 * Design properties:
 *
 * **Idempotent.** The query filters on status=ACTIVE AND expiresAt <= NOW(),
 * so re-running the job on the same proof is a no-op. Safe under overlapping
 * executions or restarts.
 *
 * **Bounded.** Processes at most RECONCILE_BATCH_SIZE * MAX_BATCHES_PER_CYCLE
 * proofs per tick. Large backlogs drain over multiple cycles without locking
 * the database indefinitely.
 *
 * **Index-optimised.** Uses the existing @@index([expiresAt]) and
 * @@index([userId, status]) indexes from the Proof model. Queries are
 * efficient even with millions of proofs.
 *
 * **Revocation-aware.** A proof that was revoked before it expired remains
 * REVOKED. A proof that expires while revoked stays REVOKED. The job only
 * transitions ACTIVE → EXPIRED.
 *
 * **Eventually consistent.** Verification logic already computes expiration
 * at read time (expiresAt <= NOW()), so a proof that hasn't been reconciled
 * yet still behaves correctly. This job exists to improve query performance
 * and dashboard accuracy, not correctness.
 *
 * Configuration: Disabled by default. Enable via
 * PROOF_EXPIRATION_RECONCILIATION_ENABLED=true in .env.
 *
 * Secret safety: only proof IDs and counts appear in logs; no credential
 * hashes or user data are logged.
 */
@Injectable()
export class ProofExpirationReconcilerService implements OnApplicationShutdown {
  private readonly logger = new StructuredLogger(
    ProofExpirationReconcilerService.name,
  );
  private running = false;
  private enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.enabled =
      this.config.get<string>("PROOF_EXPIRATION_RECONCILIATION_ENABLED", "false") ===
      "true";
    if (this.enabled) {
      this.logger.log("Proof expiration reconciliation enabled");
    } else {
      this.logger.log("Proof expiration reconciliation disabled");
    }
  }

  async onApplicationShutdown() {
    if (this.running) {
      this.logger.warn("Shutting down while reconciliation cycle in progress");
    }
  }

  /**
   * Runs every 5 minutes. Reconciles newly expired proofs in bounded batches.
   */
  @Interval(5 * 60_000)
  async reconcileExpiredProofs(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    if (this.running) {
      this.logger.warn(
        "Skipping reconciliation cycle: previous cycle still running",
      );
      return;
    }

    this.running = true;
    let totalReconciled = 0;
    let batchesExecuted = 0;

    try {
      const cycleStart = Date.now();

      // Process up to MAX_BATCHES_PER_CYCLE batches
      for (let i = 0; i < MAX_BATCHES_PER_CYCLE; i++) {
        const batchReconciled = await this.reconcileBatch();
        totalReconciled += batchReconciled;
        batchesExecuted++;

        // If we processed fewer than RECONCILE_BATCH_SIZE, we've drained
        // the eligible set and can exit early.
        if (batchReconciled < RECONCILE_BATCH_SIZE) {
          break;
        }
      }

      const cycleMs = Date.now() - cycleStart;

      if (totalReconciled > 0) {
        this.logger.log(
          "Reconciled expired proofs",
          {
            reconciled: totalReconciled,
            batches: batchesExecuted,
            durationMs: cycleMs,
          },
        );
      }
    } catch (error) {
      this.logger.error("Proof expiration reconciliation cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Reconciles a single batch of expired proofs.
   * Returns the number of proofs updated.
   *
   * Exposed as a separate method for testing.
   */
  async reconcileBatch(): Promise<number> {
    const now = new Date();

    // Find expired ACTIVE proofs in a single query using the expiresAt index.
    // Order by expiresAt ASC so we process the oldest expirations first.
    const expiredProofs = await this.prisma.proof.findMany({
      where: {
        status: ProofStatus.ACTIVE,
        expiresAt: { lte: now },
      },
      select: { id: true },
      take: RECONCILE_BATCH_SIZE,
      orderBy: { expiresAt: "asc" },
    });

    if (expiredProofs.length === 0) {
      return 0;
    }

    const expiredIds = expiredProofs.map((p) => p.id);
    const result = await this.prisma.proof.updateMany({
      where: {
        id: { in: expiredIds },
        status: ProofStatus.ACTIVE, // Belt-and-suspenders: ensure still ACTIVE
      },
      data: {
        status: ProofStatus.EXPIRED,
        // updatedAt is handled by @updatedAt in schema
      },
    });

    // Status transition: cancel pending reminders for expired proofs
    if (this.prisma.proofExpirationReminderDelivery) {
      await this.prisma.proofExpirationReminderDelivery.updateMany({
        where: {
          proofId: { in: expiredIds },
          status: { in: ["SCHEDULED", "ENQUEUED"] },
        },
        data: {
          status: "CANCELLED",
          cancelledAt: now,
          cancellationReason: "Proof expired during reconciliation",
        },
      });
    }

    return result.count;
  }

  /**
   * Exposed for testing: allows tests to trigger a reconciliation cycle
   * immediately without waiting for the interval.
   */
  async reconcile(): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_CYCLE; i++) {
      const count = await this.reconcileBatch();
      total += count;
      if (count < RECONCILE_BATCH_SIZE) break;
    }
    return total;
  }
}
