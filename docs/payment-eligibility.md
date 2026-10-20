# Payment eligibility decisions

Each payment's eligibility is recorded as a **decision**. A decision stores:

- the versioned policy that produced it
- the factors that policy evaluated
- one reason code per factor
- what triggered the evaluation

`Payment.isEligible` still exists and always mirrors the active decision, so
existing clients and proof issuance behave exactly as before.

| Layer | File |
|---|---|
| Policy (pure) | [`eligibility-policy.ts`](../src/payments/eligibility-policy.ts) |
| Recording, re-evaluation, explanation | [`payment-eligibility.service.ts`](../src/payments/payment-eligibility.service.ts) |

## Policy `payment-eligibility.v1`

| Factor | Reason codes | Effect |
|---|---|---|
| Asset on the active supported-asset list | `ASSET_SUPPORTED` / `ASSET_NOT_SUPPORTED` | allow / deny: decides `eligible` |
| Classification | `CLASSIFICATION_INCOME`, `CLASSIFICATION_NOT_INCOME`, `CLASSIFICATION_EXCLUDED` | info |
| Sender is an active trusted source | `SOURCE_TRUSTED` / `SOURCE_NOT_TRUSTED` | info |
| That trusted source is linked to an active issuer | `SOURCE_ISSUER_VERIFIED` | info |

In v1, `eligible` depends on the asset alone. That is the rule `isEligible`
has always followed. Classification and trust don't change `eligible`, but
they do decide which proofs a payment can back, and the explanation reports
that as `usage`:

- `paymentReceipt` requires eligible and not `EXCLUDED`
- `incomeProofs` requires eligible and `INCOME`

These are the same checks proof issuance applies.

Factors are booleans plus the classification. A decision never stores a memo,
an amount, or a counterparty address.

## When decisions are made

| Trigger | When |
|---|---|
| `sync` | Every payment written by `POST /payments/sync` |
| `classification_changed` | `PATCH /payments/:id/classification` |
| `trusted_source_changed` | A trusted source is created, deleted, or its issuer link changes; re-evaluates the owner's payments from that sender |
| `asset_policy_changed` | Operators call `PaymentEligibilityService.reevaluateBatch({ trigger: "asset_policy_changed" })` after changing the supported-asset list |
| `policy_migration` | The same batch after a policy version bump, and on demand when a payment is explained that has no decision under the current policy |

`reevaluateBatch` is bounded to 200 payments per call by default, and 1,000 at
most. It returns a `nextCursor`: keep calling with that cursor until it is
`null`.

## Guarantees

- **Latest decision is deterministic.** The same policy and factors always
  produce the same decision and `inputsHash`. When a re-evaluation's hash
  matches the active decision, nothing is written, so routine re-syncs don't
  grow the history.
- **History stays auditable.** Superseding a decision sets `supersededAt` and
  clears `isActive`. Rows are never deleted.
- **No conflicting active decisions.** A unique index on
  `(paymentId, isActive)`, with `isActive` restricted to `TRUE` or `NULL` by a
  CHECK constraint, lets PostgreSQL refuse a second active decision.
  Superseding the old decision and inserting the new one happen in one
  transaction. When two evaluations run concurrently, the loser's insert fails
  and rolls back, and the winner's decision stands.

## Explanation API

`GET /api/v1/payments/:id/eligibility` is owner-scoped. Another user's payment
returns 404 and is not evaluated. The response contains:

- `eligible`, `policyVersion`, `evaluatedAt` and `trigger`
- `factors`
- `reasons`: each with `code`, `effect` and `message`
- `usage`
- `history`: the 20 most recent decisions, newest first
