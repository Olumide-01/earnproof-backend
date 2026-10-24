# Audit events

What this service records when something security-relevant happens, what it
deliberately does not record, and what happens when the audit write itself
fails.

The list below is generated from nothing — it is maintained by hand alongside
[`src/common/audit/audit-taxonomy.ts`](../src/common/audit/audit-taxonomy.ts),
and [`audit-taxonomy.spec.ts`](../src/common/audit/audit-taxonomy.spec.ts) fails
the build if the two drift apart. An event that exists in code but not in this
document, or whose write-failure behaviour differs from the row below, is a test
failure rather than a documentation bug.

## Stores

| Store | Table | Holds |
| --- | --- | --- |
| `audit_log` | `AuditLog` | Authenticated mutations: who did what, to which resource, under which tenant. |
| `auth_audit_event` | `AuthAuditEvent` | Authentication attempts, keyed by a hashed wallet. No addresses, no client identifiers. |
| `verification_event_log` | `VerificationEventLog` | Public verification outcomes, keyed by proof, with a salted metadata hash. |

The three stores exist because their privacy budgets differ. `AuditLog` rows
belong to an identified tenant and can name the actor. Authentication happens
before anyone is identified, so its rows carry a hash and nothing else.
Verification is unauthenticated and public, so its rows carry no actor at all —
see [ADR 0004](adr/0004-public-unauthenticated-verification.md).

## Event matrix

`Failure` is the behaviour of the *caller's mutation* when the audit write
fails: `fail_closed` propagates the error and the action fails; `fail_open` logs
and continues.

| Event type | Domain | Store | Actor | Outcomes | Tenant context | Failure |
| --- | --- | --- | --- | --- | --- | --- |
| `authentication.challenge_created` | authentication | `auth_audit_event` | wallet | success | wallet hash | fail_open |
| `authentication.challenge_verified` | authentication | `auth_audit_event` | wallet | success | wallet hash | fail_open |
| `authentication.wallet_rotated` | authentication | `audit_log` | user | success | actor | fail_closed |
| `authentication.signature_invalid` | authentication | `auth_audit_event` | wallet | denied | wallet hash | fail_open |
| `authentication.challenge_expired` | authentication | `auth_audit_event` | wallet | denied | wallet hash | fail_open |
| `authentication.challenge_replayed` | authentication | `auth_audit_event` | wallet | denied | wallet hash | fail_open |
| `authentication.account_inactive` | authentication | `auth_audit_event` | wallet | denied | wallet hash | fail_open |
| `authorization.rate_limited` | authorization | `auth_audit_event` | wallet | denied | wallet hash | fail_open |
| `authorization.api_key_authenticated` | authorization | `audit_log` | api_key | success | `metadata.organizationId` | fail_open |
| `issuer.created` | issuer | `audit_log` | user | success | `metadata.organizationId` | fail_closed |
| `issuer.metadata_updated` | issuer | `audit_log` | user | success | actor | fail_closed |
| `issuer.status_updated` | issuer | `audit_log` | user | success | actor | fail_closed |
| `issuer.status_synced` | issuer | `audit_log` | user | success | actor | fail_closed |
| `issuer.address_rotation_requested` | issuer | `audit_log` | user | success | `metadata.organizationId` | fail_closed |
| `issuer.address_rotated` | issuer | `audit_log` | user, system | success | `metadata.organizationId` | fail_closed |
| `issuer.address_rotation_failed` | issuer | `audit_log` | user, system | success | `metadata.organizationId` | fail_closed |
| `proof.verification_recorded` | proof | `verification_event_log` | system | success, denied | proof | fail_open |
| `proof.revoked` | proof | `audit_log` | user | success | resource | fail_closed |
| `anchoring_intent.retried` | proof | `audit_log` | user | success | resource | fail_closed |
| `anchoring_intent.abandoned` | proof | `audit_log` | user | success | resource | fail_closed |
| `api_key.created` | api_key | `audit_log` | user | success | `metadata.organizationId` | fail_closed |
| `api_key.rotated` | api_key | `audit_log` | user | success | `metadata.organizationId` | fail_closed |
| `api_key.cutover` | api_key | `audit_log` | user, system | success | `metadata.organizationId` | fail_closed |
| `api_key.revoked` | api_key | `audit_log` | user | success | `metadata.organizationId` | fail_closed |
| `webhook.delivery_replayed` | webhook | `audit_log` | user | success | actor | fail_closed |
| `operator.organization_created` | operator | `audit_log` | user | success | resource | fail_closed |
| `operator.organization_updated` | operator | `audit_log` | user | success | resource | fail_closed |
| `operator.organization_archived` | operator | `audit_log` | user | success | resource | fail_closed |
| `operator.organization_restored` | operator | `audit_log` | user | success | resource | fail_closed |
| `operator.organization_legal_hold_placed` | operator | `audit_log` | user | success | resource | fail_closed |
| `operator.organization_legal_hold_released` | operator | `audit_log` | user | success | resource | fail_closed |
| `operator.organization_deleted` | operator | `audit_log` | user | success | resource | fail_closed |
| `operator.payment_classification_updated` | operator | `audit_log` | user | success | actor | fail_closed |
| `operator.trusted_source_created` | operator | `audit_log` | user | success | actor | fail_closed |
| `operator.trusted_source_updated` | operator | `audit_log` | user | success | actor | fail_closed |
| `operator.trusted_source_deleted` | operator | `audit_log` | user | success | actor | fail_closed |
| `operator.user_status_changed` | operator | `audit_log` | user | success | resource | fail_closed |
| `operator.user_role_changed` | operator | `audit_log` | user | success | resource | fail_closed |
| `operator.payment_backfill_requested` | operator | `audit_log` | user | success | actor | fail_closed |
| `operator.payment_backfill_cancelled` | operator | `audit_log` | user | success | actor | fail_closed |

