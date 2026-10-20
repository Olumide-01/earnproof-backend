# Data retention

What EarnProof keeps, for how long, who decides, and what happens at the end.

Sessions and some audit cleanup already existed. What was missing was explicit
retention behaviour for challenges, verification events, webhook deliveries, and
failed jobs — and, just as importantly, a written decision about the records that
must **not** be swept.

The executable half of this document is
[`src/jobs/retention/retention-policy.ts`](../src/jobs/retention/retention-policy.ts).
The two must change together; the table below and the code are checked against
each other by [`retention-policy.spec.ts`](../src/jobs/retention/retention-policy.spec.ts).

## Retention table

| Class | Model | Purpose | Default | Override | Owner | At end of period |
|---|---|---|---|---|---|---|
| `wallet_challenges` | `WalletChallenge` | Single-use login nonces. Valueless once used or expired. | 7 days | `RETENTION_WALLET_CHALLENGE_DAYS` | Platform engineering | Delete |
| `auth_sessions` | `AuthSession` | Revocable bearer sessions. Only a token hash is stored. | 30 days | `RETENTION_AUTH_SESSION_DAYS` | Platform engineering | Delete |
| `webhook_deliveries` | `WebhookDelivery` | Delivery attempts and responses, so integrators can debug missed events. Payloads may echo customer data. | 30 days | `RETENTION_WEBHOOK_DELIVERY_DAYS` | Integrations engineering | Delete |
| `verification_events` | `VerificationEventLog` | Verification outcomes for abuse detection and rate analysis. | 90 days | `VERIFICATION_EVENT_RETENTION_DAYS` | Product engineering | Delete |
| `audit_logs` | `AuditLog` | Administrative actions, for security review and incident reconstruction. | 365 days | `RETENTION_AUDIT_LOG_DAYS` | Security | Delete |
| `failed_anchoring_intents` | `AnchoringIntent` (permanently failed only) | Failed anchoring attempts, retained long enough to diagnose and requeue. | 90 days | `RETENTION_FAILED_ANCHORING_DAYS` | Platform engineering | Delete |

### Preserved — never swept automatically

These are listed rather than omitted, because an auditor needs to see that the
decision was made rather than infer it from absence.

