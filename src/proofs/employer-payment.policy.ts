import { ResourceStatus } from "@prisma/client";

/**
 * Employer-payment proof policy (earnproof-backend#165).
 *
 * Pure functions only: no database or clock access, so every rule here is
 * testable in isolation and the service stays a thin orchestration layer.
 * See docs/employer-payment-proof.md for the normative description.
 */

export const EMPLOYER_PAYMENT_POLICY_VERSION =
  "earnproof.employer-payment.policy.v1";

/** Longest period a single proof may cover. */
export const MAX_EMPLOYER_PAYMENT_PERIOD_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Upper bound on candidate payments considered per request. The query loads
 * the most recent candidates in a deterministic order, so the bound keeps the
 * request cheap without making the selected payment depend on row order.
 */
export const MAX_EMPLOYER_PAYMENT_CANDIDATES = 200;

/**
 * How the issuer vouches for the payer address.
 *
 * - `issuer_account`: the payment was sent from the issuer's own registered
 *   Stellar account.
 * - `issuer_attestation`: the issuer holds an active PAYMENT attestation for
 *   the subject that references this exact payment.
 *
 * A trusted source alone is never enough: users create trusted sources
 * themselves and could otherwise link any address to any issuer.
 */
export type EmployerCorroboration = "issuer_account" | "issuer_attestation";

export type EmployerPaymentPeriodViolation =
  | "invalid_date"
  | "empty_or_inverted"
  | "too_long"
  | "ends_in_future";

/**
 * Validates the half-open period `[periodStart, periodEnd)`.
 *
 * Half-open bounds mean two consecutive proofs never both claim a payment that
 * lands exactly on their shared boundary.
 */
export function validateEmployerPaymentPeriod(
  periodStart: Date,
  periodEnd: Date,
  now: Date,
): EmployerPaymentPeriodViolation | null {
  if (
    Number.isNaN(periodStart.getTime()) ||
    Number.isNaN(periodEnd.getTime())
  ) {
    return "invalid_date";
  }
  if (periodStart.getTime() >= periodEnd.getTime()) {
    return "empty_or_inverted";
  }
  if (
    periodEnd.getTime() - periodStart.getTime() >
    MAX_EMPLOYER_PAYMENT_PERIOD_DAYS * DAY_MS
  ) {
    return "too_long";
  }
  if (periodEnd.getTime() > now.getTime()) {
    return "ends_in_future";
  }
  return null;
}

export function isWithinEmployerPaymentPeriod(
  occurredAt: Date,
  periodStart: Date,
  periodEnd: Date,
): boolean {
  const at = occurredAt.getTime();
  return at >= periodStart.getTime() && at < periodEnd.getTime();
}

export type EmployerSourceRecord = {
  id: string;
  sourceAddress: string;
  status: ResourceStatus;
  issuerId: string | null;
  issuer: {
    id: string;
    status: ResourceStatus;
    stellarAddress: string;
    organization: { status: ResourceStatus } | null;
  } | null;
};

export type EmployerSourceResolution =
  | {
      ok: true;
      issuerId: string;
      sourceAddress: string;
      /** True when the payer address is the issuer's own registered account. */
      isIssuerAccount: boolean;
    }
  | {
      ok: false;
      reason:
        | "source_inactive"
        | "source_unlinked"
        | "issuer_inactive"
        | "organization_inactive"
        | "ambiguous_issuer";
    };

/**
 * Resolves the employer identity behind a trusted source.
 *
 * `conflictingIssuerId` is the id of an issuer whose registered Stellar
 * account equals the source address, if any. When that issuer differs from the
 * one the source is linked to, the address is claimed by two employers and
 * cannot identify either of them.
 */
export function resolveEmployerSource(
  source: EmployerSourceRecord,
  conflictingIssuerId: string | null,
): EmployerSourceResolution {
  if (source.status !== ResourceStatus.ACTIVE) {
    return { ok: false, reason: "source_inactive" };
  }
  if (!source.issuerId || !source.issuer) {
    return { ok: false, reason: "source_unlinked" };
  }
  if (source.issuer.status !== ResourceStatus.ACTIVE) {
    return { ok: false, reason: "issuer_inactive" };
  }
  if (source.issuer.organization?.status !== ResourceStatus.ACTIVE) {
    return { ok: false, reason: "organization_inactive" };
  }
  if (conflictingIssuerId && conflictingIssuerId !== source.issuer.id) {
    return { ok: false, reason: "ambiguous_issuer" };
  }

  return {
    ok: true,
    issuerId: source.issuer.id,
    sourceAddress: source.sourceAddress,
    isIssuerAccount: source.issuer.stellarAddress === source.sourceAddress,
  };
}

export type EmployerPaymentCandidate = {
  id: string;
  operationId: string;
  occurredAt: Date;
};

/**
 * Deterministic candidate order: most recent first, ties broken by the
 * immutable Stellar operation id. Independent of database row order, so the
 * same request always selects the same payment.
 */
export function orderEmployerPaymentCandidates<
  T extends EmployerPaymentCandidate,
>(candidates: readonly T[]): T[] {
  return [...candidates].sort((left, right) => {
    const byTime = right.occurredAt.getTime() - left.occurredAt.getTime();
    if (byTime !== 0) return byTime;
    if (left.operationId < right.operationId) return -1;
    if (left.operationId > right.operationId) return 1;
    return 0;
  });
}

/**
 * Picks the first corroborated candidate in deterministic order.
 *
 * `attestedReferences` holds the payment reference hashes the issuer has
 * actively attested for this subject; it is ignored for `issuer_account`
 * sources because the payer is the issuer itself.
 */
export function selectEmployerPayment<T extends EmployerPaymentCandidate>(
  candidates: readonly T[],
  isIssuerAccount: boolean,
  attestedReferences: ReadonlySet<string>,
  referenceOf: (candidate: T) => string,
): { payment: T; corroboration: EmployerCorroboration } | null {
  for (const candidate of orderEmployerPaymentCandidates(candidates)) {
    if (isIssuerAccount) {
      return { payment: candidate, corroboration: "issuer_account" };
    }
    if (attestedReferences.has(referenceOf(candidate))) {
      return { payment: candidate, corroboration: "issuer_attestation" };
    }
  }
  return null;
}
