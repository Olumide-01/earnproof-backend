# API and Credential Deprecation Policy

Multiple clients consume this service's REST responses, credential schemas,
webhook envelopes, and contract-facing payloads. None of them deploy in lockstep
with us. A change that looks trivial in a diff can break every one of them, and
the breakage surfaces as a support ticket weeks later rather than as a failing
build.

This policy defines what may change silently, what must be announced, and what
must never happen without approval.

## Surfaces and ownership

| Surface | Where | Version marker | Owner |
|---|---|---|---|
| REST routes and DTOs | `src/**/dto/`, controllers | `api/v1` global prefix | Backend maintainers |
| Credential schemas | `src/credentials/` | `earnproof.minimum-income.v1` | Backend maintainers + issuer integrations |
| Webhook envelopes | `src/webhooks/` | `specVersion: "1"`, per-event `schemaVersion` ([webhook-payloads.md](webhook-payloads.md)) | Backend maintainers |
| Contract bindings | `src/stellar/` | on-chain schema version | Contract maintainers |

Each surface versions **independently**. A REST change does not bump the webhook
`specVersion`, and vice versa — coupling them would force integrators to absorb
migrations for surfaces they do not consume.

## Additive versus breaking

The distinction is not stylistic. Additive changes ship without warning; breaking
changes cannot.

### Additive — ship freely

- **Adding an optional response field.** Adding `revokedAt?: string` to a proof
  response. Existing consumers ignore unknown fields.
- **Adding a new endpoint.** `GET /api/v1/proofs/:id/history` alongside existing
  routes.
- **Adding an optional request parameter** with a default preserving current
  behaviour.
- **Adding a new webhook event type** to `WEBHOOK_EVENT_TYPES`. Subscribers only
  receive events they subscribed to.
- **Relaxing a required field to optional**, for callers. Note this still changes
  what *response* consumers see, so it is reported by the compatibility check.
- **Adding a new enum value** — but see the caveat below.

> **Enum caveat.** Adding a value to an enum that appears in a *response* is
> additive for us and breaking for a consumer with an exhaustive switch. Adding
> `ProofStatus.SUSPENDED` would do this. Treat new response-enum values as
> announceable even though the check classifies them as additive.

### Breaking — requires the full process

- **Removing a field**, including an optional one. A consumer reading it now gets
  `undefined`.
- **Renaming a field.** This is a removal plus an addition, and is the most
  common accidental break.
- **Adding a required request field.** Existing callers do not send it, so their
  requests start failing immediately.
- **Making an optional request field required.** Same effect.
- **Narrowing a type** — `string` to a fixed union, widening a minimum,
  tightening validation.
- **Changing a status code** for an existing condition.
- **Removing a webhook event type**, or changing an existing payload's shape.
- **Changing credential hash computation.** Previously issued credentials stop
  verifying — the most severe break available here, because it invalidates
  artifacts already in the wild.

## Deprecation process

Every breaking change follows all five steps. None are optional.

### 1. Announce

Before any code lands: a `docs/` entry naming the contract, what changes, why,
and the removal date. Nothing ships on the same day it is announced.

### 2. Signal at runtime

Deprecated REST routes return:

```
Deprecation: true
Sunset: Sat, 01 Aug 2026 00:00:00 GMT
Link: <https://docs.example.com/migrations/proof-v2>; rel="deprecation"
```

Deprecated webhook envelopes carry the deprecation in delivery metadata, not in
the payload body — the body is the contract under discussion, and mutating it to
announce its own deprecation is itself a breaking change. Deliveries of a
deprecated payload `schemaVersion` send `Deprecation: true` and `Sunset:`
headers; see [webhook-payloads.md](webhook-payloads.md).

### 3. Measure — within the privacy boundary

This is the step most easily done wrong.

**Permitted:** aggregate counts per deprecated contract, per version, over time.
"This field was read 4,000 times last week."

**Not permitted:** per-organization, per-API-key, or per-user attribution of
deprecated usage. "Which integrators still call this" is a question about
identifiable customer behaviour, and the fact that it would be operationally
convenient does not make it in-bounds. Deprecation telemetry never becomes a
reason to start retaining data the service does not otherwise retain.

If a migration genuinely requires reaching specific integrators, use the existing
support channel with existing consent — not usage telemetry.

### 4. Support window

| Surface | Minimum window |
|---|---|
| REST routes and DTOs | 90 days |
| Webhook envelopes | 180 days |
| Credential schemas | 365 days |
| Contract bindings | 365 days |

Credentials and contract bindings get the longest windows because the artifacts
are long-lived: a credential issued today may be verified a year from now, and a
verifier that cannot understand it is a broken promise to the holder, not merely
an inconvenienced integrator.

The window starts at **announcement**, not at the first code change.

### 5. Removal approval

Removal requires:

- The support window has fully elapsed.
- A migration guide exists and is linked from the deprecation notice.
- A maintainer listed in `MAINTAINERS.md` approves the removal PR.
- The removal PR carries a compatibility note (below).

## Compatibility notes

Every breaking change carries a note:

```ts
{
  contractId: "webhook.envelope",
  migration: "Read createdAt from the delivery metadata header instead of the envelope body.",
  supportWindowEndsAt: "2026-06-01",
  approvedBy: "maintainers"
}
```

A **version increment is accepted in place of a note**, because moving consumers
to a new version is itself the compatibility mechanism.

## CI enforcement

`src/common/compatibility/` models the public surface and classifies changes.
`findPolicyViolations` fails when a breaking change carries neither a
compatibility note nor a version increment.

```bash
npx jest src/common/compatibility --runInBand
```

What this can and cannot do, stated plainly: it cannot judge whether a migration
guide is any *good*. It can guarantee somebody was made to write one — which
addresses the failure that actually recurs, a breaking change shipped because
nobody noticed it was breaking.

The check deliberately reports **every** violation rather than stopping at the
first, so a contributor with three breaks does not go through three review
cycles. It reports nothing on an unchanged surface: a check that fires on
no-op diffs gets ignored within a week, and then it protects nothing.

## Trade-off: the surface model is declared, not derived

The contract definitions are written by hand rather than extracted from
TypeScript types or the OpenAPI document.

The cost is real: someone can change a DTO and forget to update the model, and
the check will not notice. Deriving the surface automatically would close that
gap.

It was not done here because it expands this change from a policy into a
type-extraction toolchain, and the issue scope is the policy. The declared model
is honest about what it covers, and automatic derivation is the natural follow-up
once the policy itself is agreed. Until then, updating the surface model is part
of the review checklist for any DTO change.

## Quick reference

| Change | Kind | Action |
|---|---|---|
| Add optional response field | Additive | Ship |
| Add endpoint | Additive | Ship |
| Add webhook event type | Additive | Ship |
| Add response enum value | Additive* | Announce anyway |
| Remove any field | Breaking | Full process |
| Rename field | Breaking | Full process |
| Add required request field | Breaking | Full process |
| Change status code | Breaking | Full process |
| Change credential hashing | Breaking | Full process, 365 days |
