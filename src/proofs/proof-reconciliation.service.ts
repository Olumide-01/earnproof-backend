import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { ProofStatus } from "@prisma/client";
import { StructuredLogger } from "../common/logger";
import { PrismaService } from "../database/prisma.service";
import { ContractAnchoringService } from "./contract-anchoring.service";

/**
 * Maximum number of proofs to reconcile per cycle to bound execution time.
 */
const RECONCILE_BATCH_SIZE = 50;

/**
 * Maximum number of events to process per reconciliation cycle.
 */
const MAX_EVENTS_PER_CYCLE = 100;

/**
 * Maximum ledger range to backfill in a single cycle.
 */
const MAX_BACKFILL_LEDGERS = 1000;

/**
 * How long to cache checkpoint updates to avoid excessive writes.
 */
const CHECKPOINT_UPDATE_THROTTLE_MS = 30_000;

/**
 * ProofReconciliationService
 * 
 * Reconciles live proof contract state into backend projections.
 * Runs every 2 minutes to sync authoritative on-chain state.
 * 
 * Key responsibilities:
 * - Process contract events (revocation, expiry, archival)
 * - Sync proof status with authoritative contract state  
 * - Quarantine conflicts that cannot be resolved automatically
 * - Maintain bounded reconciliation checkpoints
 * - Ensure verification fails closed when on-chain state is invalid
 * 
 * This extends existing contract anchoring rather than replacing it.
 */
