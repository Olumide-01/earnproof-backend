/**
 * Core types for semantic permission change diffs.
 *
 * A "permission diff" is a stable before-and-after record of a role, scope,
 * or governance permission change. It is versioned, canonically hashed, and
 * attached to the audit record for the triggering mutation.
 *
 * Design constraints:
 *  - Secrets never enter diffs. Only permission names, grant/revoke flags, and
 *    actor hashes are recorded.
 *  - Unknown permissions fail validation — the set of valid permissions is
 *    declared here and checked before any diff is persisted.
 *  - Inherited permissions are made explicit in the diff (they are listed even
 *    if the caller did not change them, so the before-snapshot is complete).
 *  - The diff hash binds the content so replay detection and tamper evidence
 *    are built in.
 */

export const PERMISSION_DIFF_VERSION = "earnproof.permission-diff.v1" as const;

// ─── Permission kinds ────────────────────────────────────────────────────────

/** User role permissions. */
export const ROLE_PERMISSIONS = {
  WORKER: "role:WORKER",
  ISSUER: "role:ISSUER",
  ADMIN: "role:ADMIN",
  DEVELOPER: "role:DEVELOPER",
} as const;

/** API key scope permissions. */
export const SCOPE_PERMISSIONS = {
  PROOF_READ: "scope:PROOF_READ",
  PROOF_VERIFY: "scope:PROOF_VERIFY",
  PAYMENT_READ: "scope:PAYMENT_READ",
  PAYMENT_WRITE: "scope:PAYMENT_WRITE",
  ORG_READ: "scope:ORG_READ",
  ORG_ADMIN: "scope:ORG_ADMIN",
} as const;

/** Governance approval permissions. */
export const GOVERNANCE_PERMISSIONS = {
  APPROVE_ISSUER: "governance:APPROVE_ISSUER",
  REVOKE_ISSUER: "governance:REVOKE_ISSUER",
  APPROVE_CONTRACT_UPGRADE: "governance:APPROVE_CONTRACT_UPGRADE",
  MANAGE_TRUSTED_SOURCES: "governance:MANAGE_TRUSTED_SOURCES",
} as const;

/** All declared permissions — unknown values fail validation. */
export const ALL_PERMISSIONS: ReadonlySet<string> = new Set([
  ...Object.values(ROLE_PERMISSIONS),
  ...Object.values(SCOPE_PERMISSIONS),
  ...Object.values(GOVERNANCE_PERMISSIONS),
]);

export type PermissionName = string;

/** The kind of permission being changed. */
export type PermissionKind = "role" | "scope" | "governance";

// ─── Diff entry ──────────────────────────────────────────────────────────────

/** Operation performed on a single permission. */
export type PermissionOperation = "grant" | "revoke" | "inherit" | "unchanged";

/** One entry in the permission diff. */
export interface PermissionDiffEntry {
  permission: PermissionName;
  kind: PermissionKind;
  operation: PermissionOperation;
  /** True when this permission was inherited from a parent role, not explicitly set. */
  inherited: boolean;
}

// ─── Full diff ───────────────────────────────────────────────────────────────

/** Complete semantic diff for a permission change event. */
export interface PermissionDiff {
  version: typeof PERMISSION_DIFF_VERSION;
  /** The resource whose permissions changed (e.g. userId, apiKeyId). */
  subjectId: string;
  /** Kind of subject: "user", "api_key", or "governance". */
  subjectKind: "user" | "api_key" | "governance";
  /** SHA-256 of the actor's wallet hash — never raw address. */
  actorHash: string;
  /** Complete before-snapshot (all permissions, including inherited). */
  before: PermissionDiffEntry[];
  /** Complete after-snapshot. */
  after: PermissionDiffEntry[];
  /** Only the changed entries (grants and revokes). */
  changes: PermissionDiffEntry[];
  /** Deterministic hash of the canonical diff body. */
  diffHash: string;
  /** ISO-8601 timestamp of the change. */
  changedAt: string;
}