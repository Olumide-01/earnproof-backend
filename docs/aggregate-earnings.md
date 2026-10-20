# Aggregate-earnings proofs

`POST /api/v1/proofs/aggregate-earnings` issues a credential that says a wallet
earned at least *X* of one asset during a period. The server computes *X* from
the caller's own payments under a versioned policy
(`earnproof.aggregate-earnings.policy.v1`), and the proof goes through the same
pipeline as every other proof type: persist, sign, verify and anchor.

| Layer | File |
|---|---|
| Policy (pure rules) | [`aggregate-earnings.policy.ts`](../src/proofs/aggregate-earnings.policy.ts) |
| Source selection (owner-scoped queries) | [`aggregate-earnings.calculator.ts`](../src/proofs/aggregate-earnings.calculator.ts) |
| Issuance and verification | [`proofs.service.ts`](../src/proofs/proofs.service.ts) |

## Policy v1

| Rule | Definition |
|---|---|
| Eligible payments | The caller's own payments that are classified `INCOME`, have `isEligible = true`, and are in the requested asset |
| Source scope | `income`: every eligible payment (default). `trusted_sources`: only payments from the caller's `ACTIVE` trusted sources. `verified_issuers`: only payments from `ACTIVE` registered issuers, optionally narrowed with `issuerIds`. |
| Assets | Exactly one distinct asset. More than one is refused with `AGGREGATION_CROSS_ASSET_UNSUPPORTED`, because no conversion policy (rate source, timestamp, rounding) exists. |
| Period | Half-open `[periodStart, periodEnd)`. A payment exactly at `periodEnd` belongs to the next period, so consecutive proofs never count a boundary payment twice. The period must be non-empty, at most 366 days long, and must not end in the future. |
| Duplicates | A payment counts once, identified by its Stellar operation id. The same operation with conflicting amounts is refused. |
| Count | At least 2 and at most 500 payments. With a single payment the aggregate would be a rounded copy of that payment's amount. Above the cap the request is refused, never truncated. |
| Normalisation | Amounts are Stellar decimals with at most 7 fractional digits, summed exactly as integer stroops. If any amount is unreadable, the whole proof is refused (`PAYMENT_NOT_ELIGIBLE`). |
| Rounding | The total is floored to `roundingIncrement` (`0.0000001`, `0.01`, `1` (default), `10`, `100`, `1000`), so the disclosed figure never overstates earnings. A total that floors to zero is refused. |

Given the same rows, the result is identical whatever order the database
returns them in. The property tests check this with shuffled and duplicated
inputs.

## What is disclosed

The credential's `claim` contains:

- `aggregateAmount`: the floored total
- the rounding mode and increment
- the asset
- the period and its boundary rule
- the source scope
- `qualifyingPaymentCount`
- `policyVersion`

It never contains:

- component payments or operation ids
- exact amounts or the exact total
- sender addresses
- issuer or trusted-source identities

Along with the claim, the server stores `inputsDigest`: an HMAC over the sorted
component operation ids and amounts, keyed by the credential signing secret.
Operators can re-derive the aggregate later for audit. The digest is never
returned by the API.

## Errors

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_INPUT` | The period is invalid, in the future, or longer than 366 days; `issuerIds` was sent without `sourceScope: verified_issuers`; or an issuer is unknown or inactive |
| 422 | `AGGREGATION_CROSS_ASSET_UNSUPPORTED` | More than one distinct asset |
| 422 | `AGGREGATION_INSUFFICIENT_PAYMENTS` | Fewer than 2 payments, no source matches the scope, or the total floors to zero |
| 422 | `AGGREGATION_LIMIT_EXCEEDED` | More than 500 payments; narrow the period |
| 422 | `PAYMENT_NOT_ELIGIBLE` | A payment amount cannot be read |

Error messages never contain amounts, addresses or ids.
