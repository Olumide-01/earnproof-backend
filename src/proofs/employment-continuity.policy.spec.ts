import {
  MAX_CONTINUITY_PERIODS,
  MIN_CONTINUITY_PERIODS,
  addUtcMonths,
  buildContinuityWindow,
  continuityPeriodIndex,
  evaluateContinuity,
  isUtcMonthStart,
} from "./employment-continuity.policy";

const now = new Date("2026-09-15T00:00:00.000Z");
const start = new Date("2026-01-01T00:00:00.000Z");

function windowOf(periods = 6) {
  const built = buildContinuityWindow(start, periods, now);
  if (!("window" in built)) throw new Error("expected a window");
  return built.window;
}

function payment(operationId: string, iso: string) {
  return { operationId, occurredAt: new Date(iso) };
}

/** One payment on the 15th of each listed month (1-based) of 2026. */
function monthly(months: number[]) {
  return months.map((month) =>
    payment(
      `op-${month}`,
      `2026-${String(month).padStart(2, "0")}-15T12:00:00.000Z`,
    ),
  );
}

describe("employment-continuity policy", () => {
  describe("window", () => {
    it("builds consecutive UTC calendar months with an exclusive end", () => {
      expect(windowOf(6)).toEqual({
        start,
        end: new Date("2026-07-01T00:00:00.000Z"),
        periods: 6,
      });
    });

    it("crosses a year boundary", () => {
      expect(addUtcMonths(new Date("2025-11-01T00:00:00Z"), 3)).toEqual(
        new Date("2026-02-01T00:00:00Z"),
      );
    });

    it.each([
      ["mid-month start", "2026-01-15T00:00:00.000Z"],
      ["non-midnight start", "2026-01-01T00:00:00.001Z"],
      // Midnight on the 1st in UTC+1 is 23:00 on the previous day in UTC.
      ["local-time month start", "2026-02-01T00:00:00+01:00"],
    ])("rejects a %s as not period-aligned", (_label, iso) => {
      expect(buildContinuityWindow(new Date(iso), 3, now)).toEqual({
        violation: "not_period_aligned",
      });
    });

    it("accepts a UTC month start written with a zero offset", () => {
      expect(
        isUtcMonthStart(new Date("2026-01-01T00:00:00+00:00")),
      ).toBe(true);
    });

    it.each([
      [MIN_CONTINUITY_PERIODS - 1],
      [MAX_CONTINUITY_PERIODS + 1],
      [3.5],
    ])("rejects %s observed periods", (periods) => {
      expect(buildContinuityWindow(start, periods, now)).toEqual({
        violation: "invalid_period_count",
      });
    });

    it("accepts the minimum and maximum observation lengths", () => {
      expect(
        buildContinuityWindow(
          new Date("2026-06-01T00:00:00Z"),
          MIN_CONTINUITY_PERIODS,
          now,
        ),
      ).toHaveProperty("window");
      expect(
        buildContinuityWindow(
          new Date("2024-09-01T00:00:00Z"),
          MAX_CONTINUITY_PERIODS,
          now,
        ),
      ).toHaveProperty("window");
    });

    it("requires every observed month to have ended", () => {
      const endsNow = new Date("2026-09-01T00:00:00.000Z");
      expect(
        buildContinuityWindow(new Date("2026-06-01T00:00:00Z"), 3, endsNow),
      ).toHaveProperty("window");
      expect(
        buildContinuityWindow(
          new Date("2026-06-01T00:00:00Z"),
          3,
          new Date(endsNow.getTime() - 1),
        ),
      ).toEqual({ violation: "window_not_complete" });
    });

    it("rejects an invalid date", () => {
      expect(buildContinuityWindow(new Date("nope"), 3, now)).toEqual({
        violation: "invalid_date",
      });
    });
  });

  describe("period assignment", () => {
    const window = windowOf(6);

    it("assigns month boundaries to exactly one period (UTC)", () => {
      expect(
        continuityPeriodIndex(new Date("2026-01-31T23:59:59.999Z"), window),
      ).toBe(0);
      expect(
        continuityPeriodIndex(new Date("2026-02-01T00:00:00.000Z"), window),
      ).toBe(1);
      // 00:30 on 1 Feb in UTC+1 is still January in UTC.
      expect(
        continuityPeriodIndex(new Date("2026-02-01T00:30:00+01:00"), window),
      ).toBe(0);
    });

    it("excludes instants outside the half-open window", () => {
      expect(
        continuityPeriodIndex(new Date("2025-12-31T23:59:59.999Z"), window),
      ).toBeNull();
      expect(continuityPeriodIndex(window.start, window)).toBe(0);
      expect(continuityPeriodIndex(window.end, window)).toBeNull();
    });

    it("never places a payment in more than one period", () => {
      for (
        let at = window.start.getTime();
        at < window.end.getTime();
        at += 6 * 60 * 60 * 1000
      ) {
        const instant = new Date(at);
        const matches = Array.from({ length: window.periods }, (_, index) => {
          const periodStart = addUtcMonths(window.start, index);
          const periodEnd = addUtcMonths(window.start, index + 1);
          return instant >= periodStart && instant < periodEnd;
        }).filter(Boolean).length;
        expect(matches).toBe(1);
        expect(continuityPeriodIndex(instant, window)).not.toBeNull();
      }
    });
  });

  describe("evaluateContinuity", () => {
    const window = windowOf(6);

    it("is continuous when every period is covered", () => {
      expect(evaluateContinuity(monthly([1, 2, 3, 4, 5, 6]), window)).toMatchObject({
        continuous: true,
        coveredPeriods: 6,
        missingPeriods: 0,
      });
    });

    it("tolerates exactly one missing middle period", () => {
      expect(evaluateContinuity(monthly([1, 2, 4, 5, 6]), window)).toMatchObject({
        continuous: true,
        missingPeriods: 1,
      });
    });

    it("rejects two missing periods, consecutive or not", () => {
      expect(evaluateContinuity(monthly([1, 4, 5, 6]), window).continuous).toBe(false);
      expect(evaluateContinuity(monthly([1, 3, 5, 6]), window).continuous).toBe(false);
    });

    it("requires the first and last periods to be covered", () => {
      expect(evaluateContinuity(monthly([2, 3, 4, 5, 6]), window).continuous).toBe(false);
      expect(evaluateContinuity(monthly([1, 2, 3, 4, 5]), window).continuous).toBe(false);
    });

    it("does not let many payments in one period cover another", () => {
      const burst = Array.from({ length: 20 }, (_, index) =>
        payment(`burst-${index}`, "2026-03-10T00:00:00.000Z"),
      );
      expect(
        evaluateContinuity([...monthly([1, 6]), ...burst], window),
      ).toMatchObject({ continuous: false, coveredPeriods: 3 });
    });

    it("counts a repeated operation id once, in one period only", () => {
      const duplicated = [
        ...monthly([1, 2, 3, 4, 6]),
        // Same operation replayed with a different timestamp: it must not
        // additionally cover May.
        payment("op-4", "2026-05-20T00:00:00.000Z"),
      ];
      const result = evaluateContinuity(duplicated, window);
      expect(result.includedPayments.filter((p) => p.operationId === "op-4")).toHaveLength(1);
      expect(result).toMatchObject({ coveredPeriods: 5, missingPeriods: 1 });
    });

    it("ignores payments outside the window", () => {
      const result = evaluateContinuity(
        [
          ...monthly([1, 2, 3, 4, 5, 6]),
          payment("before", "2025-12-31T23:59:59.999Z"),
          payment("after", "2026-07-01T00:00:00.000Z"),
        ],
        window,
      );
      expect(result.includedPayments.map((p) => p.operationId)).not.toContain("before");
      expect(result.includedPayments.map((p) => p.operationId)).not.toContain("after");
    });

    it("is independent of input order", () => {
      const rows = monthly([1, 2, 4, 5, 6]);
      const forward = evaluateContinuity(rows, window);
      const reversed = evaluateContinuity([...rows].reverse(), window);
      expect(reversed).toEqual(forward);
    });
  });
});
