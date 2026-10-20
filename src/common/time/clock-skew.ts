/**
 * Clock skew measurement and classification (earnproof-backend#328).
 *
 * Authentication challenges, session expiry, cooldowns and ledger finality all
 * compare this process's wall clock against times minted elsewhere — by a
 * wallet, by Horizon, by the Stellar network. Those comparisons are only
 * meaningful while the local clock agrees with network time within a bound.
 * This module answers "how far apart are they, provably?" and nothing else.
 *
 * It never adjusts a clock. Correcting time is the host's job (NTP/chrony);
 * an application that nudged its own notion of "now" would make every expiry
 * decision depend on whichever time source it last believed.
 *
 * Everything here is pure: the caller supplies the local send/receive instants
 * read from the injected `Clock`, so every boundary is testable without sleeps.
 */

/** Health of local time relative to trusted network time. */
export const ClockSkewStatus = {
  /** Provable skew is below the warning threshold. */
  OK: "ok",
  /** Provable skew is at or above the warning threshold. */
  WARNING: "warning",
  /** Provable skew is at or above the critical threshold. */
  CRITICAL: "critical",
  /** No fresh, usable sample exists, so skew cannot be bounded at all. */
  UNKNOWN: "unknown",
} as const;

export type ClockSkewStatusValue =
  (typeof ClockSkewStatus)[keyof typeof ClockSkewStatus];

/**
 * What an UNKNOWN time health means for callers that must decide.
 *
 * - `fail_closed` — unknown is treated like a critical breach.
 * - `fail_open`   — unknown is reported, but never treated as a breach.
 *
 * There is deliberately no implicit default inside the classifier: the policy
 * is always passed in, so the decision is visible at the call site.
 */
export type UnknownTimePolicy = "fail_closed" | "fail_open";

/** One raw observation of a trusted time source. */
export interface TimeSourceReading {
  /** The instant the source asserts, as epoch milliseconds. */
  referenceMs: number;
  /**
   * Resolution of `referenceMs`. A value truncated to whole seconds is up to
   * 999ms earlier than the instant it describes, so this is typically 1000.
   */
  resolutionMs: number;
  /**
   * How far the asserted instant may trail the source's own "now". A ledger
   * close time trails network time by up to one ledger interval; an HTTP
   * `Date` header trails by ~0. Never negative.
   */
  maxReferenceLagMs: number;
  /**
   * Optional monotonic position of the reference (a ledger sequence). A
   * reading whose sequence is below the last accepted one is a replayed or
   * cached response and is discarded rather than trusted.
   */
  sequence?: number;
}

/** A reading bracketed by the local instants the request was sent and answered. */
export interface TimeSample extends TimeSourceReading {
  source: string;
  localSentMs: number;
  localReceivedMs: number;
}

/** Thresholds and freshness bounds. All values are milliseconds. */
export interface ClockSkewPolicy {
  warnMs: number;
  criticalMs: number;
  /** Samples with a longer round trip carry too much uncertainty to use. */
  maxRoundTripMs: number;
  /** Samples older than this (by local receive time) are ignored. */
  maxSampleAgeMs: number;
  unknownPolicy: UnknownTimePolicy;
}

/** Why a sample was not used. Stable, non-identifying codes. */
export type SampleRejection =
  | "invalid_reading"
  | "local_clock_regressed"
  | "round_trip_exceeded"
  | "stale_reference";

/** A sample's provable offset bounds, local minus network time. */
export interface SkewEstimate {
  source: string;
  /** Lower bound of (local − network), ms. */
  lowerMs: number;
  /** Upper bound of (local − network), ms. */
  upperMs: number;
  /**
   * The smallest skew consistent with the bounds: 0 when the interval
   * contains zero, otherwise the bound nearest zero. Positive means the local
   * clock is ahead. This never overstates skew.
   */
  skewMs: number;
  roundTripMs: number;
  observedAtMs: number;
}

/** The outcome of classifying a set of samples at one instant. */
export interface ClockSkewAssessment {
  status: ClockSkewStatusValue;
  /** Provable skew used for the verdict; absent when UNKNOWN. */
  skewMs?: number;
  /** Source whose estimate produced the verdict; absent when UNKNOWN. */
  source?: string;
  /** Stable reason for UNKNOWN; absent otherwise. */
  reason?: "no_samples" | "no_fresh_samples";
  /** Number of fresh samples considered. */
  samplesConsidered: number;
  evaluatedAtMs: number;
}

/** Raised when a policy is internally inconsistent. */
export class ClockSkewPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClockSkewPolicyError";
  }
}

