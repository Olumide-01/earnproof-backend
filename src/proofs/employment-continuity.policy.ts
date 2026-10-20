/**
 * Employment-continuity proof policy (earnproof-backend#166).
 *
 * Pure functions only. The parameters below are part of the policy version:
 * changing any of them requires a new version string, and issued proofs keep
 * the parameters they were evaluated under (they are embedded in the
 * credential), so a policy change never alters an existing proof's meaning.
 * See docs/employment-continuity-proof.md.
 */

export const EMPLOYMENT_CONTINUITY_POLICY_VERSION =
  "earnproof.employment-continuity.policy.v1";

/** Periods are UTC calendar months. Local time zones play no part. */
export const CONTINUITY_PERIOD_UNIT = "calendar-month-utc";

/** Minimum observation length, in periods. */
export const MIN_CONTINUITY_PERIODS = 3;

/** Maximum observation length, in periods. */
export const MAX_CONTINUITY_PERIODS = 24;

/** Periods without a qualifying payment that are still tolerated. */
export const MAX_MISSING_CONTINUITY_PERIODS = 1;

/**
 * Upper bound on payments evaluated per request. Exceeding it is refused
 * rather than truncated, so the outcome never depends on which rows a
 * truncated query happened to return.
 */
export const MAX_CONTINUITY_PAYMENTS = 2_000;

export type ContinuityWindowViolation =
  | "invalid_date"
  | "not_period_aligned"
  | "invalid_period_count"
  | "window_not_complete";

export type ContinuityWindow = {
  start: Date;
  /** Exclusive end: the first instant after the last period. */
  end: Date;
  periods: number;
};

export function isUtcMonthStart(value: Date): boolean {
  return (
    !Number.isNaN(value.getTime()) &&
    value.getUTCDate() === 1 &&
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  );
}

export function addUtcMonths(value: Date, months: number): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1),
  );
}

/**
 * Builds the observation window of `periods` consecutive UTC months starting
 * at `start`. Only completed months can be observed, so the window must end
 * at or before `now`.
 */
export function buildContinuityWindow(
  start: Date,
  periods: number,
  now: Date,
): { window: ContinuityWindow } | { violation: ContinuityWindowViolation } {
  if (Number.isNaN(start.getTime())) return { violation: "invalid_date" };
  if (!isUtcMonthStart(start)) return { violation: "not_period_aligned" };
  if (
    !Number.isInteger(periods) ||
    periods < MIN_CONTINUITY_PERIODS ||
    periods > MAX_CONTINUITY_PERIODS
  ) {
    return { violation: "invalid_period_count" };
  }

  const end = addUtcMonths(start, periods);
  if (end.getTime() > now.getTime()) {
    return { violation: "window_not_complete" };
  }
  return { window: { start, end, periods } };
}

/**
 * Index of the single period containing `occurredAt`, or null when it falls
 * outside the window. Periods are half-open, so an instant belongs to exactly
 * one period: a payment at 00:00:00.000Z on the 1st is in the new month, one
 * millisecond earlier is in the previous one.
 */
export function continuityPeriodIndex(
  occurredAt: Date,
  window: ContinuityWindow,
): number | null {
  const at = occurredAt.getTime();
  if (
    Number.isNaN(at) ||
    at < window.start.getTime() ||
    at >= window.end.getTime()
  ) {
    return null;
  }
  const index =
    (occurredAt.getUTCFullYear() - window.start.getUTCFullYear()) * 12 +
    (occurredAt.getUTCMonth() - window.start.getUTCMonth());
  return index >= 0 && index < window.periods ? index : null;
}

export type ContinuityPayment = { operationId: string; occurredAt: Date };

export type ContinuityEvaluation<T extends ContinuityPayment> = {
  continuous: boolean;
  coveredPeriods: number;
  missingPeriods: number;
  /** Payments that fell inside the window, one per operation id, sorted. */
  includedPayments: T[];
};

/**
 * Evaluates the continuity rule:
 *
 * - every payment is assigned to exactly one period (or none);
 * - a repeated operation id counts once;
 * - several payments in one period cover it once;
 * - at most MAX_MISSING_CONTINUITY_PERIODS periods may lack a payment;
 * - the first and the last period must both be covered, so the observation
 *   actually spans the whole window.
 *
 * The result is independent of input order.
 */
export function evaluateContinuity<T extends ContinuityPayment>(
  payments: readonly T[],
  window: ContinuityWindow,
): ContinuityEvaluation<T> {
  const byOperation = new Map<string, T>();
  for (const payment of payments) {
    const existing = byOperation.get(payment.operationId);
    // Keep the earliest record for a repeated operation id so the choice is
    // deterministic even if a caller passes conflicting duplicates.
    if (
      !existing ||
      payment.occurredAt.getTime() < existing.occurredAt.getTime()
    ) {
      byOperation.set(payment.operationId, payment);
    }
  }

  const covered = new Array<boolean>(window.periods).fill(false);
  const includedPayments: T[] = [];
  for (const payment of byOperation.values()) {
    const index = continuityPeriodIndex(payment.occurredAt, window);
    if (index === null) continue;
    covered[index] = true;
    includedPayments.push(payment);
  }
  includedPayments.sort((left, right) => {
    const byTime = left.occurredAt.getTime() - right.occurredAt.getTime();
    if (byTime !== 0) return byTime;
    return left.operationId < right.operationId
      ? -1
      : left.operationId > right.operationId
        ? 1
        : 0;
  });

  const coveredPeriods = covered.filter(Boolean).length;
  const missingPeriods = window.periods - coveredPeriods;
  const continuous =
    missingPeriods <= MAX_MISSING_CONTINUITY_PERIODS &&
    covered[0] === true &&
    covered[window.periods - 1] === true;

  return { continuous, coveredPeriods, missingPeriods, includedPayments };
}
