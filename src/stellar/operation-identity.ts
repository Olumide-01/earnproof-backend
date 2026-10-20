/**
 * Canonical identity for an indexed Stellar payment.
 *
 * A Stellar transaction can carry up to 100 operations, so a transaction hash
 * alone does not identify a payment: two payment operations in the same
 * transaction share a hash but are distinct events. The identity that is safe to
 * index and de-duplicate on is the triple `(network, transactionHash,
 * operationIndex)` — the same triple whether the payment arrived from a live
 * sync, a reorg replay, or a historical backfill.
 *
 * Horizon exposes each operation's globally-unique id as a TOID (Total Order
 * ID): a 64-bit integer packing the ledger sequence, the transaction's
 * application order within that ledger, and the operation's index within the
 * transaction. The operation index is the low 12 bits, which is what lets this
 * module recover the index deterministically from the id Horizon already
 * returns — no extra request, and the same value every time.
 *
 * See https://developers.stellar.org/docs/encyclopedia/ledger-headers#toid for
 * the TOID layout.
 */

/** Bits of a TOID reserved for the operation index (the low 12). */
const OPERATION_INDEX_BITS = 12n;
const OPERATION_INDEX_MASK = (1n << OPERATION_INDEX_BITS) - 1n; // 0xFFF

/** A TOID is an unsigned 64-bit integer, so its decimal form is at most 20 digits. */
const TOID_PATTERN = /^[0-9]{1,20}$/;
const MAX_UINT64 = (1n << 64n) - 1n;

/** The canonical identity of an indexed payment. */
export interface PaymentIdentity {
  network: string;
  transactionHash: string;
  operationIndex: number;
}

/**
 * The operation index encoded in a Horizon operation id (TOID), or `null` when
 * the id is not a well-formed TOID.
 *
 * `null` is a signal to the caller — a sync must never fabricate an index, and a
 * backfill must report the row as ambiguous rather than guess one.
 */
export function operationIndexFromToid(operationId: string): number | null {
  if (typeof operationId !== "string" || !TOID_PATTERN.test(operationId)) {
    return null;
  }

  let toid: bigint;
  try {
    toid = BigInt(operationId);
  } catch {
    return null;
  }
  if (toid < 0n || toid > MAX_UINT64) return null;

  return Number(toid & OPERATION_INDEX_MASK);
}

/**
 * A stable string key for a payment identity, for in-memory de-duplication
 * (a backfill detecting collisions, a sync coalescing a replayed page).
 *
 * The network and hash are lower-cased and the index appended with separators
 * that cannot occur in either component, so two identities collide in the map
 * exactly when they are the same payment.
 */
export function paymentIdentityKey(identity: PaymentIdentity): string {
  return `${identity.network.toLowerCase()}|${identity.transactionHash.toLowerCase()}|${identity.operationIndex}`;
}

/** Outcome of resolving a legacy payment row's canonical identity. */
export type LegacyIdentityOutcome =
  | { kind: "resolved"; operationIndex: number }
  | { kind: "ambiguous"; reason: string };

/**
 * Resolve the operation index for a legacy payment during backfill, or report
 * why it cannot be resolved.
 *
 * The only deterministic source is the stored Horizon operation id. A row whose
 * id is not a TOID (hand-seeded data, a schema from before this field existed)
 * cannot have its index recovered, so it is reported as ambiguous for an
 * operator to resolve — the migration never invents an index.
 */
export function resolveLegacyOperationIndex(
  operationId: string,
): LegacyIdentityOutcome {
  const operationIndex = operationIndexFromToid(operationId);
  if (operationIndex === null) {
    return {
      kind: "ambiguous",
      reason: `operationId "${operationId}" is not a Horizon TOID; operation index cannot be derived`,
    };
  }
  return { kind: "resolved", operationIndex };
}
