/**
 * Core value types for registry capacity trend metrics.
 *
 * These types are shared between the sampler service, the trend calculator,
 * the operations controller, and test fixtures.  No NestJS decorators here —
 * this file must remain importable in pure-unit tests without a DI container.
 */

export const CAPACITY_SAMPLE_VERSION = "earnproof.capacity-sample.v1" as const;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * The four registry resources whose growth is tracked for capacity planning.
 */
export const ResourceType = {
  ISSUER: "ISSUER",
  SCHEMA: "SCHEMA",
  PROOF: "PROOF",
  STORAGE: "STORAGE",
} as const;

export type ResourceTypeValue = (typeof ResourceType)[keyof typeof ResourceType];

/** All valid resource types as a frozen set. */
export const KNOWN_RESOURCE_TYPES = new Set<string>(
  Object.values(ResourceType),
);

/**
 * Alert severity for a capacity trend.
 *
 * CLEAR  — growth is within safe bounds.
 * WARNING — growth rate suggests exhaustion within the warning window.
 * CRITICAL — exhaustion estimated within the critical window.
 * STALE  — the newest sample is older than the staleness threshold; existing
 *          alerts are NOT cleared (stale data cannot clear an alert).
 */
export const AlertStateValue = {
  CLEAR: "CLEAR",
  WARNING: "WARNING",
  CRITICAL: "CRITICAL",
  STALE: "STALE",
} as const;

export type AlertState = (typeof AlertStateValue)[keyof typeof AlertStateValue];

// ---------------------------------------------------------------------------
// Sample shape
// ---------------------------------------------------------------------------

/**
 * A single aggregate capacity sample.
 *
 * Contains only aggregate counts — no private records, no wallet addresses,
 * no proof IDs, no user data.  The hash binds the sample content for replay
 * detection.
 */
export interface CapacitySample {
  resourceType: ResourceTypeValue;
  count: number;
  sampleHash: string;
  sampledAt: Date;
}

// ---------------------------------------------------------------------------
// Trend result
// ---------------------------------------------------------------------------

/**
 * Calculated trend for a single resource type over historical samples.
 */
export interface CapacityTrend {
  resourceType: ResourceTypeValue;
  /** Number of samples used in the calculation. */
  sampleCount: number;
  /** Most recent count. */
  currentCount: number;
  /** Growth rate (units per day), computed from linear regression. */
  ratePerDay: number;
  /** Estimated days until exhaustion at current rate, or null if rate <= 0. */
  exhaustionEstimateDays: number | null;
  /** Current alert state. */
  alert: AlertState;
  /** Timestamp of the newest sample in the series. */
  newestSampleAt: Date | null;
  /** Whether the data is stale (newest sample exceeds staleness threshold). */
  isStale: boolean;
  /** Human-readable label for the estimate, e.g. "exhausted in ~90 days". */
  estimateLabel: string;
}