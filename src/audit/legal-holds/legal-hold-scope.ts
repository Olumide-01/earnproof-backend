import { AuditLegalHold, AuditLegalHoldStatus } from "@prisma/client";

/**
 * Which audit records a legal hold protects, and when (#311).
 *
 * Shared by the hold service and the retention sweep so "held" has exactly one
 * definition. Pure: callers supply `now`.
 *
 * A hold is **in effect** at instant `now` when:
 * - it is ACTIVE or RELEASE_PENDING, and `now < expiresAt`; or
 * - it is PENDING_APPROVAL, and `now < approvalDeadline` and `now < expiresAt`.
 *
 * Pending holds protect records from the moment they are requested, so the
 * approval window cannot be used to race the sweep. They lapse at their
 * approval deadline if nobody approves them, which bounds how long one
 * administrator acting alone can suspend cleanup.
 *
 * A record is **held** by an in-effect hold when its `createdAt` lies in
 * `[rangeStart, rangeEnd]` (both inclusive) and, for an ORGANIZATION hold, its
 * `organizationId` equals the hold's. PLATFORM holds cover every organization
 * and organization-less (SYSTEM) records in the range.
 */

/** Holds that may protect records. RELEASED and REJECTED never do. */
export const PROTECTIVE_STATUSES: readonly AuditLegalHoldStatus[] = [
  "PENDING_APPROVAL",
  "ACTIVE",
  "RELEASE_PENDING",
];

/**
 * Upper bound on in-effect holds.
 *
 * Keeps the exclusion clause the sweep adds to its query bounded. Creation is
 * refused at the limit, and the sweep fails closed (skips audit cleanup) if it
 * ever observes more, rather than deleting with a truncated hold list.
 */
export const MAX_HOLDS_IN_EFFECT = 100;

export type HoldCoverage = Pick<
  AuditLegalHold,
  "scope" | "organizationId" | "rangeStart" | "rangeEnd"
>;

type HoldTiming = Pick<AuditLegalHold, "status" | "approvalDeadline" | "expiresAt">;

/** Prisma `where` selecting holds in effect at `now`. */
export function holdsInEffectWhere(now: Date) {
  return {
    expiresAt: { gt: now },
    OR: [
      { status: { in: ["ACTIVE", "RELEASE_PENDING"] as AuditLegalHoldStatus[] } },
      { status: "PENDING_APPROVAL" as AuditLegalHoldStatus, approvalDeadline: { gt: now } },
    ],
  };
}

/** The same rule as {@link holdsInEffectWhere}, for one loaded hold. */
export function isHoldInEffect(hold: HoldTiming, now: Date): boolean {
  if (now.getTime() >= hold.expiresAt.getTime()) return false;
  if (hold.status === "ACTIVE" || hold.status === "RELEASE_PENDING") return true;
  if (hold.status === "PENDING_APPROVAL") {
    return now.getTime() < hold.approvalDeadline.getTime();
  }
  return false;
}

/**
 * Prisma `where` fragment excluding every AuditLog row the holds protect.
 *
 * `organizationId: { equals, not: null }` is deliberate: without the explicit
 * `not: null`, SQL three-valued logic would make `NOT (organizationId = X ...)`
 * NULL for SYSTEM rows, silently excluding them from cleanup too. Returns an
 * empty object when there are no holds, leaving the query unchanged.
 */
export function auditLogHoldExclusion(
  holds: readonly HoldCoverage[],
): { NOT?: Record<string, unknown>[] } {
  if (holds.length === 0) return {};

  return {
    NOT: holds.map((hold) => ({
      ...(hold.scope === "ORGANIZATION"
        ? { organizationId: { equals: hold.organizationId, not: null } }
        : {}),
      createdAt: { gte: hold.rangeStart, lte: hold.rangeEnd },
    })),
  };
}

/** Whether one audit record is covered by any of the holds. */
export function isAuditRecordHeld(
  record: { organizationId: string | null; createdAt: Date },
  holds: readonly HoldCoverage[],
): boolean {
  const at = record.createdAt.getTime();
  return holds.some(
    (hold) =>
      at >= hold.rangeStart.getTime() &&
      at <= hold.rangeEnd.getTime() &&
      (hold.scope === "PLATFORM" ||
        (record.organizationId !== null && record.organizationId === hold.organizationId)),
  );
}
