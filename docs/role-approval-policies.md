# Organization role approval policies

Dual-control role changes are governed by a versioned, per-organization policy
(issue #298). This document covers what the policy may contain, who may change
it, and how stale, concurrent and replayed updates behave.

Implementation: `src/organizations/role-approval-policy/`. The rules live in
`role-approval-policy.rules.ts` as pure functions; the service owns persistence,
authorization and concurrency.

## Policy fields

| Field | Meaning | Platform bound |
| --- | --- | --- |
| `protectedRoles` | Roles whose grant **or** removal needs approval | Must include `OWNER` and `ADMIN` |
| `approverRoles` | Roles that may approve | Subset of `OWNER`, `ADMIN`; not empty |
| `requiredApprovals` | Distinct approvals needed | 1 to 5 inclusive |
| `approvalExpiryMinutes` | How long a request stays open | 15 to 10080 (7 days) inclusive |
| `ownerChangesRequireOwnerApproval` | A change touching `OWNER` needs an `OWNER` approver | If `true`, `approverRoles` must include `OWNER` |

Separation of duties is not configurable. Every policy reports:

- `selfApprovalProhibited: true`: the requester never approves their own change.
- `targetApprovalProhibited: true`: the member whose role changes never approves it.
- `distinctApproversRequired: true`: one approver counts once.

A request may restate these as `true`. Sending `false` is reported as
`SELF_APPROVAL_CANNOT_BE_ENABLED` / `TARGET_APPROVAL_CANNOT_BE_ENABLED` and is
never stored.

An organization that has never saved a policy is governed by the platform
default, reported as **version 0** (`isDefault: true`): OWNER and ADMIN
protected, OWNER and ADMIN approve, one approval, 24-hour expiry, owner changes
need an owner.

## Endpoints

All under `/api/v1/organizations/:organizationId/role-approval-policy`, bearer
session.

| Route | Who | Result |
| --- | --- | --- |
| `GET` | Any ACTIVE member, or platform `ADMIN` | Active policy (or version 0 default) |
| `GET /history?limit&beforeVersion` | Any ACTIVE member, or platform `ADMIN` | Stored versions newest first; `nextBeforeVersion` cursor. Version 0 is never listed. |
| `POST /preview` | Organization `ADMIN`/`OWNER`, or platform `ADMIN` | Validation, field diff, staleness, optional `sampleChange` evaluation. Nothing is saved. |
| `PUT` | Organization `OWNER`, or platform `ADMIN` | New version; previous one becomes `SUPERSEDED` |

Organization `ADMIN`s can preview but not update: the policy governs ADMIN
changes, so ADMINs do not set their own controls.

## Validation and failure behaviour

Checks run in this order, so the same request always gets the same answer:

1. **401** no session. **404** organization missing or deleted.
2. **403** not an ACTIVE member, or below the required organization role.
   Suspended memberships count as no membership.
3. **400** structurally invalid body (wrong type, unknown role, unknown field).
4. `PUT` only: **409** organization archived.
5. `PUT` only: **400** platform-minimum violations, returned as
   `{ message, violations: [{ code, field, message }] }` with every violation in
   a fixed order. `preview` returns the same list in a **200** with `valid: false`.
6. `PUT` only: **409** when `expectedVersion` is not the active version.
7. `PUT` only: **400** when the proposal is identical to the active version.

Violation codes: `UNKNOWN_ROLE`, `PROTECTED_ROLES_BELOW_PLATFORM_MINIMUM`,
`APPROVER_ROLES_EMPTY`, `APPROVER_ROLE_NOT_PERMITTED`,
`OWNER_APPROVAL_REQUIRES_OWNER_APPROVER`, `REQUIRED_APPROVALS_OUT_OF_RANGE`,
`APPROVAL_EXPIRY_OUT_OF_RANGE`, `SELF_APPROVAL_CANNOT_BE_ENABLED`,
`TARGET_APPROVAL_CANNOT_BE_ENABLED`.

## Stale state, concurrency and replay

Every `PUT` names the version it was based on (`expectedVersion`, 0 for the
default). The write supersedes the ACTIVE row with a conditional update and
inserts the next version under a unique `(organizationId, version)` index.
Consequently:

- Two concurrent updates from the same base: exactly one commits, the other
  gets **409**.
- Replaying a successful update: its base version is no longer active, so
  **409**. Nothing is written twice.
- History is append-only; a version is never edited after it is written.

Every update is audited as `organization.role_approval_policy.updated` with the
version numbers and the names of changed fields.

## Scope

This change stores and serves the policy. Enforcing it on individual role
changes (collecting approvals per change) is a separate piece of work.
`POST /preview` with `sampleChange` shows what the policy would require.
