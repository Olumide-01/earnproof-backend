# Ledger-range payment backfills

Operational recovery for payments the normal sync missed: an administrator
queues a rescan of **one user's incoming payments over an inclusive Stellar
ledger range**. A background worker runs the scan, so no API request waits on
Horizon.

Implementation: [`payment-backfill.service.ts`](../src/payments/payment-backfill.service.ts),
[`payment-backfill-worker.service.ts`](../src/jobs/payment-backfill-worker.service.ts),
[`payment-backfills.controller.ts`](../src/payments/payment-backfills.controller.ts).

## API (ADMIN only)

| Route | Effect |
|---|---|
| `POST /api/v1/payment-backfills` `{ userId, startLedger, endLedger }` | Persists a `PENDING` job. |
| `GET /api/v1/payment-backfills/:id` | Job status, checkpoint and counters. |
| `POST /api/v1/payment-backfills/:id/cancel` | Cancels the job (see below). |

Every route requires an `ADMIN` session. Requests and cancellations are
audited (`operator.payment_backfill_requested`,
`operator.payment_backfill_cancelled`) inside the same transaction as the
change, so an unaudited job cannot exist.

## Validation

| Rule | Value |
|---|---|
| `startLedger` | at least 2; genesis carries no payments |
| `endLedger` | at least `startLedger`, at most 2147483647 |
| Range size | at most **120960** ledgers inclusive, about one week |
| Overlap | Rejected with `409 CONFLICT` when an active (`PENDING` or `RUNNING`) job for the same user overlaps the range. The user row is locked (`FOR UPDATE`) while checking, so two concurrent requests cannot both pass. |

The range bounds are also enforced by a database CHECK constraint.

## How a job runs

Horizon paging tokens are TOIDs, `ledger << 32 | tx << 12 | op`, so a ledger
range maps exactly onto the half-open token range
`(startLedger << 32, (endLedger + 1) << 32)`. The worker:

1. **Claims** one job every 15 seconds with
   `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`. A job is claimable
   when it is `PENDING`, or `RUNNING` with an expired lease, and has no pending
   cancellation. Any number of instances can run the worker.
2. **Reads one page** (200 records) oldest-first, strictly after the job's own
   checkpoint, through a dedicated single-page Horizon read. That read never
   coalesces with, and never shares a cursor with, the forward sync.
3. **Commits the page and the checkpoint in one transaction.** The commit only
   succeeds while this worker still owns the lease and no cancellation has been
   requested; otherwise the page is rolled back. The checkpoint is the last
   in-range paging token and only moves forward, because records at or before
   it are ignored.
4. After 5 pages it **yields** (back to `PENDING`, progress kept). The job
   **completes** when a record at or beyond the range end appears or the feed
   is exhausted.

**Restart.** A worker that dies leaves the checkpoint at its last committed
page. Once the 2-minute lease expires, the next claim resumes from there.

**Failures.** A Horizon or database fault releases the job for retry and
records only a fault category in `lastErrorSafe`. `attempts` counts consecutive
claims without progress and resets on every committed page. After 5 such
claims the job is `FAILED`.

## Deduplication and isolation from normal sync

- Payments are written with `createMany({ skipDuplicates: true })` on the
  unique operation id. An operation that normal sync already stored is left
  exactly as it is and counted in `duplicatesSkipped`. The backfill never
  updates an existing payment.
- New rows are stored like forward-synced ones: amount encrypted,
  `classification = UNKNOWN`, and `isEligible` from the supported-asset list.
  Memos are not fetched, since one Horizon call per transaction would make a
  job unbounded; normal sync enriches them if it later sees the payment.
- A backfill writes only its own job row and new payments. It never reads or
  writes any forward-sync cursor, so it cannot move the normal forward cursor,
  backward or otherwise. A test asserts the complete set of writes.

## Cancellation policy

- `PENDING`: cancelled immediately.
- `RUNNING`: flagged. The worker stops at the next page boundary, because that
  page's commit is refused and rolled back, and marks the job `CANCELLED`. If
  the worker is gone, the job is finalized once its lease expires.
- Pages committed before cancellation are **kept**. They contain only real
  payments that were missing.
- `COMPLETED`, `CANCELLED` and `FAILED` jobs cannot be cancelled (`409`).
