import { isPagingToken } from "./horizon-client";
import {
  HorizonLedgerSummary,
  HorizonOperationSummary,
  NormalizedPayment,
} from "./stellar.types";

/**
 * Pure rules for Horizon checkpoint finality.
 *
 * A sync checkpoint is a claim: "Horizon's payments feed for this wallet, up to
 * this paging token, sat in ledger N whose hash was H". Every later sync
 * re-proves the claim before trusting anything past it. When the claim no
 * longer holds, the ledger view the stored payments came from has been replaced
 * or is inconsistent, and those payments must not back a proof until they have
 * been re-read from a consistent view.
 *
 * Nothing here touches the database or the network, so every divergence rule
 * can be exercised with plain values.
 */

export type DivergenceReason =
  /** The checkpoint ledger now has a different hash. */
  | "ledger_hash_mismatch"
  /** Horizon no longer knows the checkpoint ledger. */
  | "ledger_missing"
  /** The operation the checkpoint was anchored to no longer exists. */
  | "checkpoint_record_missing"
  /** The checkpoint operation id now names a different transaction or position. */
  | "checkpoint_record_replaced"
  /** A read returned records out of paging order, or behind its own cursor. */
  | "out_of_order"
  /** A stored operation now belongs to a different transaction. */
  | "record_replaced";

export const DIVERGENCE_REASONS: readonly DivergenceReason[] = [
  "ledger_hash_mismatch",
  "ledger_missing",
  "checkpoint_record_missing",
  "checkpoint_record_replaced",
  "out_of_order",
  "record_replaced",
];

/** Hold reason for a payment a complete reconciliation could not find again. */
export const ORPHANED_HOLD_REASON = "orphaned";

export interface CheckpointClaim {
  pagingToken: string;
  operationId: string;
  transactionHash: string;
  ledgerSequence: number;
  ledgerHash: string;
}

/** Bits of a TOID below the ledger sequence (transaction order + operation index). */
const LEDGER_SHIFT = BigInt(32);

/**
 * The ledger a paging token's operation closed in, or `null` when the token
 * does not encode one.
 *
 * Horizon's operation paging token is the operation's TOID, whose high 32 bits
 * are the ledger sequence. Ledger 0 does not exist, so a token that decodes to
 * it is not a real operation position.
 */
export function ledgerSequenceFromPagingToken(token: string | undefined | null): number | null {
  if (typeof token !== "string" || !isPagingToken(token)) return null;
  const sequence = Number(BigInt(token) >> LEDGER_SHIFT);
  return sequence > 0 && sequence <= 0x7fffffff ? sequence : null;
}

/** The lowest paging token any operation in `ledgerSequence` can have. */
export function pagingTokenFloorForLedger(ledgerSequence: number): string {
  return (BigInt(Math.max(1, Math.trunc(ledgerSequence))) << LEDGER_SHIFT).toString();
}

/**
 * First ledger a divergence can reach, given the configured history window.
 *
 * Bounded below by ledger 1: the window never reaches before genesis, and a
 * non-positive window is treated as zero so the checkpoint ledger itself is
 * always included.
 */
export function reconciliationFloorLedger(checkpointLedger: number, historyLedgers: number): number {
  const window = Number.isFinite(historyLedgers) ? Math.max(0, Math.trunc(historyLedgers)) : 0;
  return Math.max(1, checkpointLedger - window);
}

/**
 * Re-proves a checkpoint against what Horizon reports now.
 *
 * The ledger hash is checked first: it is the strongest statement, and a
 * mismatch there explains any operation-level difference that follows.
 */
export function checkpointDivergence(
  checkpoint: CheckpointClaim,
  ledger: HorizonLedgerSummary | null,
  operation: HorizonOperationSummary | null,
): DivergenceReason | null {
  if (!ledger || ledger.sequence !== checkpoint.ledgerSequence) return "ledger_missing";
  if (ledger.hash.toLowerCase() !== checkpoint.ledgerHash.toLowerCase()) {
    return "ledger_hash_mismatch";
  }
  if (!operation) return "checkpoint_record_missing";
  if (
    operation.id !== checkpoint.operationId ||
    operation.transactionHash !== checkpoint.transactionHash ||
    operation.pagingToken !== checkpoint.pagingToken
  ) {
    return "checkpoint_record_replaced";
  }
  return null;
}