/** Rejects a policy whose thresholds cannot produce a meaningful verdict. */
export function assertValidClockSkewPolicy(policy: ClockSkewPolicy): void {
  const positive: Array<keyof ClockSkewPolicy> = [
    "warnMs",
    "criticalMs",
    "maxRoundTripMs",
    "maxSampleAgeMs",
  ];
  for (const key of positive) {
    const value = policy[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ClockSkewPolicyError(`${key} must be a positive finite number`);
    }
  }
  if (policy.criticalMs <= policy.warnMs) {
    throw new ClockSkewPolicyError("criticalMs must be greater than warnMs");
  }
  if (policy.unknownPolicy !== "fail_closed" && policy.unknownPolicy !== "fail_open") {
    throw new ClockSkewPolicyError("unknownPolicy must be fail_closed or fail_open");
  }
}

/**
 * Bounds (local − network) for one sample.
 *
 * Let m be the local midpoint of the request and h half the round trip, so the
 * source produced its reading at some local instant in [m − h, m + h]. The
 * source's true time at that moment lies in
 * [reference, reference + resolution + maxReferenceLag]. Subtracting gives the
 * interval of offsets consistent with the observation; nothing narrower can be
 * claimed without trusting the network path to be symmetric.
 */
export function estimateSkew(
  sample: TimeSample,
  policy: Pick<ClockSkewPolicy, "maxRoundTripMs">,
  lastSequence?: number,
): SkewEstimate | SampleRejection {
  const numbers = [
    sample.referenceMs,
    sample.resolutionMs,
    sample.maxReferenceLagMs,
    sample.localSentMs,
    sample.localReceivedMs,
  ];
  if (
    numbers.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
    sample.resolutionMs < 0 ||
    sample.maxReferenceLagMs < 0
  ) {
    return "invalid_reading";
  }

  const roundTripMs = sample.localReceivedMs - sample.localSentMs;
  if (roundTripMs < 0) {
    // The local clock stepped backwards mid-request. The bracket is
    // meaningless, and this module must not guess which instant was right.
    return "local_clock_regressed";
  }
  // Exact boundary: a round trip equal to the limit is still usable.
  if (roundTripMs > policy.maxRoundTripMs) {
    return "round_trip_exceeded";
  }

  if (
    sample.sequence !== undefined &&
    lastSequence !== undefined &&
    sample.sequence < lastSequence
  ) {
    return "stale_reference";
  }

  const sourceLatestMs =
    sample.referenceMs + sample.resolutionMs + sample.maxReferenceLagMs;
  const lowerMs = sample.localSentMs - sourceLatestMs;
  const upperMs = sample.localReceivedMs - sample.referenceMs;

  return {
    source: sample.source,
    lowerMs,
    upperMs,
    skewMs: nearestToZero(lowerMs, upperMs),
    roundTripMs,
    observedAtMs: sample.localReceivedMs,
  };
}

/**
 * Classifies the freshest estimate per source at `nowMs`.
 *
 * With several sources, the estimate of smallest magnitude decides. A clock
 * that is genuinely wrong is wrong against every source, so this can only
 * under-report when every source is simultaneously misleading — while a single
 * broken source can never page an operator on its own.
 */
export function classifySkew(
  estimates: readonly SkewEstimate[],
  policy: ClockSkewPolicy,
  nowMs: number,
): ClockSkewAssessment {
  if (estimates.length === 0) {
    return {
      status: ClockSkewStatus.UNKNOWN,
      reason: "no_samples",
      samplesConsidered: 0,
      evaluatedAtMs: nowMs,
    };
  }

  // Exact boundary: a sample exactly maxSampleAgeMs old is still fresh.
  const fresh = estimates.filter(
    (estimate) =>
      nowMs - estimate.observedAtMs <= policy.maxSampleAgeMs &&
      estimate.observedAtMs <= nowMs,
  );
  if (fresh.length === 0) {
    return {
      status: ClockSkewStatus.UNKNOWN,
      reason: "no_fresh_samples",
      samplesConsidered: 0,
      evaluatedAtMs: nowMs,
    };
  }

  // Deterministic tie-break: smallest magnitude, then source name.
  const decisive = [...fresh].sort(
    (a, b) =>
      Math.abs(a.skewMs) - Math.abs(b.skewMs) || a.source.localeCompare(b.source),
  )[0];

  return {
    status: statusForSkew(decisive.skewMs, policy),
    skewMs: decisive.skewMs,
    source: decisive.source,
    samplesConsidered: fresh.length,
    evaluatedAtMs: nowMs,
  };
}

