/**
 * Health check contracts.
 *
 * The three probes answer deliberately different questions, and conflating them
 * is what this module exists to prevent:
 *
 * - Liveness  — "is this process running?"  Never touches an external system.
 * - Readiness — "can this process serve dependent work right now?"
 * - Diagnostics — "what exactly is wrong?"  Authorized callers only.
 */

import type { ClockSkewSnapshot } from "./clock-skew-monitor.service";

/**
 * Stable, safe status codes.
 *
 * Callers (and alerting rules) branch on these rather than on error strings, so
 * they must stay stable even when the underlying failure text changes. Raw
 * driver errors are never surfaced: a connection error commonly embeds the DSN,
 * including credentials.
 */
export const DependencyStatus = {
  /** Dependency answered within its timeout. */
  OK: "ok",
  /** Dependency answered, but reported a problem. */
  DEGRADED: "degraded",
  /** Dependency did not answer within its timeout. */
  TIMEOUT: "timeout",
  /** Dependency answered with an error, or could not be reached. */
  ERROR: "error",
  /** Dependency is intentionally switched off by configuration. */
  DISABLED: "disabled",
  /** Dependency is enabled but not configured well enough to be probed. */
  NOT_CONFIGURED: "not_configured",
} as const;

export type DependencyStatusValue =
  (typeof DependencyStatus)[keyof typeof DependencyStatus];

/**
 * Whether a dependency's health can make the service unready.
 *
 * Only REQUIRED dependencies gate readiness. Marking an optional dependency as
 * required is how an unrelated outage (say, Horizon) wrongly takes an entire
 * API offline, including routes that never touch it.
 */
export const DependencyKind = {
  REQUIRED: "required",
  OPTIONAL: "optional",
} as const;

export type DependencyKindValue =
  (typeof DependencyKind)[keyof typeof DependencyKind];

/** A single dependency probe result. */
export interface DependencyResult {
  name: string;
  kind: DependencyKindValue;
  status: DependencyStatusValue;
  /** Observed probe duration in milliseconds. Omitted when not probed. */
  durationMs?: number;
  /**
   * A stable, non-identifying reason code (never a raw error message).
   * Present only for non-OK statuses.
   */
  reason?: string;
  /** True when this result was served from cache rather than freshly probed. */
  cached?: boolean;
  /** Age of a cached result, in milliseconds. */
  ageMs?: number;
  /**
   * Per-circuit state, present only on the circuit-breaker dependency.
   *
   * Deliberately typed as counts-and-state records: it carries circuit names
   * and numbers, never a transaction payload, an address, or an error body, so
   * it is safe to render in the authorized diagnostics response.
   */
  circuits?: CircuitDiagnostic[];
  /**
   * Clock skew detail, present only on the `clock_skew` diagnostics entry.
   * Numbers, source names and stable codes only — see clock-skew-monitor.
   */
  clockSkew?: ClockSkewSnapshot;
}

/** Privacy-safe view of one circuit for the diagnostics endpoint. */
export interface CircuitDiagnostic {
  name: string;
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  probeSuccesses: number;
  probesInFlight: number;
  openCount: number;
  cooldownRemainingMs: number;
}

/** Aggregate readiness verdict. */
export interface ReadinessResult {
  status: "ready" | "not_ready";
  dependencies: DependencyResult[];
}
