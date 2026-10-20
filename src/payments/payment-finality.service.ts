import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  PaymentSyncCheckpoint,
  PaymentSyncCheckpointStatus,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { HorizonReadOptions, HorizonReadResult } from "../stellar/horizon-client";
import {
  DivergenceReason,
  ORPHANED_HOLD_REASON,
  StoredOperation,
  checkpointDivergence,
  isReadOrdered,
  ledgerSequenceFromPagingToken,
  newestAnchor,
  pagingTokenFloorForLedger,
  reconciliationCoverageLedger,
  reconciliationFloorLedger,
  replacedOperationIds,
} from "../stellar/ledger-finality";
import { StellarService } from "../stellar/stellar.service";
import { NormalizedPayment } from "../stellar/stellar.types";

/**
 * How a sync relates to the wallet's last verified checkpoint.
 *
 * - `initial`: no checkpoint yet. A bounded newest-first read, as before
 *   finality tracking existed; the newest record becomes the first checkpoint.
 * - `resume`: the checkpoint was re-proved against Horizon just now. The read
 *   walks forward from it, so a bounded read never leaves a gap behind it.
 * - `reconcile`: the checkpoint diverged. Payments in the history window are
 *   held, and a bounded newest-first read down to the window floor decides
 *   which of them still exist. A window deeper than one read is continued from
 *   the stored reconciliation cursor on the next sync.
 */
export type SyncPlan =
  | { mode: "initial" }
  | { mode: "resume"; checkpoint: PaymentSyncCheckpoint }
  | {
      mode: "reconcile";
      checkpoint: PaymentSyncCheckpoint;
      floorLedger: number;
    };

export type FinalityStatus =
  /** The sync ended at a checkpoint Horizon has just confirmed. */
  | "verified"
  /** Payments were written, but no checkpoint could be established or advanced. */
  | "unverified"
  /** Reconciliation ran but the history window is not fully re-read yet. */
  | "reconciling"
  /** The ledger view is inconsistent; affected payments stay held. */
  | "diverged";

export interface FinalityOutcome {
  status: FinalityStatus;
  reason?: DivergenceReason;
  /** Payments whose proof issuance is paused after this sync. */
  heldPayments: number;
  /** Payments a complete reconciliation could not find on the ledger again. */
  orphanedPayments: number;
}

/** The identity a checkpoint is anchored to. */
type AnchorRecord = Pick<NormalizedPayment, "operationId" | "stellarTransactionHash"> & {
  pagingToken: string;
};

const DEFAULT_HISTORY_LEDGERS = 17_280;

/**
 * Rows not yet decided orphaned. Spelled out because SQL `NOT (reason = x)` is
 * NULL, not true, for a NULL reason, and would silently drop those rows.
 */
const NOT_ORPHANED = {
  OR: [
    { finalityHoldReason: null },
    { finalityHoldReason: { not: ORPHANED_HOLD_REASON } },
  ],
} satisfies Prisma.PaymentWhereInput;
const DEFAULT_RECONCILIATION_MAX_PAGES = 10;

/**
 * Persists and enforces Horizon checkpoint finality for payment sync.
 *
 * Every checkpoint transition is guarded by the row's `version`, so two syncs
 * of the same wallet cannot both advance it, and a sync that lost the race
 * leaves the winner's checkpoint alone instead of overwriting it with an older
 * position. Holds are plain column updates keyed by ledger range, so applying
 * them twice is the same as applying them once.
 *
 * Audit metadata carries reasons, ledger numbers and counts only: never an
 * address, amount, memo or transaction hash.
 */