### Stable types and persisted shapes

The stable type is the name to use in alerts, runbooks and reports. It is not
always the string in the `action` column: the earliest audit writers used
`("CREATE", "Issuer")` while later ones used `("api_key.created", "api_key")`,
and rewriting the older rows would break every query already written against
them. `resolveAuditEventType({ action, resourceType })` maps a persisted row to
its stable type, and the pair — not the action alone — is the identity, so
`("CREATE", "Issuer")` and `("CREATE", "Organization")` stay distinct.

The same split runs through `actorType`: the early writers persist `"User"`,
the later ones `"user"`. Both name the same principal, so
`normalizeAuditActorType` folds them together on read. A query that filters on
one spelling alone silently drops half the trail — use the helper, or match
case-insensitively.

Normalising the persisted `action` and `actorType` values in the database is a
migration, not a test change, and is deliberately out of scope here.

## Forbidden fields

None of the following may appear in any audit record, in any store, under any
key. [`audit-redaction.ts`](../src/common/audit/audit-redaction.ts) enforces
this by key name *and* by value shape, and
[`audit-event-matrix.spec.ts`](../src/common/audit/audit-event-matrix.spec.ts)
scans the record every audited action actually produces.

- Session tokens, API key secrets, and any other bearer credential.
- Signatures, signing keys, and challenge text — all of it replayable material.
- Proof bodies and credential payloads.
- Exact income figures and any individual payment amount.
- Payment history.
- Wallet addresses, in the clear.
- Client identifiers: IP addresses and user agents.
- Personal data: email addresses, phone numbers, tax identifiers.

Two shapes are sanctioned in place of the above:

- **Hashes.** A key ending in `Hash`/`hash` may carry a SHA-256 digest of a
  value that could not otherwise be recorded — `walletHash`,
  `sourceAddressHash`, `clientMetadataHash`. This keeps rows joinable for abuse
  detection without keeping the identifier.
- **Declared public identifiers.** An issuer's Stellar account is public
  registry data and is recorded in the clear on `issuer.created`. Every such
  field is named in the taxonomy's `publicIdentifierFields`; nothing is exempt
  by accident.

The scanner also rejects any string that *looks* like a secret regardless of its
key — a Stellar address or seed, a JWT, a PEM private key, an IPv4 literal, or a
base64 blob of 43 characters or more (the encoded length of this service's own
API key secret).

## Write-failure behaviour

Every critical mutation has an explicit answer to "what if the audit write
fails?", asserted in the matrix suite.

**Fail-closed** — every authenticated mutation: API key issue, rotate and
revoke; issuer registration, metadata, status and sync; webhook replay;
organisation create and update; payment reclassification; trusted-source create,
update and delete. If the audit row cannot be written, the request fails. An
untraceable key revocation is worse than a failed one, and the caller can retry.

