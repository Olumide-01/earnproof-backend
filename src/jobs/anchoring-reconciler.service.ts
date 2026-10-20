import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import {
  AnchoringOperation,
  AnchoringStatus,
  ProofStatus,
  QuarantineDecision,
  QuarantineReasonCode,
} from "@prisma/client";
import { StructuredLogger } from "../common/logger";
import { PrismaService } from "../database/prisma.service";
import { ContractAnchoringService } from "../proofs/contract-anchoring.service";
import { JobExecutionService } from "./execution/job-execution.service";
import { workerIdentity } from "./execution/worker-identity";

/** Job identity recorded in the execution history for this synchronization job. */
const RECONCILER_JOB_NAME = "anchoring-reconciler";
const RECONCILER_JOB_VERSION = "1";

/**
 * Maximum number of proofs to reconcile per cycle to bound execution time.
 */
const RECONCILE_BATCH_SIZE = 20;

/**
 * Duration to hold the anchoring reconciliation lease (24 hours).
 * Sufficient for 5-min interval reconciliation jobs; gives ample time.
 */
const ANCHORING_RECONCILIATION_LEASE_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Unique identifier for the anchoring reconciliation job lease.
 * Used across all instances to coordinate single execution.
 */
const ANCHORING_RECONCILIATION_JOB_NAME = "anchoring_reconciliation";

/**
 * AnchoringReconcilerService
 *
 * Runs every 5 minutes. For proofs that have a confirmed on-chain transaction,
 * it calls getProofStatus and repairs disagreements according to this policy:
 *
 * | Local status | On-chain state              | Action                             |
 * |--------------|-----------------------------|------------------------------------|
 * | ACTIVE       | valid=true, revoked=false   | OK — no action                     |
 * | ACTIVE       | revoked=true                | Auto-repair: mark local REVOKED    |
 * | ACTIVE       | valid=false, revoked=false  | Flag manual: create QUARANTINED    |
 * |              |                             | AnchoringIntent for review         |
 * | REVOKED      | revoked=true                | OK — no action                     |
 * | REVOKED      | revoked=false               | Auto-repair: re-enqueue REVOKE     |
 *
 * Auto-repair cases are handled silently and logged at WARN.
 * Manual-attention cases are logged at ERROR and create a QUARANTINED intent
 * (reason MANUAL_REVIEW) so operators can find and redrive or abandon it.
 *
 * Secret safety: only proof IDs appear in structured logs; no signing key or
 * CLI credentials are ever logged or stored.
 *
 * Distributed coordination: With multiple instances, only one executes
 * reconciliation at a time via the distributed lease service.
 */
@Injectable()
export class AnchoringReconcilerService {
  private readonly logger = new StructuredLogger(AnchoringReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anchoring: ContractAnchoringService,
    private readonly config: ConfigService,
    /**
     * Optional so the existing unit tests that construct the reconciler with
     * three arguments keep working. When present, each reconcile cycle is
     * recorded in the durable execution history (issue #201).
     */
    @Optional() private readonly executions?: JobExecutionService,
  ) {}

  @Interval(5 * 60_000)
  async reconcile(): Promise<void> {
    if (!this.config.get<boolean>("contractAnchoring.enabled")) {
      return;
    }

    // Record the run so a missed or overlapping synchronization cycle is
    // diagnosable after the fact. The work is unchanged when no execution
    // service is wired.
    if (this.executions) {
      await this.executions.track(
        {
          jobName: RECONCILER_JOB_NAME,
          jobVersion: RECONCILER_JOB_VERSION,
          leaseOwner: workerIdentity(),
        },
        () => this.runReconcile(),
      );
      return;
    }

    await this.runReconcile();
  }

  private async runReconcile(): Promise<void> {
    const proofs = await this.prisma.proof.findMany({
      where: {
        contractTransactionHash: { not: null },
        status: { in: [ProofStatus.ACTIVE, ProofStatus.REVOKED] },
      },
      select: {
        id: true,
        status: true,
        contractTransactionHash: true,
      },
      take: RECONCILE_BATCH_SIZE,
      orderBy: { updatedAt: "asc" },
    });

    if (!leaseResult.acquired) {
      this.logger.debug(
        `Anchoring reconciliation lease held by another instance (${leaseResult.owner}); skipping reconciliation`,
      );
      return;
    }

    try {
      const proofs = await this.prisma.proof.findMany({
        where: {
          contractTransactionHash: { not: null },
          status: { in: [ProofStatus.ACTIVE, ProofStatus.REVOKED] },
        },
        select: {
          id: true,
          status: true,
          contractTransactionHash: true,
        },
        take: RECONCILE_BATCH_SIZE,
        orderBy: { updatedAt: "asc" },
      });

      for (const proof of proofs) {
        await this.reconcileProof(proof);
      }
    } finally {
      // Renewal: extend the lease before exiting
      await this.leaseService.renewLease(
        ANCHORING_RECONCILIATION_JOB_NAME,
        ANCHORING_RECONCILIATION_LEASE_DURATION_MS,
      );
    }
  }