| Class | Model | Why it is preserved | Owner |
|---|---|---|---|
| `proofs` | `Proof` | An expired proof is not a deletable proof. A relying party holding a credential must be able to learn that it expired or was revoked; a proof that vanished is indistinguishable from one never issued. | Product engineering |
| `revocation_evidence` | `Proof.revokedAt` | Revocation evidence outliving the credential is the point. Deleting it would silently restore a revoked credential to apparent validity. | Security |
| `anchoring_state` | `AnchoringIntent` (pending and confirmed) | Confirmed intents carry the transaction hash linking a proof to the ledger. Pending intents are unfinished work. Deleting either loses the record of what was anchored, or the work itself. | Platform engineering |
| `archived_organizations` | `Organization` (archived) | Deleting an organization revokes its credentials and anonymises its profile, and must first pass the dependency, legal-hold and minimum-archive checks. `RETENTION_ORGANIZATION_ARCHIVE_DAYS` (default 30) is the minimum time an organization stays archived, and restorable, before deletion is accepted. See [Organization lifecycle](#organization-lifecycle). | Security |

Removing any of these is a deliberate, audited operation. It is not something a
scheduled job should ever do, and the cleanup service refuses to sweep them even
when a caller names them explicitly.

## Retention durations

`resolveRetentionDays` applies the override if one is set and the default
otherwise, with two guards:

- **Minimum 1 day.** A zero or negative override would delete records the moment
  they were written.
- **Maximum 3,650 days.** Beyond this the override effectively disables
  retention, which should be a deliberate policy change rather than a
  configuration value.

An unparseable or out-of-range override **throws**. It does not fall back to the
default: a silent fallback would leave an operator believing retention is tighter
than it actually is, which is precisely the failure a retention policy exists to
prevent.

### Cutoff boundaries

Eligibility is `cutoffColumn < now - retentionDays`. The strict comparison means
a record sitting exactly on the boundary is **retained** — a record is never
removed on the exact day its period ends.

## How cleanup runs

[`RetentionCleanupService`](../src/jobs/retention/retention-cleanup.service.ts),
scheduled daily at 03:00 by
[`RetentionJob`](../src/jobs/retention/retention.job.ts)
(`RETENTION_CLEANUP_CRON` to change it). Retention is measured in days, so
running more often buys nothing and adds database contention.

**Bounded.** Each statement affects at most 500 rows, selected by an indexed
cutoff column. An unbounded `deleteMany` holds locks for as long as it runs,
which turns a routine sweep into a database incident. Each class is capped at 20
batches per run, so a large backlog drains over several days rather than
monopolising the database in one night.

**Resumable.** Progress *is* the deletion. There is no cursor to persist: a run
that dies halfway leaves fewer eligible rows, and the next run continues from
wherever it stopped. Rows are selected by id and then deleted by id, so a crash
between the two loses nothing — the same rows remain eligible.

**Coordinated.** An in-process guard prevents a slow run from overlapping the
next scheduled tick. An overlapping run would contend for the same rows and
double the lock pressure the batching exists to avoid. A skipped tick is logged
and costs nothing, because cleanup is idempotent.

**Isolated.** One class failing does not abandon the rest. A misconfigured
duration on webhook deliveries must not stop challenges from being swept.

**Honest about truncation.** When a class hits the batch cap with rows still
eligible, the result carries `truncated: true` and the job logs it. A sweep that
stopped early while reporting success would let a backlog grow unseen.

### Multi-instance deployments

The single-run guard is **in-process**. Two application instances running the
cron concurrently would each sweep independently.

This is safe but wasteful: deletions are idempotent and scoped to explicitly
selected ids, so the worst outcome is duplicated work and one instance finding
rows already gone. It is **not** a correctness problem, but it is a real
limitation, and a shared advisory lock is the correct fix before running more
than one instance with cleanup enabled. Stated here rather than left as an
assumption.

## Tenant isolation

Cross-organisation deletion is prevented structurally rather than by a filter
that could be forgotten:

1. **Deletion is by id, not by predicate.** Each batch selects ids under the
   cutoff for one class, then deletes exactly those ids. The sweep cannot remove
   a row it did not select.
2. **No cascade reaches a tenant boundary.** The swept classes are leaf
   operational records. `WebhookDelivery` is a child of `Webhook`, and deleting
   deliveries never touches the parent or the organisation.
3. **Relation constraints are part of eligibility.** An `AuthSession` still
   referenced by its rotation successor is excluded, because deleting it would
   break the chain its successor points at — a constraint the cutoff alone
   cannot express.
4. **Anchoring intents are filtered on status.** Only `FAILED` intents with
   `permanentError` set are eligible. A confirmed intent carrying a transaction
   hash, or a pending one representing unfinished work, is never matched.

## Dry run

Set `RETENTION_DRY_RUN=true` to report what *would* be removed without writing
anything. The counts come from the same eligibility filter the deletion would
use, so the preview and the outcome agree — a property that is itself tested.

The intended workflow after changing a retention duration: enable the dry run,
read the counts, then disable it once the numbers look right.

## Reporting

Cleanup reports **counts only**. The result type has no field capable of holding
record content, and the job logs per-class counts and nothing else.

```
Retention cleanup affected 1247 record(s) across 6 class(es)
wallet_challenges: 892 record(s) removed
webhook_deliveries: 355 record(s) removed
```

What was deleted is never logged, never a metric dimension, and never included
in an alert payload. Any metric later added to count cleanup work must follow the
same rule: a count is an aggregate, while the identity of a deleted record is
exactly the thing retention was meant to remove.

## Organization lifecycle

Organizations are retired through an explicit, administrator-only workflow
(`src/organizations/organization-lifecycle.service.ts`), never by the sweep.

```
LIVE --archive--> ARCHIVED --delete--> DELETED
  ^                  |
  +-----restore------+
```

| State | How it is recorded | Effect |
|---|---|---|
| Live | `archivedAt` and `deletedAt` are null | Normal operation. `status` keeps its usual meaning. |
| Archived | `archivedAt` is set | New privileged operations are refused: the organization's API keys stop authenticating; keys cannot be issued or rotated; webhooks receive no new events and queued retries are not sent; issuers cannot be registered or re-activated; attestations cannot be issued; the profile cannot change. Keys can still be listed and revoked, and issuers suspended or revoked, so the tenant can be wound down. Nothing is revoked, so **restore** is lossless. |
| Deleted | `deletedAt` is set, `status` is `DELETED` | Terminal. API keys are revoked; webhooks, their deliveries and idempotency records are deleted; the name is replaced and the website cleared. The row survives as a tombstone and the slug stays reserved. |

A **legal hold** (`legalHoldAt`, with a bounded case reference) can be placed on
a live or archived organization. It blocks deletion only.

Deletion is refused, with the blocking codes in the error, unless every check
passes. The checks run in the same transaction as the cleanup, after the
organization row and its issuers are locked:

| Blocker | Meaning |
|---|---|
| `NOT_ARCHIVED` | Deletion is only accepted from the archived state. |
| `ARCHIVE_RETENTION_PERIOD` | The organization has been archived for less than `RETENTION_ORGANIZATION_ARCHIVE_DAYS` (default 30). The boundary is exclusive, like every other class. |
| `LEGAL_HOLD` | A legal hold is in place. |
| `ACTIVE_ISSUERS` | Issuers are still `PENDING` or `ACTIVE`; suspend or revoke them first. |
| `ISSUER_REGISTRY_OUT_OF_SYNC` | An issuer was retired locally but its last confirmed on-chain status is still `ACTIVE`; synchronise the registry first. |

`GET /organizations/:id/deletion-eligibility` reports the same blockers as codes
with counts, never as identifiers.

**What deletion keeps.** Issuers, attestations, proofs and audit records are
not removed. A proof issued while the organization was live still verifies
after deletion, and an attestation stays resolvable through its issuer. Audit
records keep their own retention class (`audit_logs`); deleting an organization
does not shorten it.

## Audit legal holds

Audit records covered by an approved (or pending) legal hold are excluded from
the `audit_logs` sweep and its dry run until the hold is released, rejected or
expires. If holds cannot be read, audit cleanup fails closed for that run. See
[audit-legal-holds.md](audit-legal-holds.md).

## Test coverage

| Scenario | Where |
|---|---|
| Cutoff boundaries, including exact-boundary and one-millisecond cases | `retention-cleanup.service.spec.ts`, `retention-policy.spec.ts` |
| Restart mid-sweep and resumption without a cursor | `retention-cleanup.service.spec.ts` |
| Concurrent cleaners yielding to one another | `retention-cleanup.service.spec.ts` |
| Relation constraints — rotated sessions, non-failed anchoring intents | `retention-cleanup.service.spec.ts` |
| Dry run, and its agreement with a real run | `retention-cleanup.service.spec.ts` |
| Retention overrides, including invalid and out-of-range values | `retention-policy.spec.ts` |
| Preserved classes refusing to be swept | both suites |

```bash
npm run lint
npm run test -- --runInBand
npm run build
```

## Maintenance

- **Adding a class:** add it to `RETENTION_CLASSES` with its purpose, owner,
  default, cutoff column, and backing index; add a row above; map its Prisma
  delegate; add tests for its boundary and any relation constraint.
- **Changing a duration:** change the default in code or set the override. Dry
  run first.
- **Marking a class preserved:** set `SweepMode.PRESERVED` and write the reason.
  The reason is required — a preserved class without one fails its test.
- **Adding anonymisation:** the sweep implements deletion only. A class marked
  `ANONYMISE` and `AUTOMATED` is rejected at runtime rather than silently
  deleted; implement the anonymisation path explicitly first.
