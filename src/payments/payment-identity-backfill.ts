import {
  paymentIdentityKey,
  resolveLegacyOperationIndex,
} from "../stellar/operation-identity";

/**
 * Deterministic planning for the payment canonical-identity backfill (#206).
 *
 * The planning is separated from the database so it is pure and testable: given
 * the legacy rows and the deployment's network, it decides which rows can be
 * assigned a canonical identity, which are ambiguous, and which would conflict —
 * making the same decision every run, so the backfill is idempotent and
 * restartable. The runnable script (scripts/backfill-payment-identity.ts) only
 * reads rows, hands them here, and applies the resulting updates.
 */

/** A legacy payment row as read for backfill. */
export interface LegacyPaymentRow {
  id: string;
  operationId: string;
  stellarTransactionHash: string;
  /** Already-assigned index, if a previous backfill run set it. */
  operationIndex: number | null;
  /** Already-assigned network, if a previous backfill run set it. */
  network: string | null;
}

/** An update to apply to one row. */
export interface BackfillUpdate {
  id: string;
  network: string;
  operationIndex: number;
}

/** A row that cannot be assigned an identity, with the reason why. */
export interface BackfillAmbiguity {
  id: string;
  reason: string;
}

export interface BackfillPlan {
  /** Rows to update with a resolved identity. */
  updates: BackfillUpdate[];
  /** Rows whose identity cannot be derived and need operator attention. */
  ambiguous: BackfillAmbiguity[];
  /** Rows already carrying the correct identity; nothing to do. */
  unchanged: number;
}

/**
 * Plan the backfill for a set of rows under one network.
 *
 * A row is:
 *  - unchanged, if it already has this network and a matching operation index;
 *  - ambiguous, if its operationId is not a TOID (index cannot be derived), or
 *    if the identity it would take is already claimed by another row in this set
 *    (a genuine conflict the migration must not resolve by guessing);
 *  - otherwise an update to (network, operationIndex).
 */
export function planPaymentIdentityBackfill(
  rows: LegacyPaymentRow[],
  network: string,
): BackfillPlan {
  const updates: BackfillUpdate[] = [];
  const ambiguous: BackfillAmbiguity[] = [];
  let unchanged = 0;

  // Identity -> the row id that first claimed it, to detect conflicts.
  const claimed = new Map<string, string>();

  for (const row of rows) {
    const outcome = resolveLegacyOperationIndex(row.operationId);
    if (outcome.kind === "ambiguous") {
      ambiguous.push({ id: row.id, reason: outcome.reason });
      continue;
    }

    const operationIndex = outcome.operationIndex;
    const key = paymentIdentityKey({
      network,
      transactionHash: row.stellarTransactionHash,
      operationIndex,
    });

    const priorClaimant = claimed.get(key);
    if (priorClaimant && priorClaimant !== row.id) {
      ambiguous.push({
        id: row.id,
        reason: `identity ${key} already claimed by payment ${priorClaimant}; conflicting legacy rows must be resolved manually`,
      });
      continue;
    }
    claimed.set(key, row.id);

    if (row.network === network && row.operationIndex === operationIndex) {
      unchanged += 1;
      continue;
    }

    updates.push({ id: row.id, network, operationIndex });
  }

  return { updates, ambiguous, unchanged };
}