**Fail-open** — authentication attempts, API key presentation, and public
verification. These paths are reachable without credentials, so failing them on
an audit outage would hand any client that can degrade the audit store a way to
take authentication offline. The write is attempted, the failure is logged at
`warn`, and the request proceeds.

The consequence is worth stating plainly: **the authentication and verification
trails are best-effort**. Alerting that counts authentication failures must
treat a gap as inconclusive, not as an absence of attempts. The mutation trail
in `AuditLog` is not best-effort, and a gap there means the mutation did not
happen.

## Coverage gaps

Recorded here rather than left implicit:

- **Authorization denials at the guards.** A rejected role check
  ([`role.guard.ts`](../src/common/guards/role.guard.ts)) or scope check
  ([`scopes.guard.ts`](../src/common/guards/scopes.guard.ts)) is not audited.
  Auditing it would let an unauthenticated caller drive unbounded writes into
  the audit store, which is the same trade the fail-open paths make in the other
  direction. Rate-limited authentication denials *are* recorded, as
  `authorization.rate_limited`, because the rate limiter bounds them by
  construction. Denials are visible in the HTTP metrics
  ([observability](observability.md)) in the meantime.
- **Background jobs.** Anchoring and retention workers do not write audit
  events; their evidence is the outbox row and the structured job log.

## Retention

`AuditLog` and `AuthAuditEvent` are pruned by the retention job
([data retention](data-retention.md)); `VerificationEventLog` rows carry their
own `retainUntil`. Retention is a separate promise from completeness: an event
absent because it aged out is not the same as an event that was never written,
and only the first is expected.

## Adding an event

1. Write the record from the service, following the shape of the nearest
   existing writer.
2. Declare it in [`audit-taxonomy.ts`](../src/common/audit/audit-taxonomy.ts)
   with its actor types, outcomes, tenant source and write-failure behaviour.
3. Add a scenario to
   [`audit-event-matrix.spec.ts`](../src/common/audit/audit-event-matrix.spec.ts)
   that drives the real service. The coverage assertion fails until you do.
4. Add the row to the table above. The documentation test fails until you do.
| `secret_retrieval_receipt.created` | secret_retrieval | `audit_log` | user | success | `metadata.organizationId` | fail_closed |
| `api_key.created` | api_key | `audit_log` | user | success | `metadata.organizationId` | fail_closed |
| `api_key.rotated` | api_key | `audit_log` | user | success | `metadata.organizationId` | fail_closed |
| `webhook.created` | webhook | `audit_log` | user | success | `metadata.organizationId` | fail_closed |
| `webhook.rotated` | webhook | `audit_log` | user | success | `metadata.organizationId` | fail_closed |
| `export_download.issued` | export | `audit_log` | user | success | `metadata.organizationId` | fail_closed |

### Secret Retrieval Receipt Events

**Record**: Immutable evidence that a one-time secret (API key, webhook signing secret, or export download token) was revealed to a user or client.

**Event**: `secret_retrieval_receipt.created`

**Metadata**:
- `secretType`: Type of secret (`api_key` | `webhook` | `export`)
- `resourceId`: ID of the resource (API key ID, webhook ID, export job ID)
- `resourceReference`: Human-readable identifier (e.g., API key prefix, webhook URL, export category list)
- `recipientId`: Who received the secret (user ID, API key prefix, or null for capability URLs)
- `deliveryChannel`: How the secret was delivered (`http_response` | `download_url` | `email`)
- `revealedAt`: ISO timestamp when the secret was revealed
- `receiptId`: ID of the created receipt (cross-reference to `SecretRetrievalReceipt` table)
- `acknowledgementHash`: SHA-256 hash of (resourceId | secretType | revealedAt | orgSalt)

**Never logged**: The raw secret value, secret hash, or any reversible encoding of the secret.

**Behavior**: Receipt creation is atomic with secret revelation. If secret creation fails, receipt is not created. If receipt creation fails, the entire secret creation is rolled back.

**Retention**: Receipts follow the organization's retention policy (default 2 years). Receipts are immutable and cannot be updated or deleted by users, only by automated expiry.

## Related Documentation

- [Secret Retrieval Receipts Design](../docs/secret-retrieval-receipts.md) — Detailed explanation of receipt model, acknowledgement hash computation, and privacy guarantees.
- [API Key Security](../docs/api-key-security.md) — API key creation and rotation with receipt tracking.
