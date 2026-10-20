# Ledger finality for payment sync

Payment sync keeps a **checkpoint** per wallet. A checkpoint says that
Horizon's payments feed for the wallet, up to a given paging token, sat in
ledger *N*, and that ledger *N* had hash *H*. Each later sync proves that claim
again before it trusts anything past it. If the claim no longer holds, the
stored payments came from a ledger view that has since been replaced or is
inconsistent. Those payments are then held from proof issuance until a
consistent view has confirmed them again.

The code lives in three places:

| Layer | File |
|---|---|
| Pure rules: TOID decoding, divergence checks, ordering, coverage | [`ledger-finality.ts`](../src/stellar/ledger-finality.ts) |
| Checkpoint persistence, holds, reconciliation | [`payment-finality.service.ts`](../src/payments/payment-finality.service.ts) |
| Sync orchestration | [`payments.service.ts`](../src/payments/payments.service.ts) |

## Sync modes

| Mode | When | Horizon read |
|---|---|---|
| `initial` | The wallet has no checkpoint | Newest first, bounded (the existing behaviour). The newest record becomes the first checkpoint. |
| `resume` | The checkpoint was just re-proved | Oldest first (`order=asc`), starting at the checkpoint cursor. A page bound can only cut off records that lie ahead of the cursor the read returns, so no gap is ever left behind it. |
| `reconcile` | The checkpoint diverged | Newest first, stopped at the window floor and capped at `STELLAR_FINALITY_RECONCILIATION_MAX_PAGES`. |

A normal restart re-proves the checkpoint with `GET /ledgers/{seq}` and
`GET /operations/{id}`, then resumes forward from it. No page is read until
the checkpoint has been re-proved.

## Divergence

| Reason | Detected |
|---|---|
| `ledger_hash_mismatch` | The checkpoint ledger's hash has changed |
| `ledger_missing` | Horizon no longer has the checkpoint ledger |
| `checkpoint_record_missing` | Horizon no longer has the operation the checkpoint is anchored to |
| `checkpoint_record_replaced` | That operation id now names a different transaction or paging position |
| `out_of_order` | A read returned records out of paging order, or a forward read returned a record at or behind its own cursor |
| `record_replaced` | An operation that is already stored now belongs to a different transaction or a different wallet owner |

The first four reasons are found before any page is read. The last two are
found after the read and before any row is written. **A read that diverges
writes nothing.**

On divergence, the checkpoint moves to `DIVERGED` and every tracked payment
for that wallet in the history window gets `finalityHoldAt` set. The window is
`checkpoint ledger - STELLAR_FINALITY_HISTORY_LEDGERS` up to the head. Proof
issuance refuses held payments (`PAYMENT_NOT_ELIGIBLE`, "pending ledger
reconciliation"). The owner's payment responses expose `finalityHeld`.

## Reconciliation

A reconciliation read that passes the ordering check counts as a consistent
view:

- Every payment it returns is written and released from its hold.
- A payment whose operation id now belongs to a different transaction or owner
  is rebuilt from Horizon. Its classification resets to `UNKNOWN`, because
  the owner classified a different payment.
- A held payment that falls inside the ledgers the read covered, but was not
  returned, is **orphaned**: `isEligible = false`, and it stays held. If a later
  consistent view returns it again, it is released.

When every held payment in the window is either confirmed or orphaned, the
checkpoint is re-anchored to the newest confirmed payment and returns to
`VERIFIED`. If the window is deeper than one read allows, the read's cursor is
stored as `reconciliationCursor` and the next sync continues from there.

## Guarantees

- **Idempotent.** Holds are range updates guarded by `finalityHoldAt IS NULL`.
  Checkpoint transitions are guarded by the row's `version`. Repeating a sync
  against the same view changes nothing, and only the sync that performed the
  transition writes the audit record.
- **Bounded.** Payments older than the history window are final: they are
  never held, orphaned or re-read. One reconciliation read is capped at the
  configured page count.
- **Concurrent syncs.** Two syncs of the same wallet cannot both advance the
  checkpoint. The sync that loses the race reports `unverified` and leaves the
  winner's checkpoint alone.
- **Private.** The audit events `payment.ledger.diverged` and
  `payment.ledger.reconciled` carry only reasons, ledger numbers and counts.
  They never carry addresses, amounts, memos or transaction hashes.

## Limits

- Payments synced before this feature have no `ledgerSequence`. They sit
  outside finality tracking until a later read writes them again.
- A proof that was already issued is not revoked when a payment behind it is
  later orphaned. The `payment.ledger.reconciled` audit event records the
  orphan count so operators can follow up.
- Eligibility of payments behind the checkpoint is not re-derived on each
  sync, because a resumed read only returns new records.

## Sync response

`POST /payments/sync` now includes a `finality` object:

```json
{ "status": "verified", "heldPayments": 0, "orphanedPayments": 0 }
```

`status` is one of `verified`, `unverified`, `reconciling` or `diverged`. When
it is `reconciling` or `diverged`, a `reason` from the table above is included.