@Injectable()
export class ProofReconciliationService {
  private readonly logger = new StructuredLogger(ProofReconciliationService.name);
  private readonly enabled: boolean;
  private readonly contractId: string;
  private readonly network: string;
  private lastCheckpointUpdate = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly anchoring: ContractAnchoringService,
    private readonly config: ConfigService,
  ) {
    this.enabled = config.get<boolean>("contractAnchoring.enabled") ?? false;
    this.contractId = config.get<string>("contractAnchoring.proofRegistryContractId") ?? "";
    this.network = config.get<string>("stellar.network") ?? "testnet";
  }

  @Interval(2 * 60_000) // Every 2 minutes
  async reconcile(): Promise<void> {
    if (!this.enabled || !this.contractId) {
      return;
    }

    try {
      const checkpoint = await this.getOrCreateCheckpoint();
      
      // For MVP, focus on reconciling existing anchored proofs rather than event indexing
      // Event indexing would require access to Horizon streaming or ledger scanning
      await this.reconcileAnchoredProofs();
      
      await this.updateCheckpointIfThrottled(checkpoint);
      
    } catch (error) {
      this.logger.error("Proof reconciliation cycle failed", {
        error: error instanceof Error ? error.message : String(error),
        contractId: this.contractId,
        network: this.network,
      });
    }
  }

  /**
   * Reconcile proofs that have been anchored on-chain.
   * 
   * This is the core safety mechanism: ensure local proof state
   * matches authoritative on-chain state, especially for revocations.
   */
  private async reconcileAnchoredProofs(): Promise<void> {
    const anchoredProofs = await this.prisma.proof.findMany({
      where: {
        contractTransactionHash: { not: null },
        status: { in: [ProofStatus.ACTIVE, ProofStatus.REVOKED] },
      },
      select: {
        id: true,
        status: true,
        contractTransactionHash: true,
        updatedAt: true,
      },
      take: RECONCILE_BATCH_SIZE,
      orderBy: { updatedAt: "asc" }, // Prioritize least recently updated
    });

    let reconciledCount = 0;
    let conflictCount = 0;

    for (const proof of anchoredProofs) {
      try {
        const result = await this.reconcileProofState(proof);
        if (result.reconciled) {
          reconciledCount++;
        }
        if (result.conflict) {
          conflictCount++;
        }
      } catch (error) {
        this.logger.warn("Failed to reconcile individual proof", {
          proofId: proof.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (anchoredProofs.length > 0) {
      this.logger.log("Proof reconciliation cycle completed", {
        proofCount: anchoredProofs.length,
        reconciledCount,
        conflictCount,
        contractId: this.contractId,
      });
    }
  }

  /**
   * Reconcile a single proof's state against authoritative contract state.
   */
  private async reconcileProofState(proof: {
    id: string;
    status: ProofStatus;
    contractTransactionHash: string | null;
    updatedAt: Date;
  }): Promise<{ reconciled: boolean; conflict: boolean }> {
    if (!proof.contractTransactionHash) {
      return { reconciled: false, conflict: false };
    }

    // Get authoritative on-chain state
    const contractStatus = await this.anchoring.getProofStatus(proof.id);
    
    if (!contractStatus.checked) {
      // Could not reach contract - skip for now
      this.logger.debug("Contract status check unavailable", {
        proofId: proof.id,
        reason: contractStatus.reason,
      });
      return { reconciled: false, conflict: false };
    }

    // Apply reconciliation rules based on local vs contract state
    if (proof.status === ProofStatus.ACTIVE) {
      if (contractStatus.revoked) {
        // Auto-repair: on-chain revoked but locally active
        await this.prisma.proof.update({
          where: { id: proof.id },
          data: { 
            status: ProofStatus.REVOKED, 
            revokedAt: new Date(),
          },
        });
        
        this.logger.warn("Auto-repaired proof status: marked REVOKED", {
          proofId: proof.id,
          previousStatus: proof.status,
          contractRevoked: contractStatus.revoked,
          contractValid: contractStatus.valid,
        });
        
        return { reconciled: true, conflict: false };
        
      } else if (!contractStatus.valid) {
        // Contract says invalid but not revoked - needs manual review
        await this.quarantineConflict({
          proofId: proof.id,
          conflictType: "STATE_MISMATCH",
          contractState: { revoked: contractStatus.revoked, valid: contractStatus.valid },
          localState: { status: proof.status },
          reason: "Contract reports invalid but not revoked while local status is ACTIVE",
        });
        
        this.logger.error("Quarantined proof state conflict", {
          proofId: proof.id,
          localStatus: proof.status,
          contractRevoked: contractStatus.revoked,
          contractValid: contractStatus.valid,
        });
        
        return { reconciled: false, conflict: true };
      }
      
    } else if (proof.status === ProofStatus.REVOKED) {
      if (!contractStatus.revoked) {
        // Local revoked but contract not revoked - need to re-anchor revocation
        await this.enqueueRevocationIntent(proof.id);
        
        this.logger.warn("Re-enqueued revocation for proof", {
          proofId: proof.id,
          localStatus: proof.status,
          contractRevoked: contractStatus.revoked,
        });
        
        return { reconciled: true, conflict: false };
      }
    }

    // States are consistent - no action needed
    return { reconciled: false, conflict: false };
  }

  /**
   * Quarantine a reconciliation conflict for manual review.
   */
  private async quarantineConflict(conflict: {
    proofId: string;
    conflictType: "STATE_MISMATCH" | "UNKNOWN_EVENT_VERSION" | "REORG_DETECTED" | "CONTRACT_REPLACEMENT" | "INVALID_TRANSITION";
    contractState: any;
    localState: any;
    reason: string;
  }): Promise<void> {
    try {
      await this.prisma.reconciliationConflict.create({
        data: {
          resourceType: "proof",
          resourceId: conflict.proofId,
          contractId: this.contractId,
          network: this.network,
          conflictType: conflict.conflictType,
          status: "QUARANTINED",
          contractState: conflict.contractState,
          localState: conflict.localState,
          metadata: { reason: conflict.reason },
        },
      });
    } catch (error) {
      this.logger.error("Failed to quarantine conflict", {
        proofId: conflict.proofId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Re-enqueue a revocation intent for a proof.
   */
  private async enqueueRevocationIntent(proofId: string): Promise<void> {
    try {
      // Check if revocation intent already exists
      const existing = await this.prisma.anchoringIntent.findFirst({
        where: {
          proofId,
          operation: "REVOKE",
        },
      });

      if (existing?.status === "PENDING" || existing?.status === "PROCESSING") {
        // Already pending
        return;
      }

      if (existing) {
        // Reset existing intent to pending
        await this.prisma.anchoringIntent.update({
          where: { id: existing.id },
          data: {
            status: "PENDING",
            permanentError: false,
            lastErrorSafe: null,
            nextRetryAt: new Date(),
          },
        });
      } else {
        // Create new revocation intent
        await this.prisma.anchoringIntent.create({
          data: {
            proofId,
            operation: "REVOKE",
            status: "PENDING",
          },
        });
      }
    } catch (error) {
      this.logger.error("Failed to enqueue revocation intent", {
        proofId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get or create reconciliation checkpoint.
   */
  private async getOrCreateCheckpoint() {
    return await this.prisma.proofReconciliationCheckpoint.upsert({
      where: { id: "proof_reconciliation" },
      create: {
        id: "proof_reconciliation",
        contractId: this.contractId,
        network: this.network,
        syncState: "PENDING",
      },
      update: {},
    });
  }

  /**
   * Update checkpoint if enough time has passed (throttling).
   */
  private async updateCheckpointIfThrottled(checkpoint: any): Promise<void> {
    const now = Date.now();
    if (now - this.lastCheckpointUpdate < CHECKPOINT_UPDATE_THROTTLE_MS) {
      return;
    }

    try {
      await this.prisma.proofReconciliationCheckpoint.update({
        where: { id: checkpoint.id },
        data: {
          lastSyncedAt: new Date(),
          syncState: "SYNCED",
        },
      });
      
      this.lastCheckpointUpdate = now;
    } catch (error) {
      this.logger.warn("Failed to update reconciliation checkpoint", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get current reconciliation status for observability.
   */
  async getReconciliationStatus() {
    if (!this.enabled) {
      return {
        enabled: false,
        reason: "Contract anchoring disabled",
      };
    }

    try {
      const checkpoint = await this.prisma.proofReconciliationCheckpoint.findUnique({
        where: { id: "proof_reconciliation" },
      });

      const conflictCount = await this.prisma.reconciliationConflict.count({
        where: {
          resourceType: "proof",
          status: "QUARANTINED",
        },
      });

      return {
        enabled: true,
        contractId: this.contractId,
        network: this.network,
        lastSyncedAt: checkpoint?.lastSyncedAt?.toISOString() ?? null,
        syncState: checkpoint?.syncState ?? "UNKNOWN",
        quarantinedConflicts: conflictCount,
      };
    } catch (error) {
      return {
        enabled: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Manually trigger reconciliation for a specific proof (for testing/ops).
   */
  async reconcileProof(proofId: string): Promise<{ success: boolean; message: string }> {
    if (!this.enabled) {
      return { success: false, message: "Contract anchoring disabled" };
    }

    try {
      const proof = await this.prisma.proof.findUnique({
        where: { id: proofId },
        select: {
          id: true,
          status: true,
          contractTransactionHash: true,
          updatedAt: true,
        },
      });

      if (!proof) {
        return { success: false, message: "Proof not found" };
      }

      if (!proof.contractTransactionHash) {
        return { success: false, message: "Proof not anchored on-chain" };
      }

      const result = await this.reconcileProofState(proof);
      
      if (result.conflict) {
        return { success: true, message: "Proof reconciled - conflict quarantined for review" };
      } else if (result.reconciled) {
        return { success: true, message: "Proof reconciled successfully" };
      } else {
        return { success: true, message: "Proof already in sync" };
      }

    } catch (error) {
      this.logger.error("Manual proof reconciliation failed", {
        proofId,
        error: error instanceof Error ? error.message : String(error),
      });
      
      return { 
        success: false, 
        message: `Reconciliation failed: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }
}