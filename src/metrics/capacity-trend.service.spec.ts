import { CapacitySample, ResourceType, ResourceTypeValue } from "./capacity-types";
import {
  calculateTrend,
  CRITICAL_WINDOW_DAYS,
  STALENESS_THRESHOLD_DAYS,
  WARNING_WINDOW_DAYS,
  CAPACITY_LIMITS,
} from "./capacity-trend.service";

const NOW = new Date("2025-06-01T00:00:00.000Z");
const RESOURCE = ResourceType.PROOF;

/** Build a fresh series of `count` samples ending 1 minute before NOW. */
function freshSeries(
  resourceType: ResourceTypeValue,
  count: number,
  baseCount: number,
  rate: number,
): CapacitySample[] {
  const series: CapacitySample[] = [];
  for (let i = 0; i < count; i++) {
    const dayOffset = i - (count - 1);
    const sampledAt = new Date(
      NOW.getTime() + dayOffset * 24 * 60 * 60 * 1000 - 60_000,
    );
    const c = Math.max(0, Math.floor(baseCount + rate * i));
    series.push({
      resourceType,
      count: c,
      sampleHash: `sha256:fresh-${i}`,
      sampledAt,
    });
  }
  return series;
}

describe("calculateTrend() — zero/one sample", () => {
  it("returns STALE with no samples", () => {
    const trend = calculateTrend([], RESOURCE, NOW);
    expect(trend.alert).toBe("STALE");
    expect(trend.isStale).toBe(true);
  });

  it("returns CLEAR with one fresh sample", () => {
    const sample: CapacitySample = {
      resourceType: RESOURCE,
      count: 100,
      sampleHash: "sha256:abc",
      sampledAt: new Date(NOW.getTime() - 60_000),
    };
    const trend = calculateTrend([sample], RESOURCE, NOW);
    expect(trend.alert).toBe("CLEAR");
    expect(trend.ratePerDay).toBe(0);
    expect(trend.exhaustionEstimateDays).toBeNull();
  });
});

describe("calculateTrend() — staleness", () => {
  it("returns STALE when newest sample exceeds threshold", () => {
    const staleDate = new Date(
      NOW.getTime() - (STALENESS_THRESHOLD_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    const staleSamples: CapacitySample[] = Array.from({ length: 5 }, (_, i) => ({
      resourceType: RESOURCE,
      count: 100 + i,
      sampleHash: `sha256:stale-${i}`,
      sampledAt: staleDate,
    }));
    const trend = calculateTrend(staleSamples, RESOURCE, NOW);
    expect(trend.alert).toBe("STALE");
    expect(trend.isStale).toBe(true);
  });

  it("stale data cannot clear an alert (returns STALE not CLEAR)", () => {
    const staleDate = new Date(
      NOW.getTime() - (STALENESS_THRESHOLD_DAYS + 2) * 24 * 60 * 60 * 1000,
    );
    const staleSamples: CapacitySample[] = [
      { resourceType: RESOURCE, count: 50, sampleHash: "sha256:s1", sampledAt: staleDate },
      { resourceType: RESOURCE, count: 50, sampleHash: "sha256:s2", sampledAt: staleDate },
    ];
    const trend = calculateTrend(staleSamples, RESOURCE, NOW);
    expect(trend.alert).toBe("STALE");
    expect(trend.alert).not.toBe("CLEAR");
  });
});

describe("calculateTrend() — rate and alerts", () => {
  it("returns CLEAR when growth is well within bounds", () => {
    const samples = freshSeries(RESOURCE, 31, 100, 2);
    const trend = calculateTrend(samples, RESOURCE, NOW);
    expect(trend.alert).toBe("CLEAR");
    expect(trend.ratePerDay).toBeGreaterThan(0);
    expect(trend.exhaustionEstimateDays).toBeGreaterThan(WARNING_WINDOW_DAYS);
  });

  it("returns WARNING when exhaustion is within warning window", () => {
    const limit = CAPACITY_LIMITS[RESOURCE];
    const currentCount = limit - WARNING_WINDOW_DAYS * 500;
    const samples = freshSeries(RESOURCE, 10, currentCount, 500);
    const trend = calculateTrend(samples, RESOURCE, NOW);
    expect(["WARNING", "CRITICAL"]).toContain(trend.alert);
  });

  it("returns CRITICAL when exhaustion is within critical window", () => {
    const limit = CAPACITY_LIMITS[RESOURCE];
    const currentCount = limit - CRITICAL_WINDOW_DAYS * 1000;
    const samples = freshSeries(RESOURCE, 10, currentCount, 1000);
    const trend = calculateTrend(samples, RESOURCE, NOW);
    expect(trend.alert).toBe("CRITICAL");
    expect(trend.exhaustionEstimateDays).toBeLessThanOrEqual(CRITICAL_WINDOW_DAYS);
  });

  it("returns CRITICAL when capacity already exceeded", () => {
    const limit = CAPACITY_LIMITS[RESOURCE];
    const samples = freshSeries(RESOURCE, 5, limit + 100, 10);
    const trend = calculateTrend(samples, RESOURCE, NOW);
    expect(trend.alert).toBe("CRITICAL");
    expect(trend.exhaustionEstimateDays).toBe(0);
  });

  it("returns CLEAR with zero growth rate", () => {
    const samples = freshSeries(RESOURCE, 10, 500, 0);
    const trend = calculateTrend(samples, RESOURCE, NOW);
    expect(trend.alert).toBe("CLEAR");
    expect(trend.exhaustionEstimateDays).toBeNull();
  });

  it("returns CLEAR with negative growth (shrinking)", () => {
    const samples = freshSeries(RESOURCE, 10, 1000, -5);
    const trend = calculateTrend(samples, RESOURCE, NOW);
    expect(trend.alert).toBe("CLEAR");
  });
});

describe("calculateTrend() — determinism", () => {
  it("produces identical output for identical input", () => {
    const samples = freshSeries(RESOURCE, 20, 100, 10);
    const r1 = calculateTrend(samples, RESOURCE, NOW);
    const r2 = calculateTrend(samples, RESOURCE, NOW);
    expect(r1.alert).toBe(r2.alert);
    expect(r1.ratePerDay).toBe(r2.ratePerDay);
    expect(r1.exhaustionEstimateDays).toBe(r2.exhaustionEstimateDays);
    expect(r1.estimateLabel).toBe(r2.estimateLabel);
  });
});

describe("calculateTrend() — estimate labels", () => {
  it("includes a non-empty estimate label in all cases", () => {
    const cases = [
      { samples: [] as CapacitySample[], expected: /stale|available/i },
      { samples: freshSeries(RESOURCE, 1, 100, 0), expected: /insufficient|CLEAR|stable/i },
      { samples: freshSeries(RESOURCE, 10, 100, 1), expected: /days|stable|safe/i },
    ];
    for (const { samples, expected } of cases) {
      const trend = calculateTrend(samples, RESOURCE, NOW);
      expect(trend.estimateLabel).toMatch(expected);
    }
  });
});