/** Exact boundary: a skew equal to a threshold is classified at that threshold. */
export function statusForSkew(
  skewMs: number,
  policy: Pick<ClockSkewPolicy, "warnMs" | "criticalMs">,
): ClockSkewStatusValue {
  const magnitude = Math.abs(skewMs);
  if (magnitude >= policy.criticalMs) return ClockSkewStatus.CRITICAL;
  if (magnitude >= policy.warnMs) return ClockSkewStatus.WARNING;
  return ClockSkewStatus.OK;
}

/**
 * Whether an assessment counts as a breach for alerting and gating, applying
 * the explicit unknown-time policy.
 */
export function breachSeverity(
  assessment: Pick<ClockSkewAssessment, "status">,
  unknownPolicy: UnknownTimePolicy,
): "warning" | "critical" | null {
  switch (assessment.status) {
    case ClockSkewStatus.CRITICAL:
      return "critical";
    case ClockSkewStatus.WARNING:
      return "warning";
    case ClockSkewStatus.UNKNOWN:
      return unknownPolicy === "fail_closed" ? "critical" : null;
    default:
      return null;
  }
}

/** Sustained-deviation alerting parameters. */
export interface SustainedAlertPolicy {
  /** A breach must persist this long (inclusive) before an alert is raised. */
  sustainForMs: number;
  /** Consecutive non-breaching assessments required to clear an alert. */
  clearAfterAssessments: number;
}

/** Alert state carried between assessments. */
export interface SustainedAlertState {
  /** Local instant the current unbroken breach began, if one is in progress. */
  breachStartedAtMs: number | null;
  /** Severity of the raised alert, or null when no alert is active. */
  activeSeverity: "warning" | "critical" | null;
  /** Consecutive non-breaching assessments since the alert was raised. */
  healthyStreak: number;
}

export const INITIAL_ALERT_STATE: SustainedAlertState = Object.freeze({
  breachStartedAtMs: null,
  activeSeverity: null,
  healthyStreak: 0,
});

export type AlertTransition =
  | { type: "raised"; severity: "warning" | "critical" }
  | { type: "escalated"; severity: "critical" }
  | { type: "deescalated"; severity: "warning" }
  | { type: "cleared" };

/**
 * Advances the alert state machine by one assessment.
 *
 * Pure and total: the same state and inputs always yield the same next state
 * and transition, so replaying an assessment sequence reproduces exactly the
 * alerts that were raised.
 */
export function advanceAlert(
  state: SustainedAlertState,
  severity: "warning" | "critical" | null,
  nowMs: number,
  policy: SustainedAlertPolicy,
): { state: SustainedAlertState; transition: AlertTransition | null } {
  if (severity === null) {
    if (state.activeSeverity === null) {
      return {
        state: { breachStartedAtMs: null, activeSeverity: null, healthyStreak: 0 },
        transition: null,
      };
    }
    const healthyStreak = state.healthyStreak + 1;
    if (healthyStreak >= policy.clearAfterAssessments) {
      return {
        state: { breachStartedAtMs: null, activeSeverity: null, healthyStreak: 0 },
        transition: { type: "cleared" },
      };
    }
    // Still alerting; the breach clock restarts if the deviation returns.
    return {
      state: { breachStartedAtMs: null, activeSeverity: state.activeSeverity, healthyStreak },
      transition: null,
    };
  }

  const breachStartedAtMs = state.breachStartedAtMs ?? nowMs;

  if (state.activeSeverity === null) {
    if (nowMs - breachStartedAtMs >= policy.sustainForMs) {
      return {
        state: { breachStartedAtMs, activeSeverity: severity, healthyStreak: 0 },
        transition: { type: "raised", severity },
      };
    }
    return {
      state: { breachStartedAtMs, activeSeverity: null, healthyStreak: 0 },
      transition: null,
    };
  }

  const next: SustainedAlertState = {
    breachStartedAtMs,
    activeSeverity: severity,
    healthyStreak: 0,
  };
  if (state.activeSeverity === severity) {
    return { state: next, transition: null };
  }
  return {
    state: next,
    transition:
      severity === "critical"
        ? { type: "escalated", severity: "critical" }
        : { type: "deescalated", severity: "warning" },
  };
}

function nearestToZero(lowerMs: number, upperMs: number): number {
  if (lowerMs <= 0 && upperMs >= 0) return 0;
  return lowerMs > 0 ? lowerMs : upperMs;
}