@Injectable()
export class PaymentFinalityService {
  private readonly historyLedgers: number;
  private readonly reconciliationMaxPages: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellarService: StellarService,
    configService: ConfigService,
  ) {
    this.historyLedgers = positiveInt(
      configService.get<number>("stellar.finality.historyLedgers"),
      DEFAULT_HISTORY_LEDGERS,
    );
    this.reconciliationMaxPages = positiveInt(
      configService.get<number>("stellar.finality.reconciliationMaxPages"),
      DEFAULT_RECONCILIATION_MAX_PAGES,
    );
  }

  /**
   * Loads the wallet's checkpoint and re-proves it before anything is read.
   *
   * A divergence found here is recorded (and payments held) before the caller
   * fetches a single page, so nothing past a checkpoint Horizon no longer
   * agrees with is ever processed on the strength of it.
   */
  async plan(userId: string): Promise<SyncPlan> {
    const checkpoint = await this.prisma.paymentSyncCheckpoint.findUnique({
      where: { userId },
    });

    if (!checkpoint) return { mode: "initial" };
    if (checkpoint.status === PaymentSyncCheckpointStatus.DIVERGED) {
      return this.reconcilePlan(checkpoint);
    }

    const [ledger, operation] = await Promise.all([
      this.stellarService.fetchLedger(checkpoint.ledgerSequence),
      this.stellarService.fetchOperation(checkpoint.operationId),
    ]);
    const reason = checkpointDivergence(checkpoint, ledger, operation);
    if (reason) return this.diverge(userId, checkpoint, reason);

    return { mode: "resume", checkpoint };
  }

  readOptions(plan: SyncPlan): HorizonReadOptions {
    switch (plan.mode) {
      case "initial":
        return {};
      case "resume":
        return { order: "asc", cursor: plan.checkpoint.pagingToken };
      case "reconcile":
        return {
          order: "desc",
          minPagingToken: pagingTokenFloorForLedger(plan.floorLedger),
          maxPages: this.reconciliationMaxPages,
          ...(plan.checkpoint.reconciliationCursor
            ? { cursor: plan.checkpoint.reconciliationCursor }
            : {}),
        };
    }
  }

  /**
   * Checks a read against the plan it was made under, before any write.
   *
   * A resumed read must move strictly forward from the checkpoint and must not
   * contradict stored rows. A reconciliation read must be strictly newest-first,
   * or the coverage it claims cannot be trusted. An initial read has no prior
   * verified view to contradict, so only reconciliation-style rewrites apply.
   */
  inspect(
    plan: SyncPlan,
    read: Pick<HorizonReadResult, "payments">,
    stored: ReadonlyMap<string, StoredOperation>,
    ownerId: string,
  ): DivergenceReason | null {
    if (plan.mode === "resume") {
      if (!isReadOrdered(read.payments, "asc", plan.checkpoint.pagingToken)) {
        return "out_of_order";
      }
      if (replacedOperationIds(read.payments, stored, ownerId).length > 0) {
        return "record_replaced";
      }
    }
    if (plan.mode === "reconcile" && !isReadOrdered(read.payments, "desc")) {
      return "out_of_order";
    }
    return null;
  }

  /**
   * Rows a write should rebuild from Horizon rather than merely refresh.
   *
   * Only reached for a read that passed {@link inspect}; under `resume` a
   * replacement is a divergence and never gets this far.
   */
  replacements(
    read: Pick<HorizonReadResult, "payments">,
    stored: ReadonlyMap<string, StoredOperation>,
    ownerId: string,
  ): Set<string> {
    return new Set(replacedOperationIds(read.payments, stored, ownerId));
  }

  /**
   * Marks the checkpoint diverged and holds every tracked payment in the
   * history window behind it.
   */
  async diverge(
    userId: string,
    checkpoint: PaymentSyncCheckpoint,
    reason: DivergenceReason,
  ): Promise<SyncPlan> {
    const now = new Date();
    const floorLedger = reconciliationFloorLedger(checkpoint.ledgerSequence, this.historyLedgers);

    const next = await this.prisma.$transaction(async (tx) => {
      const transitioned = await tx.paymentSyncCheckpoint.updateMany({
        where: {
          id: checkpoint.id,
          version: checkpoint.version,
          status: PaymentSyncCheckpointStatus.VERIFIED,
        },
        data: {
          status: PaymentSyncCheckpointStatus.DIVERGED,
          divergenceReason: reason,
          divergedAt: now,
          reconciliationCursor: null,
          version: { increment: 1 },
        },
      });

      const current = await tx.paymentSyncCheckpoint.findUnique({
        where: { id: checkpoint.id },
      });

      // Hold only while the checkpoint is actually diverged. If a concurrent
      // sync already reconciled it, this sync's evidence describes a view that
      // has since been replaced and re-verified, and holds placed now would
      // never be released.
      if (current?.status !== PaymentSyncCheckpointStatus.DIVERGED) return current;

      const held = await tx.payment.updateMany({
        where: {
          userId,
          ledgerSequence: { gte: floorLedger },
          finalityHoldAt: null,
        },
        data: { finalityHoldAt: now, finalityHoldReason: reason },
      });

      // Only the sync that performed the transition records it; a concurrent
      // sync that lost the race still applied the (idempotent) holds above.
      if (transitioned.count === 1) {
        await tx.auditLog.create({
          data: {
            actorType: "system",
            action: "payment.ledger.diverged",
            resourceType: "payment_sync_checkpoint",
            resourceId: checkpoint.id,
            metadata: {
              reason,
              checkpointLedger: checkpoint.ledgerSequence,
              floorLedger,
              heldPayments: held.count,
            },
          },
        });
      }

      return current;
    });

    // Gone: a reconciliation found nothing to anchor to. Start from scratch.
    if (!next) return { mode: "initial" };
    // Re-verified by a concurrent sync: prove the newer checkpoint afresh
    // rather than resuming from one this sync never checked.
    if (next.status === PaymentSyncCheckpointStatus.VERIFIED) return this.plan(userId);
    return this.reconcilePlan(next);
  }

  /**
   * Records the outcome of a read the caller has already written.
   */
  async settle(
    userId: string,
    plan: SyncPlan,
    read: Pick<HorizonReadResult, "payments" | "stopReason" | "lastCursor">,
    counts: { rewritten: number },
  ): Promise<FinalityOutcome> {
    if (plan.mode === "reconcile") return this.settleReconciliation(userId, plan, read, counts);

    const anchor = anchorOf(newestAnchor(read.payments));

    if (plan.mode === "initial") {
      if (!anchor) return this.outcome(userId, "unverified");
      const established = await this.establish(userId, anchor);
      return this.outcome(userId, established ? "verified" : "unverified");
    }

    // resume: an empty forward read leaves the verified checkpoint where it is.
    if (!anchor) {
      await this.prisma.paymentSyncCheckpoint.updateMany({
        where: { id: plan.checkpoint.id, version: plan.checkpoint.version },
        data: { verifiedAt: new Date(), version: { increment: 1 } },
      });
      return this.outcome(userId, "verified");
    }

    const advanced = await this.advance(plan.checkpoint, anchor);
    return this.outcome(userId, advanced ? "verified" : "unverified");
  }

  /** The finality outcome of a read rejected by {@link inspect}. */
  diverged(userId: string, reason: DivergenceReason): Promise<FinalityOutcome> {
    return this.outcome(userId, "diverged", reason);
  }

  private async settleReconciliation(
    userId: string,
    plan: Extract<SyncPlan, { mode: "reconcile" }>,
    read: Pick<HorizonReadResult, "payments" | "stopReason" | "lastCursor">,
    counts: { rewritten: number },
  ): Promise<FinalityOutcome> {
    const coverageLedger = reconciliationCoverageLedger(
      read.payments,
      read.stopReason,
      plan.floorLedger,
    );
    const seen = read.payments.map((payment) => payment.operationId);

    // Held rows the read proves are gone from the ledger. They stay held, and
    // lose eligibility, so they cannot back a proof unless Horizon returns them.
    const orphaned =
      coverageLedger === Number.MAX_SAFE_INTEGER
        ? { count: 0 }
        : await this.prisma.payment.updateMany({
            where: {
              userId,
              finalityHoldAt: { not: null },
              ledgerSequence: { gte: coverageLedger },
              operationId: { notIn: seen },
              ...NOT_ORPHANED,
            },
            data: { isEligible: false, finalityHoldReason: ORPHANED_HOLD_REASON },
          });

    const undecided = await this.prisma.payment.count({
      where: {
        userId,
        finalityHoldAt: { not: null },
        ledgerSequence: { gte: plan.floorLedger },
        ...NOT_ORPHANED,
      },
    });

    if (undecided > 0) {
      // Continue below this read next time instead of re-reading the head.
      if (read.lastCursor) {
        await this.prisma.paymentSyncCheckpoint.updateMany({
          where: { id: plan.checkpoint.id, version: plan.checkpoint.version },
          data: { reconciliationCursor: read.lastCursor, version: { increment: 1 } },
        });
      }
      return this.outcome(userId, "reconciling", plan.checkpoint.divergenceReason);
    }

    // Every tracked payment in the window is now confirmed or orphaned, so the
    // newest confirmed payment is the head of a verified view — whichever
    // reconciliation read it came from.
    const anchor = await this.confirmedAnchor(userId);
    const completed = anchor
      ? await this.advance(plan.checkpoint, anchor, true)
      : // Nothing confirmed to anchor to. The next sync starts afresh.
        (await this.prisma.paymentSyncCheckpoint.deleteMany({
          where: { id: plan.checkpoint.id, version: plan.checkpoint.version },
        })).count === 1;

    if (!completed) {
      return this.outcome(userId, "reconciling", plan.checkpoint.divergenceReason);
    }

    await this.prisma.auditLog.create({
      data: {
        actorType: "system",
        action: "payment.ledger.reconciled",
        resourceType: "payment_sync_checkpoint",
        resourceId: plan.checkpoint.id,
        metadata: {
          reason: plan.checkpoint.divergenceReason,
          floorLedger: plan.floorLedger,
          confirmedPayments: read.payments.length,
          rewrittenPayments: counts.rewritten,
          orphanedPayments: orphaned.count,
        },
      },
    });

    return this.outcome(userId, "verified");
  }

  private reconcilePlan(checkpoint: PaymentSyncCheckpoint): SyncPlan {
    return {
      mode: "reconcile",
      checkpoint,
      floorLedger: reconciliationFloorLedger(checkpoint.ledgerSequence, this.historyLedgers),
    };
  }

  /**
   * The newest payment confirmed by a consistent read: not held, and
   * positioned on the ledger. Ties within a ledger are broken by paging token,
   * in code, because the column is text and would not sort numerically.
   */
  private async confirmedAnchor(userId: string): Promise<AnchorRecord | null> {
    const confirmed = {
      userId,
      finalityHoldAt: null,
      ledgerSequence: { not: null },
      pagingToken: { not: null },
    } satisfies Prisma.PaymentWhereInput;

    const newest = await this.prisma.payment.findFirst({
      where: confirmed,
      orderBy: { ledgerSequence: "desc" },
      select: { ledgerSequence: true },
    });
    if (!newest?.ledgerSequence) return null;

    const candidates = await this.prisma.payment.findMany({
      where: { ...confirmed, ledgerSequence: newest.ledgerSequence },
      select: { operationId: true, stellarTransactionHash: true, pagingToken: true },
    });

    let best: AnchorRecord | null = null;
    for (const row of candidates) {
      const candidate = anchorOf({ ...row, pagingToken: row.pagingToken ?? undefined });
      if (candidate && (!best || BigInt(candidate.pagingToken) > BigInt(best.pagingToken))) {
        best = candidate;
      }
    }
    return best;
  }

  /** Creates the first checkpoint. Loses quietly to a concurrent sync. */
  private async establish(userId: string, anchor: AnchorRecord): Promise<boolean> {
    const claim = await this.claimFor(anchor);
    if (!claim) return false;

    try {
      await this.prisma.paymentSyncCheckpoint.create({
        data: { userId, ...claim, verifiedAt: new Date() },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /**
   * Moves a checkpoint to `anchor`, only if nobody else moved it first and only
   * forward — except when completing a reconciliation, where the anchor is the
   * head of a freshly verified view and replaces whatever came before.
   */
  private async advance(
    checkpoint: PaymentSyncCheckpoint,
    anchor: AnchorRecord,
    completingReconciliation = false,
  ): Promise<boolean> {
    if (
      !completingReconciliation &&
      BigInt(anchor.pagingToken) <= BigInt(checkpoint.pagingToken)
    ) {
      return false;
    }

    const claim = await this.claimFor(anchor);
    if (!claim) return false;

    const moved = await this.prisma.paymentSyncCheckpoint.updateMany({
      where: { id: checkpoint.id, version: checkpoint.version },
      data: {
        ...claim,
        status: PaymentSyncCheckpointStatus.VERIFIED,
        divergenceReason: null,
        divergedAt: null,
        reconciliationCursor: null,
        verifiedAt: new Date(),
        version: { increment: 1 },
      },
    });
    return moved.count === 1;
  }

  /**
   * Binds an anchor record to its ledger hash. `null` when Horizon cannot
   * vouch for the ledger right now — the checkpoint then simply does not move.
   */
  private async claimFor(anchor: AnchorRecord) {
    const ledgerSequence = ledgerSequenceFromPagingToken(anchor.pagingToken);
    if (ledgerSequence === null) return null;

    let ledger;
    try {
      ledger = await this.stellarService.fetchLedger(ledgerSequence);
    } catch {
      return null;
    }
    if (!ledger || ledger.sequence !== ledgerSequence) return null;

    return {
      pagingToken: anchor.pagingToken,
      operationId: anchor.operationId,
      transactionHash: anchor.stellarTransactionHash,
      ledgerSequence,
      ledgerHash: ledger.hash,
    };
  }

  private async outcome(
    userId: string,
    status: FinalityStatus,
    reason?: string | null,
  ): Promise<FinalityOutcome> {
    const [heldPayments, orphanedPayments] = await Promise.all([
      this.prisma.payment.count({ where: { userId, finalityHoldAt: { not: null } } }),
      this.prisma.payment.count({
        where: { userId, finalityHoldReason: ORPHANED_HOLD_REASON },
      }),
    ]);
    return {
      status,
      ...(reason ? { reason: reason as DivergenceReason } : {}),
      heldPayments,
      orphanedPayments,
    };
  }
}

/** Narrows a record to an anchor, or `null` when it has no ledger position. */
function anchorOf(
  record: (Pick<NormalizedPayment, "operationId" | "stellarTransactionHash"> & {
    pagingToken?: string;
  }) | null,
): AnchorRecord | null {
  if (!record || ledgerSequenceFromPagingToken(record.pagingToken) === null) return null;
  return {
    operationId: record.operationId,
    stellarTransactionHash: record.stellarTransactionHash,
    pagingToken: record.pagingToken as string,
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
