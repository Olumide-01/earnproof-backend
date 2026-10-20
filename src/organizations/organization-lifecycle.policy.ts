import {
  RETENTION_CLASSES,
  resolveRetentionDays,
  type RetentionClass,
} from "../jobs/retention/retention-policy";

/**
 * Organization retirement lifecycle.
 *
 *   LIVE ──archive──▶ ARCHIVED ──delete──▶ DELETED
 *     ▲                  │
 *     └─────restore──────┘
 *
 * The lifecycle is orthogonal to `Organization.status` (PENDING, ACTIVE,
 * SUSPENDED, ...), which keeps its existing meaning and is restored untouched.
 * It is carried by two timestamps rather than new enum values so that no other
 * resource sharing `ResourceStatus` changes shape.
 *
 * A legal hold may be placed on a live or archived organization and blocks
 * deletion only; it never blocks archiving or restoring.
 */
export enum OrganizationLifecycleState {
  LIVE = "LIVE",
  ARCHIVED = "ARCHIVED",
  DELETED = "DELETED",
}

export function lifecycleStateOf(org: {
  archivedAt: Date | null;
  deletedAt: Date | null;
}): OrganizationLifecycleState {
  if (org.deletedAt) return OrganizationLifecycleState.DELETED;
  if (org.archivedAt) return OrganizationLifecycleState.ARCHIVED;
  return OrganizationLifecycleState.LIVE;
}

/**
 * Why an organization cannot be deleted yet.
 *
 * The report carries a code and a count, never an identifier, name or address:
 * it answers "what must be retired first", not "which records exist".
 */
export enum DeletionBlockerCode {
  /** Deletion is only accepted from the archived state. */
  NOT_ARCHIVED = "NOT_ARCHIVED",
  /** The minimum archive (restore) window has not elapsed. */
  ARCHIVE_RETENTION_PERIOD = "ARCHIVE_RETENTION_PERIOD",
  /** A legal hold forbids destructive cleanup. */
  LEGAL_HOLD = "LEGAL_HOLD",
  /** Issuers that are PENDING or ACTIVE must be suspended or revoked first. */
  ACTIVE_ISSUERS = "ACTIVE_ISSUERS",
  /**
   * Issuers retired locally whose last confirmed on-chain status is still
   * ACTIVE. The registry must be synchronised first, or the contract would
   * keep vouching for an issuer whose organization no longer exists.
   */
  ISSUER_REGISTRY_OUT_OF_SYNC = "ISSUER_REGISTRY_OUT_OF_SYNC",
}

export interface DeletionBlocker {
  code: DeletionBlockerCode;
  /** Number of dependent records behind the blocker, where that applies. */
  count?: number;
}

export const ARCHIVED_ORGANIZATION_RETENTION: RetentionClass = (() => {
  const entry = RETENTION_CLASSES.find((c) => c.key === "archived_organizations");
  if (!entry) {
    throw new Error("retention class archived_organizations is not declared");
  }
  return entry;
})();

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The instant after which an organization archived at `archivedAt` may be
 * deleted. The boundary is exclusive, matching every other retention class: a
 * record exactly at the end of its period is still retained.
 */
export function deletableAfter(
  archivedAt: Date,
  env: NodeJS.ProcessEnv = process.env,
): Date {
  const days = resolveRetentionDays(ARCHIVED_ORGANIZATION_RETENTION, env);
  return new Date(archivedAt.getTime() + days * DAY_MS);
}

/** True when the minimum archive period has fully elapsed at `now`. */
export function archiveRetentionElapsed(
  archivedAt: Date,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return now > deletableAfter(archivedAt, env);
}

/** Placeholder name written over a deleted organization's display name. */
export const DELETED_ORGANIZATION_NAME = "Deleted organization";
