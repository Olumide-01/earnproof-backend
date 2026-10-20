import { ResourceStatus } from "@prisma/client";

/**
 * The effective status of an issuer attestation (#207).
 *
 * Stored `status` records lifecycle decisions (active, suspended, revoked); it
 * does not by itself account for expiry, which happens with the passage of time
 * rather than an explicit action. The effective status folds expiry into the
 * stored status so every reader — the reconciliation job, the API, an issuance
 * check — reaches the same verdict from the same inputs, without mutating the
 * historical signed evidence.
 */
export type EffectiveAttestationStatus =
  | "ACTIVE"
  | "EXPIRED"
  | "REVOKED"
  | "SUSPENDED"
  | "PENDING";

/** The minimal attestation fields the effective status depends on. */
export interface AttestationStatusInput {
  status: ResourceStatus;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Default clock-skew tolerance, in milliseconds.
 *
 * An attestation is treated as expired only once the clock is past its expiry by
 * more than this tolerance, so a small difference between the issuer's clock and
 * this service's clock does not flip a just-valid attestation to expired. Chosen
 * conservatively at one minute; overridable per call for tests and configuration.
 */
export const DEFAULT_ATTESTATION_CLOCK_SKEW_MS = 60_000;

/**
 * Compute the effective status of an attestation at instant `now`.
 *
 * Precedence is explicit and total, so the outcome is deterministic:
 *  1. Revoked (by flag or status) wins over everything — revocation is final.
 *  2. Suspended is reported as-is.
 *  3. Pending is reported as-is (never yet active).
 *  4. An active attestation past its expiry (plus skew) is EXPIRED.
 *  5. Otherwise ACTIVE.
 *
 * The expiry comparison is strict and one-sided: expired only when
 * `now > expiresAt + clockSkewMs`. At exactly the boundary the attestation is
 * still valid, so the boundary belongs to exactly one side every time.
 */
export function computeEffectiveAttestationStatus(
  attestation: AttestationStatusInput,
  now: Date,
  clockSkewMs: number = DEFAULT_ATTESTATION_CLOCK_SKEW_MS,
): EffectiveAttestationStatus {
  if (attestation.revokedAt !== null || attestation.status === ResourceStatus.REVOKED) {
    return "REVOKED";
  }
  if (attestation.status === ResourceStatus.SUSPENDED) return "SUSPENDED";
  if (attestation.status === ResourceStatus.PENDING) return "PENDING";

  if (
    attestation.expiresAt !== null &&
    now.getTime() > attestation.expiresAt.getTime() + clockSkewMs
  ) {
    return "EXPIRED";
  }

  return "ACTIVE";
}

/**
 * Whether an attestation may authorize new issuance at instant `now`.
 *
 * Only an effectively ACTIVE attestation qualifies: expired, revoked, suspended,
 * and pending attestations must not authorize issuance, regardless of what the
 * stored `status` column still says before the reconciler has run.
 */
export function canAttestationAuthorizeIssuance(
  attestation: AttestationStatusInput,
  now: Date,
  clockSkewMs: number = DEFAULT_ATTESTATION_CLOCK_SKEW_MS,
): boolean {
  return (
    computeEffectiveAttestationStatus(attestation, now, clockSkewMs) === "ACTIVE"
  );
}