/**
 * Whether a read's records are in the order Horizon promised.
 *
 * Every record must carry a paging token that moves strictly in the walk
 * direction. A forward (`asc`) read that resumes from a checkpoint must also
 * stay strictly past it: a record at or before the checkpoint in a forward read
 * means Horizon served a view in which the checkpoint is not where it was.
 *
 * Duplicate operations never reach this check — the client drops them — so
 * equality here is a genuine ordering fault, not a replayed page.
 */
export function isReadOrdered(
  payments: readonly Pick<NormalizedPayment, "pagingToken">[],
  order: "asc" | "desc",
  afterPagingToken?: string,
): boolean {
  let previous: bigint | undefined =
    order === "asc" && afterPagingToken !== undefined && isPagingToken(afterPagingToken)
      ? BigInt(afterPagingToken)
      : undefined;

  for (const payment of payments) {
    if (payment.pagingToken === undefined || !isPagingToken(payment.pagingToken)) return false;
    const current = BigInt(payment.pagingToken);
    if (previous !== undefined) {
      if (order === "asc" ? current <= previous : current >= previous) return false;
    }
    previous = current;
  }
  return true;
}

export interface StoredOperation {
  transactionHash: string;
  userId: string;
}

/**
 * Operation ids whose stored row no longer matches what Horizon reports.
 *
 * A row is replaced when its operation now belongs to a different transaction,
 * or — because an operation id is a ledger position, not a payment identity —
 * when that position now pays a different wallet owner.
 *
 * Returned sorted so every caller sees the same order regardless of how the
 * database or Horizon happened to order rows.
 */
export function replacedOperationIds(
  incoming: readonly Pick<NormalizedPayment, "operationId" | "stellarTransactionHash">[],
  stored: ReadonlyMap<string, StoredOperation>,
  ownerId: string,
): string[] {
  const replaced = new Set<string>();
  for (const payment of incoming) {
    const row = stored.get(payment.operationId);
    if (!row) continue;
    if (row.transactionHash !== payment.stellarTransactionHash || row.userId !== ownerId) {
      replaced.add(payment.operationId);
    }
  }
  return [...replaced].sort();
}

/**
 * The record a new checkpoint is anchored to: the one furthest along the feed.
 *
 * Chosen by paging token rather than array position so the choice does not
 * depend on the order Horizon returned records in. `null` when no record has a
 * token that encodes a real ledger.
 */
export function newestAnchor(payments: readonly NormalizedPayment[]): NormalizedPayment | null {
  let best: NormalizedPayment | null = null;
  let bestToken: bigint | undefined;
  for (const payment of payments) {
    if (ledgerSequenceFromPagingToken(payment.pagingToken) === null) continue;
    const token = BigInt(payment.pagingToken as string);
    if (bestToken === undefined || token > bestToken) {
      best = payment;
      bestToken = token;
    }
  }
  return best;
}

/**
 * Lowest ledger a newest-first reconciliation read proved it covered.
 *
 * A read that ran out of feed, or that crossed the floor, covered everything
 * down to the floor. A read cut short by a page or record bound only covered
 * the ledgers above its oldest record; payments at or below that stay undecided.
 */
export function reconciliationCoverageLedger(
  payments: readonly NormalizedPayment[],
  stopReason: string,
  floorLedger: number,
): number {
  if (stopReason === "exhausted" || stopReason === "ledger_bound") return floorLedger;

  let oldest: number | null = null;
  for (const payment of payments) {
    const ledger = ledgerSequenceFromPagingToken(payment.pagingToken);
    if (ledger !== null && (oldest === null || ledger < oldest)) oldest = ledger;
  }
  // Nothing positioned was read: nothing below the head is proven. Otherwise
  // the oldest ledger itself may have been split by the page bound, so only the
  // ledgers above it are proven complete.
  return oldest === null ? Number.MAX_SAFE_INTEGER : Math.max(floorLedger, oldest + 1);
}
