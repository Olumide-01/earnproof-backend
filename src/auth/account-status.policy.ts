import { ResourceStatus, UserRole } from "@prisma/client";

/**
 * Account lifecycle policy: the single description of which account states
 * may authenticate, which administrative transitions are allowed, and which
 * transitions must end every live session.
 *
 * Kept free of Nest and Prisma client dependencies so the guard, the login
 * path and the users service all read the same table, and so the table can be
 * asserted exhaustively without a module.
 */

/**
 * States that may not hold or obtain a session.
 *
 * Read by `AuthGuard` on every request and by `AuthService` before a session
 * is issued, so a status change takes effect on the next request without
 * waiting for any token to expire.
 */
export const NON_AUTHENTICATING_STATUSES: ReadonlySet<ResourceStatus> = new Set([
  ResourceStatus.SUSPENDED,
  ResourceStatus.REVOKED,
  ResourceStatus.DELETED,
]);

export function canAuthenticate(status: ResourceStatus | string): boolean {
  return !NON_AUTHENTICATING_STATUSES.has(status as ResourceStatus);
}

/**
 * Administrative status transitions, by current status.
 *
 * - `SUSPENDED` is reversible; `REVOKED` is terminal.
 * - `DELETED` is never set through this API: deletion is a retention decision,
 *   not an account-state toggle.
 * - A same-state "transition" is not listed and is therefore rejected, so a
 *   repeated request cannot produce a second audit record for no change.
 */
export const ACCOUNT_STATUS_TRANSITIONS: Readonly<
  Record<ResourceStatus, readonly ResourceStatus[]>
> = {
  [ResourceStatus.PENDING]: [
    ResourceStatus.ACTIVE,
    ResourceStatus.SUSPENDED,
    ResourceStatus.REVOKED,
  ],
  [ResourceStatus.ACTIVE]: [ResourceStatus.SUSPENDED, ResourceStatus.REVOKED],
  [ResourceStatus.SUSPENDED]: [ResourceStatus.ACTIVE, ResourceStatus.REVOKED],
  [ResourceStatus.REVOKED]: [],
  [ResourceStatus.DELETED]: [],
  [ResourceStatus.EXPIRED]: [],
};

/** Statuses an administrator may request. `DELETED` is deliberately absent. */
export const ASSIGNABLE_ACCOUNT_STATUSES: readonly ResourceStatus[] = [
  ResourceStatus.ACTIVE,
  ResourceStatus.SUSPENDED,
  ResourceStatus.REVOKED,
];

export function isAllowedStatusTransition(
  from: ResourceStatus,
  to: ResourceStatus,
): boolean {
  return ACCOUNT_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Whether a transition revokes every live session of the account.
 *
 * Entering a non-authenticating state obviously does. Leaving one does too: a
 * login that passed its status check a moment before a suspension committed
 * can still mint a session, which the guard refuses while the account is
 * suspended but which would otherwise come back to life on reinstatement.
 * Revoking again on the way out means reinstatement never resurrects a
 * session, and the account simply signs in afresh.
 */
export function transitionRevokesSessions(
  from: ResourceStatus,
  to: ResourceStatus,
): boolean {
  return !canAuthenticate(to) || !canAuthenticate(from);
}

/**
 * Roles that may own an organisation.
 *
 * Organisation membership is currently implicit: the creator of an
 * organisation administers it (see `api-keys.controller.ts`). A user who still
 * owns a live organisation therefore cannot be demoted to a role outside this
 * set — the organisation would be left administered by an account whose role
 * says it administers nothing. Ownership must be retired first.
 */
export const ORGANIZATION_OWNER_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.ADMIN,
  UserRole.ISSUER,
  UserRole.DEVELOPER,
]);

/** Organisation states that still count as live ownership. */
export const LIVE_ORGANIZATION_STATUSES: readonly ResourceStatus[] = [
  ResourceStatus.ACTIVE,
  ResourceStatus.PENDING,
  ResourceStatus.SUSPENDED,
];

/** Reason codes accepted with a status change. Free text is not audited. */
export enum AccountStatusReason {
  POLICY_VIOLATION = "POLICY_VIOLATION",
  SECURITY_INCIDENT = "SECURITY_INCIDENT",
  FRAUD_SUSPECTED = "FRAUD_SUSPECTED",
  USER_REQUEST = "USER_REQUEST",
  REVIEW_COMPLETED = "REVIEW_COMPLETED",
  OTHER = "OTHER",
}
