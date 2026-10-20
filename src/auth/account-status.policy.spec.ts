import { ResourceStatus, UserRole } from "@prisma/client";
import {
  ACCOUNT_STATUS_TRANSITIONS,
  ASSIGNABLE_ACCOUNT_STATUSES,
  canAuthenticate,
  isAllowedStatusTransition,
  ORGANIZATION_OWNER_ROLES,
  transitionRevokesSessions,
} from "./account-status.policy";

const ALL_STATUSES = Object.values(ResourceStatus);

describe("account status policy", () => {
  it.each([
    [ResourceStatus.ACTIVE, true],
    [ResourceStatus.PENDING, true],
    [ResourceStatus.SUSPENDED, false],
    [ResourceStatus.REVOKED, false],
    [ResourceStatus.DELETED, false],
  ])("canAuthenticate(%s) is %s", (status, expected) => {
    expect(canAuthenticate(status)).toBe(expected);
  });

  it("declares a transition list for every status, so a new enum value cannot fall through", () => {
    expect(Object.keys(ACCOUNT_STATUS_TRANSITIONS).sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
  });

  // The complete matrix, written out: a change to the policy must change this
  // table too, which is the point.
  const allowed: Array<[ResourceStatus, ResourceStatus]> = [
    [ResourceStatus.PENDING, ResourceStatus.ACTIVE],
    [ResourceStatus.PENDING, ResourceStatus.SUSPENDED],
    [ResourceStatus.PENDING, ResourceStatus.REVOKED],
    [ResourceStatus.ACTIVE, ResourceStatus.SUSPENDED],
    [ResourceStatus.ACTIVE, ResourceStatus.REVOKED],
    [ResourceStatus.SUSPENDED, ResourceStatus.ACTIVE],
    [ResourceStatus.SUSPENDED, ResourceStatus.REVOKED],
  ];

  it.each(
    ALL_STATUSES.flatMap((from) => ALL_STATUSES.map((to) => [from, to] as const)),
  )("transition %s -> %s matches the declared matrix", (from, to) => {
    const expected = allowed.some(([a, b]) => a === from && b === to);
    expect(isAllowedStatusTransition(from, to)).toBe(expected);
  });

  it("never allows a same-state transition", () => {
    for (const status of ALL_STATUSES) {
      expect(isAllowedStatusTransition(status, status)).toBe(false);
    }
  });

  it("treats REVOKED and DELETED as terminal", () => {
    expect(ACCOUNT_STATUS_TRANSITIONS.REVOKED).toEqual([]);
    expect(ACCOUNT_STATUS_TRANSITIONS.DELETED).toEqual([]);
  });

  it("never lets an administrator assign DELETED or PENDING", () => {
    expect(ASSIGNABLE_ACCOUNT_STATUSES).not.toContain(ResourceStatus.DELETED);
    expect(ASSIGNABLE_ACCOUNT_STATUSES).not.toContain(ResourceStatus.PENDING);
  });

  it.each([
    [ResourceStatus.ACTIVE, ResourceStatus.SUSPENDED, true],
    [ResourceStatus.ACTIVE, ResourceStatus.REVOKED, true],
    [ResourceStatus.PENDING, ResourceStatus.SUSPENDED, true],
    [ResourceStatus.SUSPENDED, ResourceStatus.REVOKED, true],
    // Reinstatement must not resurrect a session minted during suspension.
    [ResourceStatus.SUSPENDED, ResourceStatus.ACTIVE, true],
    // Activating a pending account keeps the sessions it already holds.
    [ResourceStatus.PENDING, ResourceStatus.ACTIVE, false],
  ])("transition %s -> %s revokes sessions: %s", (from, to, expected) => {
    expect(transitionRevokesSessions(from, to)).toBe(expected);
  });

  it("excludes WORKER from organization-owning roles", () => {
    expect(ORGANIZATION_OWNER_ROLES.has(UserRole.WORKER)).toBe(false);
    expect(ORGANIZATION_OWNER_ROLES.has(UserRole.ADMIN)).toBe(true);
  });
});
