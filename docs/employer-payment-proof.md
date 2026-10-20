# Employer-payment proofs

`POST /api/v1/proofs/employer-payment` issues an `EMPLOYER_PAYMENT` proof: a
minimal credential stating that the authenticated wallet received at least one
eligible income payment from a verified employer during a bounded period.

Policy version: `earnproof.employer-payment.policy.v1`
Credential schema: `earnproof.employer-payment.v1`
Implementation: [`employer-payment.policy.ts`](../src/proofs/employer-payment.policy.ts),
[`proofs.service.ts`](../src/proofs/proofs.service.ts) (`createEmployerPaymentProof`).

## Request

| Field | Rule |
|---|---|
| `trustedSourceId` | One of the caller's trusted sources. Unknown and non-owned ids both return `404 NOT_FOUND`. |
| `assetCode`, `assetIssuer` | The asset the payment must use. Omit `assetIssuer` for native XLM. |
| `periodStart`, `periodEnd` | Half-open `[periodStart, periodEnd)`. Non-empty, at most 366 days, and `periodEnd` not in the future. Violations return `400 INVALID_INPUT` before any lookup. |
| `expiresInDays` | 1 to 365, default 30. |

The caller cannot choose the payment. Selection is server-side and
deterministic (see below).

## Employer identity matching

A trusted source is created by the user, so on its own it proves nothing about
who paid. A source identifies an employer only when every rule holds:

1. The trusted source is `ACTIVE` and owned by the caller.
2. It is linked to an issuer, and that issuer is `ACTIVE`.
3. The issuer's organization is `ACTIVE`.
4. The payer address is not registered as a *different* issuer's Stellar
   account. If it is, the address is claimed by two employers and the request
   fails with `422 EMPLOYER_SOURCE_AMBIGUOUS`.
5. The issuer corroborates the payer address, in one of two ways:
   - `issuer_account`: the payer address is the issuer's own registered
     Stellar account.
   - `issuer_attestation`: the issuer holds an `ACTIVE`, unrevoked, unexpired
     `PAYMENT` attestation for the caller's wallet hash whose
     `paymentReferenceHash` is `sha256:<hex sha256 of the operation id>` for
     that exact payment. This is the same reference format payment-receipt
     proofs use.

Rules 1 to 3 failing, or no candidate payment being corroborated, returns
`422 EMPLOYER_SOURCE_UNTRUSTED`. Error messages never contain addresses, issuer
ids or payment identifiers.

## Eligible payments and deterministic selection

A candidate payment belongs to the caller and comes from the trusted source's
address. It uses the requested asset, is classified `INCOME` with
`isEligible = true`, and has `occurredAt` inside `[periodStart, periodEnd)`.
If there is no candidate, the request returns
`422 EMPLOYER_PAYMENT_NOT_FOUND`.

Candidates are ordered newest first, with ties broken by the Stellar operation
id. The first corroborated candidate is selected. The database query and the
in-memory selection both use this order, so repeated requests select the same
payment whatever order the database returns rows in. At most 200 candidates
are considered.

## Transactional enforcement

The issuing transaction re-reads, with `SELECT ... FOR SHARE`:

- the trusted source, issuer and organization (one locked join),
- the corroborating attestation, when there is one,
- the selected payment.

It refuses to commit if any of them has stopped qualifying. The shared lock
blocks a concurrent status change until the proof is committed, and waits for
one already in flight. A revocation therefore either commits first, and
issuance is refused, or commits after the proof exists. Issuance never uses
stale trust state.

## Disclosure

The credential claim contains `employerIssuerId`, `corroboration`, the asset,
the period, `periodBoundary: "start-inclusive-end-exclusive"`,
`paymentObserved: true` and `policyVersion`.

It never contains the amount, sender address, memo, transaction hash,
operation id or payment date.

`ProofClaim.disclosurePolicy` additionally stores
`paymentReferenceDigest`, an HMAC of the operation id keyed with the credential
signing secret. It links the proof to its payment for audit and is never
returned.

## Verification

`GET /proofs/:id/verify` rebuilds the credential from the stored proof and
claim. The policy version and employer identity are read from the stored claim,
so later policy changes do not change what an issued proof means. If the stored
claim was altered, the canonical hash no longer matches and the result is
`INVALID_SIGNATURE`.
