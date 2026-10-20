/**
 * CapacityTrendService
 *
 * Calculates growth rates, exhaustion estimates, and alert states from
 * historical capacity samples.
 *
 * Design principles:
 * - Pure calculation logic (testable without DI for the core function).
 * - Stale data cannot clear an alert: if the newest sample exceeds the
 *   staleness threshold, the alert state is STALE, not CLEAR — even if the
 *   historical rate was low.
 * - Estimates are labeled (human-readable strings) so consumers can display
 *   them without re-deriving the semantics.
 * - Boundary behavior: zero samples → STALE, one sample → CLEAR (no rate data),
 *   negative rate → CLEAR (shrinking), positive rate → computed estimate.
 */

import { Injectable, Logger } from "@nestjs/common";
import {
  AlertStateValue,
  CapacitySample,
  CapacityTrend,
  ResourceTypeValue,
} from "./capacity-types";
import { CapacitySamplerService } from "./capacity-sampler.service";

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Days before data is considered stale. */
export const STALENESS_THRESHOLD_DAYS = 1;

/** Days within which exhaustion triggers a WARNING. */
export const WARNING_WINDOW_DAYS = 90;

/** Days within which exhaustion triggers CRITICAL. */
export const CRITICAL_WINDOW_DAYS = 30;

/** Assumed maximum capacity per resource type (for exhaustion estimation). */
export const CAPACITY_LIMITS: Record<ResourceTypeValue, number> = {
  ISSUER: 10_000,
  SCHEMA: 100,
  PROOF: 1_000_000,
  STORAGE: 100_000,
};

// ---------------------------------------------------------------------------
// Pure calculation function (testable without DI)
// ---------------------------------------------------------------------------

/**
 * Calculate a capacity trend from historical samples.
 *
 * Uses linear regression on (days since first sample, count) to estimate the
 * growth rate.  Exhaustion estimate = (capacityLimit - currentCount) / ratePerDay.
 *
 * @param samples     Historical samples, oldest first.
 * @param resourceType  The resource type being analyzed.
 * @param now          Override for current time (testing).  Defaults to new Date().
 */
export function calculateTrend(
  samples: CapacitySample[],
  resourceType: ResourceTypeValue,
  now: Date = new Date(),
): CapacityTrend {
  const baseResult: Omit<CapacityTrend, "alert" | "estimateLabel"> = {
    resourceType,
    sampleCount: samples.length,
    currentCount: samples.length > 0 ? samples[samples.length - 1].count : 0,
    ratePerDay: 0,
    exhaustionEstimateDays: null,
    newestSampleAt: samples.length > 0 ? samples[samples.length - 1].sampledAt : null,
    isStale: false,
  };

  // No samples → stale
  if (samples.length === 0) {
    return {
      ...baseResult,
      alert: AlertStateValue.STALE,
      estimateLabel: "No samples available — data is stale",
      isStale: true,
    };
  }

  // Check staleness
  const newest = samples[samples.length - 1];
  const stalenessMs = now.getTime() - newest.sampledAt.getTime();
  const stalenessDays = stalenessMs / (1000 * 60 * 60 * 24);
  const isStale = stalenessDays > STALENESS_THRESHOLD_DAYS;

  if (isStale) {
    return {
      ...baseResult,
      alert: AlertStateValue.STALE,
      estimateLabel: `Data is stale (newest sample ${stalenessDays.toFixed(1)} days old)`,
      isStale: true,
    };
  }

  // One sample → cannot compute rate
  if (samples.length < 2) {
    return {
      ...baseResult,
      alert: AlertStateValue.CLEAR,
      estimateLabel: "Insufficient samples for trend analysis",
      isStale: false,
    };
  }

  // Linear regression: y = a + b*x, where x = days since first sample, y = count
  const firstSample = samples[0];
  const xValues: number[] = [];
  const yValues: number[] = [];

  for (const s of samples) {
    const daysSinceFirst =
      (s.sampledAt.getTime() - firstSample.sampledAt.getTime()) /
      (1000 * 60 * 60 * 24);
    xValues.push(daysSinceFirst);
    yValues.push(s.count);
  }

  const n = xValues.length;
  const sumX = xValues.reduce((a, b) => a + b, 0);
  const sumY = yValues.reduce((a, b) => a + b, 0);
  const sumXY = xValues.reduce((sum, x, i) => sum + x * yValues[i], 0);
  const sumX2 = xValues.reduce((sum, x) => sum + x * x, 0);

  const denominator = n * sumX2 - sumX * sumX;
  const ratePerDay = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;

  // No growth or shrinking → clear
  if (ratePerDay <= 0) {
    return {
      ...baseResult,
      ratePerDay,
      exhaustionEstimateDays: null,
      alert: AlertStateValue.CLEAR,
      estimateLabel: "No growth detected — capacity is stable or shrinking",
      isStale: false,
    };
  }

  // Exhaustion estimate
  const capacityLimit = CAPACITY_LIMITS[resourceType] ?? Infinity;
  const remaining = capacityLimit - baseResult.currentCount;

  if (remaining <= 0) {
    return {
      ...baseResult,
      ratePerDay,
      exhaustionEstimateDays: 0,
      alert: AlertStateValue.CRITICAL,
      estimateLabel: "Capacity limit already reached",
      isStale: false,
    };
  }

  const exhaustionDays = remaining / ratePerDay;

  let alert: typeof AlertStateValue[keyof typeof AlertStateValue];
  let estimateLabel: string;

  if (exhaustionDays <= CRITICAL_WINDOW_DAYS) {
    alert = AlertStateValue.CRITICAL;
    estimateLabel = `Exhaustion estimated in ~${Math.ceil(exhaustionDays)} day(s) — CRITICAL`;
  } else if (exhaustionDays <= WARNING_WINDOW_DAYS) {
    alert = AlertStateValue.WARNING;
    estimateLabel = `Exhaustion estimated in ~${Math.ceil(exhaustionDays)} days — WARNING`;
  } else {
    alert = AlertStateValue.CLEAR;
    estimateLabel = `Exhaustion estimated in ~${Math.ceil(exhaustionDays)} days — within safe bounds`;
  }

  return {
    ...baseResult,
    ratePerDay,
    exhaustionEstimateDays: Math.ceil(exhaustionDays),
    alert,
    estimateLabel,
    isStale: false,
  };
}

// ---------------------------------------------------------------------------
// Injectable service
// ---------------------------------------------------------------------------

@Injectable()
export class CapacityTrendService {
  private readonly logger = new Logger(CapacityTrendService.name);

  constructor(private readonly sampler: CapacitySamplerService) {}

  /**
   * Calculate trend for a single resource type.
   */
  async getTrend(
    resourceType: ResourceTypeValue,
  ): Promise<CapacityTrend> {
    const samples = await this.sampler.getRecentSamples(resourceType, 50);
    const trend = calculateTrend(samples, resourceType);
    this.logger.debug(
      `Trend for ${resourceType}: alert=${trend.alert}, rate=${trend.ratePerDay.toFixed(2)}/day`,
    );
    return trend;
  }

  /**
   * Calculate trends for all resource types.
   */
  async getAllTrends(): Promise<CapacityTrend[]> {
    const types: ResourceTypeValue[] = [
      "ISSUER" as ResourceTypeValue,
      "SCHEMA" as ResourceTypeValue,
      "PROOF" as ResourceTypeValue,
      "STORAGE" as ResourceTypeValue,
    ];
    const trends = await Promise.all(
      types.map((t) => this.getTrend(t)),
    );
    return trends;
  }
}