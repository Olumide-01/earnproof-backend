# Payment Account Rotation

The **monitored payment account** is the Stellar account whose incoming
payments are indexed for a user. For users who never rotated it is their
wallet address, exactly as before. Rotation changes it with verified
ownership and an explicit checkpoint boundary, so the two accounts' histories
are never mixed.

This is distinct from [wallet rotation](authorization-matrix.md), which changes
the login identity.

Code: [`src/payments/payment-account-rotation.ts`](../src/payments/payment-account-rotation.ts)
(rules), [`src/payments/payment-account-rotation.service.ts`](../src/payments/payment-account-rotation.service.ts),
[`src/payments/payment-account.resolver.ts`](../src/payments/payment-account.resolver.ts).

## Protocol

| Step | Route (`/api/v1/payments/account-rotations`) | Effect |
|---|---|---|
| request | `POST /` `{ network, newAccountId, backfillFromLedger? }` | Single-use challenge, valid for `PAYMENT_ACCOUNT_ROTATION_CHALLENGE_TTL_MS`. |
| verify | `POST /:id/verify` `{ signature }` | The **new** account's SEP-53 signature over the challenge. |
| activate | `POST /:id/activate` `{ expectedVersion }` | Checkpoint handoff (below). |
| rollback | `POST /:id/rollback` `{ expectedVersion, reason }` | Restore the old account within the window. |
| cancel | `POST /:id/cancel` `{ expectedVersion }` | Abandon a rotation before activation. |
| read | `GET /:id`, `GET /current` | Own rotation; currently indexed account. |

### Accounts and networks cannot be confused

- `network` must equal this deployment's network, and the service refuses to
  start if `STELLAR_NETWORK` and `STELLAR_NETWORK_PASSPHRASE` disagree.
- The challenge binds the domain, network passphrase, user, current account,
  new account, rotation id, a fresh nonce and the expiry. Its first line is
  specific to this protocol, so a login or wallet-rotation signature can never
  be replayed here, and a testnet signature is useless on mainnet.
- `newAccountId` must be a plain Ed25519 account (`G…`, checksum verified);
  muxed (`M…`) and contract (`C…`) ids are refused.
- One active monitored account per user and network, and one user per
  network and account, are enforced by unique keys. An account that is another
  user's wallet or active payment account is refused — checked only *after*
  the signature verifies, so the endpoint cannot be used to probe which
  accounts are registered.

### No private key material

Only public account ids and signatures are accepted. Any value matching a
Stellar secret seed is refused with a fixed message before anything else
happens; it is never echoed, logged or stored. Unknown body fields (for
example `secretKey`) are rejected outright by the global validation pipe.
Audit records carry hashed account ids only.

## Checkpoint handoff (activation)

In one transaction:

1. The old account's checkpoint must be `VERIFIED`; a diverged history must be
   reconciled first (`409`, nothing changes, safe to retry).
2. The old account's epoch is retired. A user who never rotated gets an
   explicit retired epoch for their wallet, so the old history has a recorded
   end.
3. The new account becomes the active epoch.
4. The old checkpoint is captured on the rotation as its **final checkpoint**
   (paging token, operation, transaction, ledger sequence and hash) and
   deleted — conditional on its version, so a sync that advanced it meanwhile
   aborts the activation (`409`, retry). The new account is then synced from
   its own fresh checkpoint and never from the old account's cursor.
5. The **backfill plan** for the new account's earlier history is the
   inclusive range `[backfillFromLedger, finalLedgerSequence]`, clamped to the
   backfill worker's maximum span (keeping the most recent ledgers) and its
   minimum ledger. No requested start, no final checkpoint, or a start past the
   boundary means no backfill. The job records `accountId`, so it scans the new
   account even if the user's wallet changes later.

The old account's history is kept through its final checkpoint; nothing after
the boundary is read from it.

## Rollback

Allowed for an activated rotation until `rollbackDeadline`
(`activatedAt + PAYMENT_ACCOUNT_ROTATION_ROLLBACK_WINDOW_MS`; the deadline
itself is still allowed). It retires the new account, reactivates the old
one, deletes the new account's checkpoint, restores the old final checkpoint
(which the next sync re-proves against Horizon before trusting anything past
it), and cancels the planned backfill (immediately if pending, at the next
page boundary if running). A rotation superseded by a later one can no longer
be rolled back. Payments already indexed from the new account are kept: the
user proved control of it.

## Failure, stale state and replay

| Situation | Result |
|---|---|
| Challenge expired (`now ≥ expiresAt`), replayed, cancelled, or another user's | `401`, identical answer |
| Wrong signature, wrong signer, wrong network's message | `401`; the challenge is consumed and marked `FAILED` |
| Current account changed since the request | `409`, `FAILED` (`identity_changed`) |
| New account bound to another user | `409`, `FAILED` (`account_unavailable`) |
| Second request while one is open | `409`; an expired unverified challenge is closed as `EXPIRED` first and does not block |
| Stale `expectedVersion`, concurrent activation | `409`; exactly one activation wins |
| Rollback after the deadline, replayed, or superseded | `409` |

Consumption happens before any check, so a challenge can be attempted once.
A secret submitted as the signature is refused before consumption.

## Syncs that straddle a handoff

`POST /payments/sync` reads the active monitored account. If an activation or
rollback commits while a sync is reading, any checkpoint written since the
change is discarded after that sync, so the previous account's cursor can
never be resumed against the new account's feed. Payment rows are keyed by
operation id, so this costs at most a re-read, never a duplicate.

## Authorization

Bearer session; every route acts on the caller's own rotations only, and
another user's rotation id is answered like an unknown one (`404`, or `401`
for verify).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PAYMENT_ACCOUNT_ROTATION_CHALLENGE_TTL_MS` | `600000` | Challenge lifetime. |
| `PAYMENT_ACCOUNT_ROTATION_ROLLBACK_WINDOW_MS` | `86400000` | Rollback window after activation. |

## Compatibility

Additive migration. Users without a `PaymentMonitoredAccount` row keep their
wallet as the monitored account; `PaymentBackfillJob.accountId` is nullable
and existing jobs keep scanning the user's wallet. A later wallet (login)
rotation does not change an explicitly rotated payment account.
