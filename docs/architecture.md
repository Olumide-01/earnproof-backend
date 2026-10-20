# Architecture and domain invariants

A maintained map of what each module owns, how the critical flows run, and which
invariants hold — with the code and tests that enforce them.

The codebase accumulated auth, organizations, issuers, payments, proofs,
credentials, anchoring, API keys, webhooks, and jobs without a single place
recording ownership. This is that place. Every claim here points at a file, and
every invariant points at the code that enforces it and the test that would fail
if it stopped. Prose that cannot point at something is not an invariant; it is a
hope.

- ADR index: [`docs/adr/`](adr/)
- Module wiring: [`src/app.module.ts`](../src/app.module.ts)
- Data model: [`prisma/schema.prisma`](../prisma/schema.prisma)

## Contents

- [System shape](#system-shape)
- [Modules](#modules)
- [Critical flows](#critical-flows)
- [Domain invariants](#domain-invariants)
- [Trust boundaries](#trust-boundaries)
- [Protected data](#protected-data)
- [Transaction ownership](#transaction-ownership)
- [Extension rules](#extension-rules)

## System shape

```
                    ┌──────────────────────────────────────────┐
  wallet ──────────▶│  auth        session issue / revoke      │
                    ├──────────────────────────────────────────┤
  integrator ──────▶│  api-keys    scoped machine access       │
                    ├──────────────────────────────────────────┤
                    │  organizations ─▶ issuers                │
                    │  payments  ◀── stellar (Horizon)         │
                    │  proofs    ──▶ credentials               │
                    │       │                                  │
                    │       ├──▶ jobs ──▶ Soroban contracts    │
                    │       └──▶ webhooks ──▶ integrator URLs  │
                    ├──────────────────────────────────────────┤
                    │  audit  health  common  database         │
                    └──────────────────────────────────────────┘
```

Three layers, and the direction of dependency matters:

1. **Edge** — `auth`, `api-keys`. Establish who is calling.
2. **Domain** — `organizations`, `issuers`, `payments`, `proofs`, `credentials`,
   `trusted-sources`, `approvals`, `schemas`. Own product state.
2. **Domain** — `users`, `organizations`, `issuers`, `payments`, `proofs`,
   `credentials`, `trusted-sources`. Own product state.
3. **Infrastructure** — `common`, `config`, `database`, `stellar`, `audit`,
   `jobs`, `webhooks`, `health`. Serve the layers above.

Domain modules may depend on infrastructure. Infrastructure must not depend on
domain — a `common` guard that imported `proofs` would make the guard
untestable in isolation and couple every module to the proof lifecycle.

## Modules

Each entry lists responsibilities, public interface, owned tables, and
dependencies it must not take.

### `auth` — [`src/auth/`](../src/auth/)

Wallet-signature authentication and revocable sessions.

| | |
|---|---|
| **Public interface** | `POST /auth/challenge`, `/auth/verify`, `/auth/logout`, `/auth/rotate`, `GET /auth/sessions`, `POST /auth/wallet-rotation`, `/auth/wallet-rotation/:id/complete` |
| **Owned tables** | `WalletChallenge`, `AuthSession`, `WalletRotation` |
| **Key files** | [`auth.service.ts`](../src/auth/auth.service.ts), [`session.service.ts`](../src/auth/session.service.ts), [`wallet-rotation.service.ts`](../src/auth/wallet-rotation.service.ts), [`auth-token.service.ts`](../src/auth/auth-token.service.ts), [`cleanup.job.ts`](../src/auth/cleanup.job.ts) |
| **Must not depend on** | `proofs`, `payments`, `credentials`, `webhooks` |

Only a SHA-256 hash of the bearer token is stored. The raw token exists in the
response body and nowhere else — not in the database, not in a log.

A session is bound to the wallet it was issued to (`AuthSession.walletHash`),
and `AuthGuard` refuses one whose wallet no longer matches the account. Wallet
rotation therefore ends every session of the previous wallet structurally, not
only through the revocation it performs: a session inserted by a login that
raced the rotation is refused as well. Rotation requires fresh signatures from
both the current and the replacement key over messages bound to the network,
the origin and a single-use nonce; the rotation is consumed before either
signature is checked, and the identity change, session revocation and audit
record commit together.

### `api-keys` — [`src/api-keys/`](../src/api-keys/)

Machine-to-machine credentials with explicit scopes.

| | |
|---|---|
| **Public interface** | `/api-keys` CRUD, `integration-auth.controller.ts` |
| **Owned tables** | `ApiKey`, `ApiKeyScopeAssignment` |
| **Key files** | [`api-key.service.ts`](../src/api-keys/api-key.service.ts), [`api-keys.controller.ts`](../src/api-keys/api-keys.controller.ts) |
| **Must not depend on** | `proofs`, `payments`, `credentials` |

Keys are organization-scoped. Every lookup filters on `organizationId`
alongside the key id ([`api-key.service.ts:228`](../src/api-keys/api-key.service.ts#L228)),
so a valid key from one organization cannot address another's resources.

### `organizations` — [`src/organizations/`](../src/organizations/)

Tenant boundary. Every multi-tenant resource hangs off an organization.

| | |
|---|---|
| **Public interface** | `/organizations` CRUD and membership; ADMIN-only `POST /organizations/:id/archive`, `/restore`, `PUT/DELETE /organizations/:id/legal-hold`, `GET /organizations/:id/deletion-eligibility`, `DELETE /organizations/:id` |
| **Public interface** | `/organizations` CRUD and membership, `GET /organizations/:id/usage` (quota usage) |
| **Owned tables** | `Organization` |
| **Key files** | [`organizations.service.ts`](../src/organizations/organizations.service.ts), [`organization-lifecycle.service.ts`](../src/organizations/organization-lifecycle.service.ts) |
| **Must not depend on** | `proofs`, `payments`, `credentials`, `jobs` (the retention policy table in `jobs/retention` is the one exception: it defines the minimum archive period) |

Archival disables an organization's privileged operations through
`Organization.archivedAt`, which every such path reads on each call. Deletion
turns the row into a tombstone rather than removing it, so issuers,
attestations and audit records keep resolving. See
[data retention](data-retention.md#organization-lifecycle).

### `users` — [`src/users/`](../src/users/)

Self-service profile and administrative account lifecycle.

| | |
|---|---|
| **Public interface** | `GET/PATCH /users/me`; ADMIN-only `GET /users/:id`, `PATCH /users/:id/status`, `PATCH /users/:id/role` |
| **Owned tables** | `User` (profile, status and role columns) |
| **Key files** | [`users.service.ts`](../src/users/users.service.ts), [`account-status.policy.ts`](../src/auth/account-status.policy.ts) |
| **Must not depend on** | `proofs`, `payments`, `credentials`, `webhooks` |

The transition table lives in `auth` because `AuthGuard` and the login path
enforce it on every request. A status change, its session revocation and its
audit record commit in one transaction; role is read live by the guard, so a
role change needs no session revocation.

`organizations/residency/` enforces per-organization, per-data-class region
allow-lists: an explicit, versioned policy that writes, exports, backups, and
queued work are checked against before a resource is placed in a region.

### `approvals` — [`src/approvals/`](../src/approvals/)

A queue for privileged, side-effecting operations that require a decision
from someone other than the requester before they run.

| | |
|---|---|
| **Public interface** | `POST /approvals`, `/approvals/:id/approve`, `/reject`, `/cancel` |
| **Owned tables** | `ApprovalRequest` |
| **Key files** | [`approvals.service.ts`](../src/approvals/approvals.service.ts) |
| **Must not depend on** | `proofs`, `payments`, `webhooks` |

Self-approval is rejected outright. The PENDING → APPROVED/REJECTED/CANCELLED
transition and the execution lease are both single conditional `updateMany`
calls, so exactly one decision and one execution ever win under concurrency —
see [`approvals.service.ts`](../src/approvals/approvals.service.ts).

### `schemas` — [`src/schemas/`](../src/schemas/)

Bulk schema-metadata imports with a zero-mutation dry-run phase.

| | |
|---|---|
| **Public interface** | `POST /organizations/:id/schema-imports`, `/:id/approve`, `/:id/apply` |
| **Owned tables** | `SchemaImportJob`, `SchemaImportRow`, `SchemaDefinition` |
| **Key files** | [`schema-imports.service.ts`](../src/schemas/schema-imports.service.ts) |
| **Must not depend on** | `proofs`, `payments`, `webhooks` |

Upload and dry-run only ever write to the staging tables
(`SchemaImportJob`/`SchemaImportRow`); `SchemaDefinition` is touched only by
`apply`, and only when the caller's `reviewedHash` matches the dry run's
`canonicalHash` exactly.

### `issuers` — [`src/issuers/`](../src/issuers/)

Trusted attestation sources and their on-chain registry mirror.

| | |
|---|---|
| **Public interface** | `/issuers` CRUD, status transitions, registry sync, ADMIN-only `/issuers/:id/address-rotations` |
| **Owned tables** | `Issuer`, `Attestation`, `IssuerAddressRotation`, `IssuerAddressHistory` |
| **Key files** | [`issuers.service.ts`](../src/issuers/issuers.service.ts), [`issuer-registry.service.ts`](../src/issuers/issuer-registry.service.ts), [`issuer-address-rotation.service.ts`](../src/issuers/issuer-address-rotation.service.ts) |
| **Must not depend on** | `proofs`, `payments` |

### `payments` — [`src/payments/`](../src/payments/)

Horizon synchronization and payment classification.

| | |
|---|---|
| **Public interface** | `POST /payments/sync`, `GET /payments`, `PATCH /payments/:id/classification`, `/payment-backfills` (ADMIN, [details](payment-backfills.md)) |
| **Owned tables** | `Payment`, `SupportedAsset`, `PaymentBackfillJob` |
| **Key files** | [`payments.service.ts`](../src/payments/payments.service.ts), [`payment-backfill.service.ts`](../src/payments/payment-backfill.service.ts) |
| **Must not depend on** | `proofs`, `credentials`, `webhooks` |

Payments are read by `proofs` but never written by it. Amounts are stored
encrypted; see [Protected data](#protected-data).

### `proofs` — [`src/proofs/`](../src/proofs/)

The core domain. Issuance, verification, revocation, and anchoring intent.

| | |
|---|---|
| **Public interface** | `/proofs/minimum-income`, `/proofs/recurring-income`, `/proofs/payment-receipt`, `GET /proofs`, `/proofs/:id/verify`, `/proofs/:id/revoke`, `/proofs/:id/share-tokens`, `POST /proof-shares/resolve` |
| **Owned tables** | `Proof`, `ProofClaim`, `AnchoringIntent`, `VerificationEvent`, `ProofShareToken` |
| **Key files** | [`proofs.service.ts`](../src/proofs/proofs.service.ts), [`contract-anchoring.service.ts`](../src/proofs/contract-anchoring.service.ts) |
| **Must not depend on** | `auth` internals, `api-keys` internals |

Reads `payments`, `trusted-sources`, and `issuers`; writes only its own tables.

### `credentials` — [`src/credentials/`](../src/credentials/)

Deterministic canonicalization, hashing, and HMAC signing.

| | |
|---|---|
| **Public interface** | `POST /credentials/verify` |
| **Owned tables** | none — operates on `Proof.signedPayload` |
| **Key files** | [`credentials.service.ts`](../src/credentials/credentials.service.ts), [`canonicalize.ts`](../src/common/crypto/canonicalize.ts) |
| **Must not depend on** | `payments`, `webhooks`, `jobs` |

Canonicalization must stay deterministic across versions: a credential signed
last month must verify today, so any change to
[`canonicalize.ts`](../src/common/crypto/canonicalize.ts) invalidates every
signature ever issued. Treat it as frozen.

The module is verification-only on purpose: it reads proofs and never writes
them, and issuance, revocation and any future export format stay in `proofs`,
which owns the signing key and the authenticated surface. See
[ADR-0007](adr/0007-keep-the-credentials-module.md).

### `webhooks` — [`src/webhooks/`](../src/webhooks/)

Signed outbound event delivery.

| | |
|---|---|
| **Public interface** | `/webhooks` CRUD, delivery replay, dead-letter inspection and redrive |
| **Owned tables** | `Webhook`, `WebhookDelivery` |
| **Key files** | [`webhooks.service.ts`](../src/webhooks/webhooks.service.ts), [`webhook-delivery.service.ts`](../src/webhooks/webhook-delivery.service.ts), [`webhook-signing.service.ts`](../src/webhooks/webhook-signing.service.ts), [`webhook-ssrf-guard.ts`](../src/webhooks/webhook-ssrf-guard.ts) |
| **Must not depend on** | `proofs` internals, `payments` internals |

The only module that makes outbound HTTP to customer-controlled URLs, which is
why the SSRF guard lives here.

`webhook-client-certificate.service.ts` manages optional mutual TLS for
delivery: at most one certificate is ever ACTIVE per webhook, a rotation
demotes the outgoing one to ROTATING rather than deleting it, and
`webhook-delivery.service.ts` refuses to fall back to a plain connection when
mTLS is required but no valid certificate is selected.

### `jobs` — [`src/jobs/`](../src/jobs/)

Scheduled background work.

| | |
|---|---|
| **Public interface** | none — no controller |
| **Owned tables** | none; operates on `AnchoringIntent` and `PaymentBackfillJob` |
| **Key files** | [`anchoring-worker.service.ts`](../src/jobs/anchoring-worker.service.ts), [`anchoring-reconciler.service.ts`](../src/jobs/anchoring-reconciler.service.ts), [`payment-backfill-worker.service.ts`](../src/jobs/payment-backfill-worker.service.ts) |
| **Must not depend on** | HTTP request context |

Jobs have no request and therefore no user. Anything that reads
`CurrentUser` cannot be called from a job.

### `audit` — [`src/audit/`](../src/audit/)

Administrative action log and privacy-safe verification events.

| | |
|---|---|
| **Owned tables** | `AuditLog`, `VerificationEventLog` |
| **Key files** | [`verification-event.service.ts`](../src/audit/verification-event.service.ts) |
| **Must not depend on** | any domain module |

Written by many modules, reads none. That one-way dependency is what keeps it
safe to call from anywhere.

### `stellar` — [`src/stellar/`](../src/stellar/)

Horizon client and memo normalization. The only module that talks to Horizon.

| | |
|---|---|
| **Key files** | [`stellar.service.ts`](../src/stellar/stellar.service.ts), [`memo-normalizer.ts`](../src/stellar/memo-normalizer.ts) |
| **Must not depend on** | any domain module |

### `quotas` — [`src/quotas/`](../src/quotas/)

Per-organization operational quotas; see [quotas.md](quotas.md).

| | |
|---|---|
| **Public interface** | none — enforced inside other modules' transactions; usage is served by `organizations` |
| **Owned tables** | `OrganizationQuotaUsage` |
| **Key files** | [`organization-quota.service.ts`](../src/quotas/organization-quota.service.ts) |
| **Must not depend on** | any domain module |

### `common`, `config`, `database`, `health`, `trusted-sources`

Infrastructure and supporting domain. [`common`](../src/common/) holds guards,
decorators, interceptors, filters, and crypto helpers; it must not import any
domain module. [`database`](../src/database/) owns the Prisma lifecycle.
[`health`](../src/health/) probes dependencies.
[`trusted-sources`](../src/trusted-sources/) owns the `TrustedSource` table.

## Critical flows

### Authentication

```
POST /auth/challenge   → WalletChallenge (nonce hash + expiry)
POST /auth/verify      → verify SEP-53 signature → AuthSession (token hash)
   every request       → AuthGuard → hash bearer → load session → attach user
POST /auth/rotate      → issue successor, link via rotatedToId
POST /auth/logout      → set revokedAt
   daily               → CleanupJob deletes expired sessions
```

Enforcement: [`auth.guard.ts:24`](../src/common/guards/auth.guard.ts#L24) rejects
a missing token, [`:45`](../src/common/guards/auth.guard.ts#L45) an unknown user,
[`:49`](../src/common/guards/auth.guard.ts#L49) an inactive account.

Tests: [`auth.service.spec.ts`](../src/auth/auth.service.spec.ts),
[`session.service.spec.ts`](../src/auth/session.service.spec.ts),
[`auth.guard.spec.ts`](../src/common/guards/auth.guard.spec.ts).

### Payment synchronization

```
POST /payments/sync → Horizon page → normalize memo → classify → upsert Payment
```

Idempotent on `Payment.operationId`, which is `@unique` in
[`schema.prisma`](../prisma/schema.prisma). Re-syncing the same window does not
duplicate rows, which is what makes a retry safe.

Tests: [`payments.service.spec.ts`](../src/payments/payments.service.spec.ts),
[`stellar.service.spec.ts`](../src/stellar/stellar.service.spec.ts),
[`memo-normalizer.spec.ts`](../src/stellar/memo-normalizer.spec.ts).

### Proof issuance

```
POST /proofs/minimum-income
  → load caller's payments        (scoped by userId)
  → validate period and threshold
  → canonicalize claim → hash → HMAC sign
  → $transaction: Proof + ProofClaim + AnchoringIntent
  → webhook event
```

The transaction boundary is [`proofs.service.ts:214`](../src/proofs/proofs.service.ts#L214).
Proof, claim, and anchoring intent commit together or not at all — a proof
without its claim would verify against nothing.

Tests: [`proofs.service.spec.ts`](../src/proofs/proofs.service.spec.ts),
[`proofs.lifecycle.spec.ts`](../src/proofs/proofs.lifecycle.spec.ts),
[`payment-receipt.spec.ts`](../src/proofs/payment-receipt.spec.ts).

### Verification

```
GET /proofs/:id/verify   (public — no auth)
  → load proof → check status, expiry, revocation
  → recompute canonical hash → compare HMAC
  → record VerificationEventLog (hashed metadata only)
```

Public by design: a relying party holding a credential must be able to check it
without an account. That is why the response carries no payment detail and no
wallet address — see [Protected data](#protected-data).

Tests: [`credentials.service.spec.ts`](../src/credentials/credentials.service.spec.ts),
[`credentials.controller.spec.ts`](../src/credentials/credentials.controller.spec.ts),
[`verification-event.service.spec.ts`](../src/audit/verification-event.service.spec.ts).

### Revocation

```
POST /proofs/:id/revoke
  → assert caller owns the proof
  → $transaction: status=REVOKED, revokedAt=now, AnchoringIntent(REVOKE)
  → webhook event
```

Revocation is terminal. Nothing sets a revoked proof back to `ACTIVE`, and
`revokedAt` outlives the credential so a verifier can distinguish "expired" from
"revoked".

### Anchoring

```
every 10s   AnchoringWorker: claim PENDING batch → submit → CONFIRMED | retry
every N     AnchoringReconciler: reset intents stuck in PROCESSING
```

Bounded batches with exponential backoff and a permanent-failure cap
([`anchoring-worker.service.ts`](../src/jobs/anchoring-worker.service.ts)). A
crashed worker leaves intents in `PROCESSING`; the reconciler is what unsticks
them, so both must run.

Tests: [`anchoring-worker.service.spec.ts`](../src/jobs/anchoring-worker.service.spec.ts),
[`anchoring-reconciler.service.spec.ts`](../src/jobs/anchoring-reconciler.service.spec.ts).

### Issuer address rotation

```
POST /issuers/:id/address-rotations   check revision + conflicts → open rotation → reconcile
every 60s   IssuerAddressRotationJob: reconcile open rotations that are due
reconcile   lease → read contract address →
              target  → finalize (adopt address, record history)
              source  → submit rotate_issuer_address → read again → finalize | retry
              other   → FAILED (contract conflict)
```

The database adopts a new issuer address only after the contract is observed
holding it, so a timeout, a failed read or a restart can delay a rotation but
never make the database claim an unconfirmed address. Every pass starts from
the contract's observed state, which makes retries idempotent: a submission
that timed out after landing is finalized, not resubmitted. A request must name
the issuer `revision` it was based on; one open rotation per issuer and per
target address is enforced by unique indexes. Retired addresses stay in
`IssuerAddressHistory` and cannot be registered or rotated onto again.

Tests: [`issuer-address-rotation.service.spec.ts`](../src/issuers/issuer-address-rotation.service.spec.ts),
[`issuer-address-rotation.int-spec.ts`](../test/integration/issuer-address-rotation.int-spec.ts),
[`issuer-address-rotation.e2e-spec.ts`](../test/e2e/issuer-address-rotation.e2e-spec.ts).

### Webhook delivery

```
domain event → WebhookDelivery(PENDING) → SSRF guard → sign → POST → record
```

Tests: [`webhook-delivery.service.spec.ts`](../src/webhooks/webhook-delivery.service.spec.ts),
[`webhook-signing.service.spec.ts`](../src/webhooks/webhook-signing.service.spec.ts),
[`webhook-ssrf-guard.spec.ts`](../src/webhooks/webhook-ssrf-guard.spec.ts).

## Domain invariants

Each links to enforcing code and a test that fails if it regresses.

| # | Invariant | Enforced at | Tested by |
|---|---|---|---|
| I1 | A raw session token is never persisted; only its SHA-256 hash | [`session.service.ts`](../src/auth/session.service.ts), `AuthSession.tokenHash` | [`session.service.spec.ts`](../src/auth/session.service.spec.ts) |
| I2 | A request without a valid bearer token cannot reach a protected route | [`auth.guard.ts:24`](../src/common/guards/auth.guard.ts#L24) | [`auth.guard.spec.ts`](../src/common/guards/auth.guard.spec.ts) |
| I3 | A suspended or revoked user cannot authenticate | [`auth.guard.ts:49`](../src/common/guards/auth.guard.ts#L49) | [`auth.guard.spec.ts`](../src/common/guards/auth.guard.spec.ts) |
| I4 | A wallet challenge is single-use and expires | `WalletChallenge.usedAt`, `expiresAt` | [`auth.service.spec.ts`](../src/auth/auth.service.spec.ts) |
| I5 | An API key is organization-scoped; a valid key cannot address another tenant | [`api-key.service.ts:228`](../src/api-keys/api-key.service.ts#L228), [`:287`](../src/api-keys/api-key.service.ts#L287), [`:300`](../src/api-keys/api-key.service.ts#L300) | [`api-key.service.spec.ts`](../src/api-keys/api-key.service.spec.ts) |
| I6 | An API key lacking a scope is refused with 403, distinct from 401 | [`api-key.guard.ts:21`](../src/common/guards/api-key.guard.ts#L21), [`scopes.guard.ts`](../src/common/guards/scopes.guard.ts) | [`api-keys.controller.spec.ts`](../src/api-keys/api-keys.controller.spec.ts) |
| I7 | Every API key authentication failure returns an identical 401, regardless of cause | [`api-key.guard.ts:42`](../src/common/guards/api-key.guard.ts#L42), [`:49`](../src/common/guards/api-key.guard.ts#L49), [`:59`](../src/common/guards/api-key.guard.ts#L59), [`:73`](../src/common/guards/api-key.guard.ts#L73) | [`api-key.service.spec.ts`](../src/api-keys/api-key.service.spec.ts) |
| I8 | Payment sync is idempotent on `operationId` | `Payment.operationId @unique` in [`schema.prisma`](../prisma/schema.prisma) | [`payments.service.spec.ts`](../src/payments/payments.service.spec.ts) |
| I9 | A proof is issued only from payments the caller owns | [`proofs.service.ts:153`](../src/proofs/proofs.service.ts#L153), [`:542`](../src/proofs/proofs.service.ts#L542) | [`proofs.service.spec.ts`](../src/proofs/proofs.service.spec.ts) |
| I10 | Proof, claim, and anchoring intent commit atomically | [`proofs.service.ts:214`](../src/proofs/proofs.service.ts#L214), [`:446`](../src/proofs/proofs.service.ts#L446), [`:620`](../src/proofs/proofs.service.ts#L620) | [`proofs.lifecycle.spec.ts`](../src/proofs/proofs.lifecycle.spec.ts) |
| I11 | A proof can be read or revoked only by its owner | [`proofs.service.ts:331`](../src/proofs/proofs.service.ts#L331) | [`proofs.service.spec.ts`](../src/proofs/proofs.service.spec.ts) |
| I12 | Revocation is terminal; no path returns a revoked proof to `ACTIVE` | [`proofs.service.ts:715`](../src/proofs/proofs.service.ts#L715) | [`proofs.lifecycle.spec.ts`](../src/proofs/proofs.lifecycle.spec.ts) |
| I13 | `credentialHash` is unique, so no two proofs share a credential | `Proof.credentialHash @unique` in [`schema.prisma`](../prisma/schema.prisma) | [`proofs.service.spec.ts`](../src/proofs/proofs.service.spec.ts) |
| I14 | Canonicalization is deterministic; a credential signed earlier still verifies | [`canonicalize.ts`](../src/common/crypto/canonicalize.ts) | [`credentials.service.spec.ts`](../src/credentials/credentials.service.spec.ts) |
| I15 | Signature comparison is timing-safe | [`timing-safe.ts`](../src/common/crypto/timing-safe.ts) | [`credentials.service.spec.ts`](../src/credentials/credentials.service.spec.ts) |
| I16 | Payment amounts are encrypted at rest | [`protected-amount.ts`](../src/common/crypto/protected-amount.ts) | [`payments.service.spec.ts`](../src/payments/payments.service.spec.ts) |
| I17 | Verification events store hashed metadata, never raw identifiers | [`verification-event.service.ts`](../src/audit/verification-event.service.ts) | [`verification-event.service.spec.ts`](../src/audit/verification-event.service.spec.ts) |
| I18 | An anchoring intent is unique per proof and operation | `AnchoringIntent @@unique([proofId, operation])` in [`schema.prisma`](../prisma/schema.prisma) | [`anchoring-worker.service.spec.ts`](../src/jobs/anchoring-worker.service.spec.ts) |
| I19 | Anchoring retries are bounded and back off | [`anchoring-worker.service.ts`](../src/jobs/anchoring-worker.service.ts) | [`anchoring-worker.service.spec.ts`](../src/jobs/anchoring-worker.service.spec.ts) |
| I20 | Intents stuck in `PROCESSING` are reclaimed | [`anchoring-reconciler.service.ts`](../src/jobs/anchoring-reconciler.service.ts) | [`anchoring-reconciler.service.spec.ts`](../src/jobs/anchoring-reconciler.service.spec.ts) |
| I21 | Webhook targets are SSRF-checked before any request | [`webhook-ssrf-guard.ts`](../src/webhooks/webhook-ssrf-guard.ts) | [`webhook-ssrf-guard.spec.ts`](../src/webhooks/webhook-ssrf-guard.spec.ts) |
| I22 | Every webhook delivery is signed | [`webhook-signing.service.ts`](../src/webhooks/webhook-signing.service.ts) | [`webhook-signing.service.spec.ts`](../src/webhooks/webhook-signing.service.spec.ts) |
| I23 | Error responses never leak internals — no stack, no Prisma metadata | [`global-exception.filter.ts`](../src/common/filters/global-exception.filter.ts) | [`global-exception.filter.spec.ts`](../src/common/filters/global-exception.filter.spec.ts) |
| I24 | Every response carries a correlation ID | [`request-id.interceptor.ts`](../src/common/interceptors/request-id.interceptor.ts) | [`request-id.interceptor.spec.ts`](../src/common/interceptors/request-id.interceptor.spec.ts) |
| I25 | The health endpoint requires no auth and exposes no internals | [`health.controller.ts`](../src/health/health.controller.ts) | [`health.authorization.spec.ts`](../src/health/health.authorization.spec.ts) |
| I26 | A suspended, revoked or deleted account can neither use nor obtain a session | [`account-status.policy.ts`](../src/auth/account-status.policy.ts) | [`account-status.policy.spec.ts`](../src/auth/account-status.policy.spec.ts), [`users.service.spec.ts`](../src/users/users.service.spec.ts) |

### Reviewer note

I7 is easy to weaken by accident. Distinguishing "key not found" from "key
revoked" in the response is a small usability gain and an enumeration oracle: a
caller could probe which key ids exist. The guard returns the same message for
all four causes, and it is worth keeping that way.

## Trust boundaries

| Boundary | Crossing | Trusted? | Control |
|---|---|---|---|
| Client → API | HTTP requests | **No** | Validation pipe, guards, throttler |
| Wallet → auth | Signed challenge | **No** | SEP-53 verification, single-use nonce |
| Integrator → API | API key | **No** | Hashed lookup, scopes, org scoping |
| Horizon → payments | Ledger data | **Partly** | Public ledger, but normalized and classified before storage |
| API → Soroban | Anchoring | **Partly** | Contract enforces its own rules; backend cannot assume success |
| API → webhook URL | Outbound POST | **No** | SSRF guard; the URL is customer-controlled |
| API → database | Queries | **Yes** | Trusted; a compromised app is a compromised database |

The two worth dwelling on:

**Webhook URLs are attacker-controlled input.** A customer can point a webhook
at `169.254.169.254` or an internal host. The SSRF guard is what stops the
backend being used as a proxy into its own network.

**Horizon data is public but not neutral.** Memos are user-supplied. They are
normalized in [`memo-normalizer.ts`](../src/stellar/memo-normalizer.ts) before
anything downstream reads them, and stored only in the encrypted, versioned
form described in [payment-memos.md](payment-memos.md). Proof eligibility never
reads them.

## Protected data

| Class | Where | Handling |
|---|---|---|
| Session tokens | `AuthSession.tokenHash` | SHA-256 only; raw token never stored |
| Proof share tokens | `ProofShareToken.tokenHash` | SHA-256 only; raw token returned once at issuance |
| API keys | `ApiKey.hash` | Hashed; prefix stored separately for lookup |
| Payment amounts | `Payment` | AES-256-GCM at rest |
| Payment memos | `Payment.memo` | Allowlisted, byte-bounded, AES-256-GCM at rest ([details](payment-memos.md)) |
| Wallet addresses | `User.walletHash` | Hashed for indexing |
| Webhook secrets | `Webhook.secretEncrypted` | Encrypted |
| Credential payloads | `Proof.signedPayload` | Signed; contains no raw payment history |
| Verification metadata | `VerificationEventLog.metadataHash` | Hashed with a salt version |

Rules that must hold:

1. **Never log a raw secret.** [`global-exception.filter.ts`](../src/common/filters/global-exception.filter.ts) keeps internals out of responses; the same discipline applies to logs.
2. **Never return another tenant's data.** Every multi-tenant query filters on `organizationId`.
3. **Never widen a public endpoint.** `GET /proofs/:id/verify` is unauthenticated. Anything added to its response becomes public to anyone holding a proof id.
4. **Hash before indexing.** A field needed for lookup but not display is stored hashed.

## Transaction ownership

Prisma transactions are used in exactly four places, and each is a deliberate
atomicity boundary rather than a habit:

| Owner | Line | Why |
|---|---|---|
| `session.service.ts` | [152](../src/auth/session.service.ts#L152) | Rotation must revoke the old session and create its successor together, or a rotation could leave two live sessions |
| `proofs.service.ts` | [214](../src/proofs/proofs.service.ts#L214), [446](../src/proofs/proofs.service.ts#L446), [620](../src/proofs/proofs.service.ts#L620) | Proof, claim, and anchoring intent must commit together — a proof without its claim verifies against nothing |
| `proofs.service.ts` | [715](../src/proofs/proofs.service.ts#L715) | Revocation must set status and enqueue the on-chain revocation together |
| `anchoring-worker.service.ts` | [311](../src/jobs/anchoring-worker.service.ts#L311) | Confirming an intent and recording the transaction hash on the proof must not diverge |

**A module owns transactions over its own tables only.** A transaction spanning
two modules' tables means the boundary is in the wrong place.

## Extension rules

**Adding a module.** Create `src/<name>/`, register it in
[`app.module.ts`](../src/app.module.ts), add a section above with its owned
tables and forbidden dependencies, and add an ADR if it introduces a new
external dependency or crosses an existing boundary.

**Adding a table.** Name its owning module. Two modules writing one table is a
boundary error, not a shortcut.

**Adding an endpoint.** State its auth requirement explicitly. A new
unauthenticated endpoint needs an ADR — the surface area of what is public is a
decision, not a detail.

**Adding an invariant.** Add a row above with enforcing code *and* a test.
Without both it is documentation, and documentation does not fail a build.

**Changing canonicalization.** Do not. Every previously issued credential
verifies against the current implementation, so a change invalidates them all.
If it is genuinely necessary, it needs an ADR and a migration plan for existing
credentials.

**Changing a guard.** Guards are the enforcement point for I2, I3, I5, I6, and
I7. Changes need a test proving the rejection still happens and a security
review.

## Verification

```bash
npm run lint
npm run test -- --runInBand
npm run build
```

Documentation links are checked by
[`src/docs-links.spec.ts`](../src/docs-links.spec.ts), which fails when a
referenced path stops existing. A handbook that points at a moved file is worse
than one that points nowhere, because it reads as current.

## Maintenance

Refresh when:

- a module is added, removed, or renamed;
- a table changes owner;
- an invariant is added, weakened, or newly tested;
- a trust boundary moves;
- a transaction boundary is added or removed;
- a decision listed in [`docs/adr/`](adr/) is superseded.
