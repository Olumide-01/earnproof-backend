# Employment-continuity proofs

`POST /api/v1/proofs/employment-continuity` issues an `EMPLOYMENT_CONTINUITY`
proof. It states that corroborated income payments from one verified employer
source cover a completed run of consecutive UTC calendar months, within a
documented gap tolerance.

Policy version: `earnproof.employment-continuity.policy.v1`
Credential schema: `earnproof.employment-continuity.v1`
Implementation: [`employment-continuity.policy.ts`](../src/proofs/employment-continuity.policy.ts),
[`proofs.service.ts`](../src/proofs/proofs.service.ts) (`createEmploymentContinuityProof`).

## Policy v1

| Rule | Definition |
|---|---|
| Period bucketing | UTC calendar months (`calendar-month-utc`). Each month is half-open, `[1st 00:00:00.000Z, next 1st 00:00:00.000Z)`. Local time zones play no part. |
| Window | `observedPeriods` consecutive months starting at `periodStart`. `periodStart` must be exactly the first instant of a UTC month. `2026-02-01T00:00:00+01:00` is 31 January 23:00 UTC and is rejected. |
| Minimum observation length | 3 months. The maximum is 24. |
| Completed months only | The window's exclusive end must not be after the request time. |
| Tolerated gaps | At most 1 month may have no counted payment. |
| Coverage of both ends | The first and the last month must each contain a counted payment, so the observation spans the whole window. |
| Payment assignment | A payment's `occurredAt` places it in exactly one month, or outside the window. It can never count toward two months. |
| Duplicates | A repeated Stellar operation id counts once, at its earliest timestamp. Several payments in one month cover that month once. |
| Bound | At most 2,000 payments are evaluated. More is refused with `422 CONTINUITY_LIMIT_EXCEEDED` rather than truncated. |

A rule failure returns `422 CONTINUITY_NOT_SATISFIED`. Window input errors
return `400 INVALID_INPUT` before any lookup.

## One trusted employer source

All counted payments come from the single trusted source named in the request,
in one asset. The employer is resolved exactly as for
[employer-payment proofs](employer-payment-proof.md#employer-identity-matching):

- an `ACTIVE` source owned by the caller,
- linked to an `ACTIVE` issuer of an `ACTIVE` organization,
- not an address registered to a different issuer.

A payment only counts if the issuer corroborates it: either the payer is the
issuer's own registered account, or the issuer has an active `PAYMENT`
attestation for that payment. Payments from any other address, including an
earlier payer address the employer no longer uses, are never counted.

## Transactional enforcement

Inside the issuing transaction the service does the following, all with
`SELECT ... FOR SHARE`:

1. Re-reads the source, issuer and organization.
2. Re-reads every counted payment and its attestation.
3. Drops anything that no longer qualifies.
4. Re-evaluates the rule on the locked rows.

The proof is committed only if the rule still holds. A revocation or
reclassification that opens a second gap in the meantime therefore prevents
issuance.

## Disclosure and policy versioning

The credential claim contains:

- `employerIssuerId`, the asset, `periodStart`, `periodEnd`
- `periodUnit`, `observedPeriods`, `toleratedMissingPeriods`
- `continuous: true`
- `policyVersion`

It does not contain payment dates, amounts, senders, memos, operation ids,
transaction hashes, or which months were covered or missing.
`ProofClaim.disclosurePolicy` additionally stores `includedPaymentsDigest`, a
keyed HMAC over the counted operation ids, for audit only.

The policy parameters are embedded in each credential, and verification
rebuilds the credential only from what was stored. It never consults the
current constants. A later policy version (for example, a different gap
tolerance) therefore cannot change what an issued proof asserts. Any change to
a parameter above requires a new policy version string.