  /**
   * Exposed for testing — reconciles a single proof by ID.
   */
  async reconcileProof(proof: {
    id: string;
    status: ProofStatus;
    contractTransactionHash: string | null;
  }): Promise<void> {
    if (!proof.contractTransactionHash) return;

    const onChain = await this.anchoring.getProofStatus(proof.id);

    if (!onChain.checked) {
      // Could not reach the contract — skip; the worker will retry on its own.
      this.logger.warn(
        `Reconciler could not check on-chain status for proof`,
        { proofId: proof.id, reason: onChain.reason },
      );
      return;
    }

    if (proof.status === ProofStatus.ACTIVE) {
      if (onChain.revoked) {
        // On-chain revoked but locally ACTIVE — auto-repair.
        await this.prisma.proof.update({
          where: { id: proof.id },
          data: { status: ProofStatus.REVOKED, revokedAt: new Date() },
        });
        this.logger.warn(
          `Reconciler auto-repaired proof: marked REVOKED (on-chain state was revoked=true)`,
          { proofId: proof.id, outcome: "auto_repaired" },
        );
      } else if (!onChain.valid) {
        // On-chain not valid and not revoked — ambiguous; flag for manual review.
        await this.flagForManualReview(
          proof.id,
          "reconciler: on-chain proof is neither valid nor revoked while local status is ACTIVE",
        );
        this.logger.error(
          `Reconciler flagged proof for manual attention: on-chain proof is invalid`,
          { proofId: proof.id, onChainValid: onChain.valid, onChainRevoked: onChain.revoked },
        );
      }
      // else: valid and not revoked — healthy, nothing to do.
    } else if (proof.status === ProofStatus.REVOKED) {
      if (!onChain.revoked) {
        // Locally revoked but on-chain not revoked — re-enqueue a REVOKE intent.
        await this.enqueueRevoke(proof.id);
        this.logger.warn(
          `Reconciler re-enqueued REVOKE for proof: locally REVOKED but on-chain revoked=false`,
          { proofId: proof.id, outcome: "requeued" },
        );
      }
      // else: both revoked — consistent, nothing to do.
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async flagForManualReview(
    proofId: string,
    reason: string,
  ): Promise<void> {
    // Only create one quarantined manual-review intent per proof to avoid flooding.
    const existing = await this.prisma.anchoringIntent.findFirst({
      where: {
        proofId,
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.QUARANTINED,
        permanentError: true,
        lastErrorSafe: reason,
      },
    });

    if (existing) return;

    await this.prisma.anchoringIntent.create({
      data: {
        proofId,
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.QUARANTINED,
        permanentError: true,
        lastErrorSafe: reason,
        quarantinedAt: new Date(),
        quarantineReasonCode: QuarantineReasonCode.MANUAL_REVIEW,
        quarantineDecision: QuarantineDecision.PENDING,
      },
    });
  }

  private async enqueueRevoke(proofId: string): Promise<void> {
    const existing = await this.prisma.anchoringIntent.findFirst({
      where: {
        proofId,
        operation: AnchoringOperation.REVOKE,
      },
    });

    if (
      existing?.status === AnchoringStatus.PENDING ||
      existing?.status === AnchoringStatus.PROCESSING
    ) {
      return;
    }

    if (existing) {
      await this.prisma.anchoringIntent.update({
        where: { id: existing.id },
        data: {
          status: AnchoringStatus.PENDING,
          permanentError: false,
          lastErrorSafe: null,
          nextRetryAt: new Date(),
        },
      });
    } else {
      await this.prisma.anchoringIntent.create({
        data: {
          proofId,
          operation: AnchoringOperation.REVOKE,
          status: AnchoringStatus.PENDING,
        },
      });
    }
  }
}
