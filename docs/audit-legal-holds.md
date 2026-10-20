# Audit retention legal holds

A legal hold suspends retention cleanup for a bounded range of audit records,
for example under a court order or a regulator request (issue #311). Holds are
scoped, approved by a second administrator, expire, and never carry the case
narrative.

Implementation: `src/audit/legal-holds/`. The retention integration is in
`src/jobs/retention/retention-cleanup.service.ts`.

This is separate from the organization-level legal hold in
[data-retention.md](data-retention.md#organization-lifecycle), which blocks
deleting an organization.

## What a hold records

| Field | Notes |
| --- | --- |
| `scope` | `ORGANIZATION` (requires `organizationId`) or `PLATFORM` (every organization and SYSTEM records) |
| `authority` | `COURT_ORDER`, `REGULATOR_REQUEST`, `LITIGATION_COUNSEL`, `INTERNAL_INVESTIGATION` |
| `reasonCommitment` | Lowercase hex SHA-256 the requester computed over their own reason material |
| `rangeStart`, `rangeEnd` | Inclusive bounds on `AuditLog.createdAt` |
| `expiresAt` | Exclusive end of protection, at most 730 days ahead |
| Approval and release actors | `requestedById`, `approvedById`, `releaseRequestedById`, `releasedById` and timestamps |

There is no free-text column. The commitment proves which reason was cited
without the narrative reaching this service, its logs or its audit trail.
Database CHECK constraints back this up: the commitment must match the hex
format, scope and organization must agree, and approver ≠ requester, releaser ≠
release requester.

## Lifecycle

```
PENDING_APPROVAL ──approve──▶ ACTIVE ──release-request──▶ RELEASE_PENDING ──release──▶ RELEASED
        │
        └──reject──▶ REJECTED
```

All routes are under `/api/v1/admin/audit-legal-holds` and require the platform
`ADMIN` role.

| Route | Rule |
| --- | --- |
| `POST /` | Creates `PENDING_APPROVAL`. Protects records immediately. |
| `POST /:id/approve` | A different administrator from the requester. Before the approval deadline. |
| `POST /:id/reject` | A different administrator from the requester. |
| `POST /:id/release-request` | Any administrator. The hold keeps protecting records. |
| `POST /:id/release` | A different administrator from the one who requested the release. |
| `GET /`, `GET /:id` | List (cursor-paged) and read. Each hold reports `inEffect`. |

Every transition is audited (`audit.legal_hold.requested|approved|rejected|release_requested|released`)
with structured fields only.

## When a hold is in effect

At instant `now`, a hold protects records when:

- it is `ACTIVE` or `RELEASE_PENDING` and `now < expiresAt`; or
- it is `PENDING_APPROVAL`, `now < approvalDeadline` and `now < expiresAt`.

`approvalDeadline` is 72 hours after the request, or `expiresAt` if sooner. A
pending hold therefore protects records while it awaits approval, so the
approval window cannot be used to race the sweep, but it lapses if nobody
approves it. One administrator acting alone cannot suspend cleanup for longer
than that.

Boundaries are exact. At `now == expiresAt` the hold no longer protects. At
`now == approvalDeadline` a pending hold has lapsed and can no longer be
approved. A record whose `createdAt` equals `rangeStart` or `rangeEnd` is held.

## Cleanup integration

The `audit_logs` retention class excludes every record covered by a hold in
effect at the run's evaluation instant:

- Holds are read before each batch's select, and **again** before the delete
  statement, which repeats the exclusion. A hold that commits between selection
  and deletion still protects its records.
- A dry run applies the same exclusion, so plans and executions agree.
- **Fail closed:** if the hold table cannot be read, or more than 100 holds are
  in effect, the `audit_logs` class is reported as failed for that run and
  nothing is deleted. Other classes are unaffected.
- Organization holds match only rows with that `organizationId`. The filter
  guards against NULL so SYSTEM rows are not accidentally retained by an
  organization hold.

Records are retained only for as long as a hold is in effect. Once it is
released, rejected, lapsed or expired, the next run removes whatever the normal
retention period allows.

## Failure, stale-state and replay behaviour

Each transition body is `{ "expectedRevision": n }`. Checks run in a fixed
order:

1. **404** unknown hold.
2. **409** `expectedRevision` is not the current revision (stale or replayed).
3. **409** the hold is not in the status the action requires.
4. **403** the same administrator on both sides of a decision.
5. **409** approval deadline or expiry passed.

The update is conditional on `(id, status, revision)`. Of two concurrent
decisions, exactly one applies; the other gets **409**. Replaying a successful
decision is **409** because the revision has moved on.

Creation is refused with **400** for an organization hold without
`organizationId`, a platform hold with one, an inverted range, a range wider
than 3650 days, an expiry not in the future or more than 730 days ahead. It is
refused with **404** for an unknown organization, and **409** when 100 holds
are already in effect.
