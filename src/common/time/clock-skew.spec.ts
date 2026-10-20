import {
  advanceAlert,
  assertValidClockSkewPolicy,
  breachSeverity,
  classifySkew,
  ClockSkewPolicy,
  ClockSkewPolicyError,
  ClockSkewStatus,
  estimateSkew,
  INITIAL_ALERT_STATE,
  SkewEstimate,
  statusForSkew,
  SustainedAlertState,
  TimeSample,
} from "./clock-skew";

const T0 = Date.parse("2030-01-01T00:00:00.000Z");

const policy: ClockSkewPolicy = {
  warnMs: 2_000,
  criticalMs: 10_000,
  maxRoundTripMs: 5_000,
  maxSampleAgeMs: 180_000,
  unknownPolicy: "fail_closed",
};

/** A sample whose source is exactly `offsetMs` behind local time. */
function sample(overrides: Partial<TimeSample> = {}): TimeSample {
  return {
    source: "horizon_http_date",
    referenceMs: T0,
    resolutionMs: 1_000,
    maxReferenceLagMs: 0,
    localSentMs: T0,
    localReceivedMs: T0 + 100,
    ...overrides,
  };
}

function estimate(overrides: Partial<SkewEstimate> = {}): SkewEstimate {
  return {
    source: "horizon_http_date",
    lowerMs: 0,
    upperMs: 0,
    skewMs: 0,
    roundTripMs: 100,
    observedAtMs: T0,
    ...overrides,
  };
}

describe("estimateSkew", () => {
  it("reports zero when the uncertainty interval contains agreement", () => {
    const result = estimateSkew(sample(), policy);
    expect(result).toMatchObject({ skewMs: 0, roundTripMs: 100 });
  });

  it("reports the provable lower bound when the local clock is ahead", () => {
    // Local reads 30s ahead of a reference with 1s resolution and no lag:
    // lower = sent - (ref + 1000) = 30_000 - 1_000.
    const result = estimateSkew(
      sample({ localSentMs: T0 + 30_000, localReceivedMs: T0 + 30_100 }),
      policy,
    ) as SkewEstimate;
    expect(result.skewMs).toBe(29_000);
    expect(result.lowerMs).toBe(29_000);
    expect(result.upperMs).toBe(30_100);
  });

  it("reports the provable upper bound when the local clock is behind", () => {
    const result = estimateSkew(
      sample({ localSentMs: T0 - 20_000, localReceivedMs: T0 - 19_900 }),
      policy,
    ) as SkewEstimate;
    expect(result.skewMs).toBe(-19_900);
  });

  it("never attributes a ledger's normal close lag to local skew", () => {
    // The newest ledger closed 9s ago; with a 10s allowance that is healthy.
    const result = estimateSkew(
      sample({
        source: "horizon_ledger_close",
        referenceMs: T0 - 9_000,
        maxReferenceLagMs: 10_000,
      }),
      policy,
    ) as SkewEstimate;
    expect(result.skewMs).toBe(0);
  });

  it("accepts a round trip exactly at the limit and rejects one past it", () => {
    expect(
      estimateSkew(sample({ localReceivedMs: T0 + 5_000 }), policy),
    ).toMatchObject({ roundTripMs: 5_000 });
    expect(estimateSkew(sample({ localReceivedMs: T0 + 5_001 }), policy)).toBe(
      "round_trip_exceeded",
    );
  });

  it("refuses a sample bracketed by a local clock that stepped backwards", () => {
    expect(estimateSkew(sample({ localReceivedMs: T0 - 1 }), policy)).toBe(
      "local_clock_regressed",
    );
  });

  it("discards a replayed reading whose ledger sequence regressed", () => {
    expect(estimateSkew(sample({ sequence: 99 }), policy, 100)).toBe("stale_reference");
    // Equal sequence is the same ledger read again: still usable.
    expect(estimateSkew(sample({ sequence: 100 }), policy, 100)).toMatchObject({
      skewMs: 0,
    });
  });

  it.each([
    ["NaN reference", { referenceMs: Number.NaN }],
    ["infinite send time", { localSentMs: Number.POSITIVE_INFINITY }],
    ["negative resolution", { resolutionMs: -1 }],
    ["negative lag", { maxReferenceLagMs: -1 }],
  ])("rejects an invalid reading: %s", (_label, overrides) => {
    expect(estimateSkew(sample(overrides), policy)).toBe("invalid_reading");
  });
});

describe("statusForSkew", () => {
  it.each([
    [0, ClockSkewStatus.OK],
    [1_999, ClockSkewStatus.OK],
    [2_000, ClockSkewStatus.WARNING],
    [-2_000, ClockSkewStatus.WARNING],
    [9_999, ClockSkewStatus.WARNING],
    [10_000, ClockSkewStatus.CRITICAL],
    [-10_000, ClockSkewStatus.CRITICAL],
  ])("classifies %ims as %s (thresholds are inclusive)", (skew, status) => {
    expect(statusForSkew(skew, policy)).toBe(status);
  });
});

describe("classifySkew", () => {
  it("is UNKNOWN with no samples", () => {
    expect(classifySkew([], policy, T0)).toMatchObject({
      status: ClockSkewStatus.UNKNOWN,
      reason: "no_samples",
    });
  });

  it("treats a sample exactly maxSampleAgeMs old as fresh and one older as stale", () => {
    const old = estimate({ skewMs: 3_000, observedAtMs: T0 });
    expect(classifySkew([old], policy, T0 + 180_000).status).toBe(ClockSkewStatus.WARNING);
    expect(classifySkew([old], policy, T0 + 180_001)).toMatchObject({
      status: ClockSkewStatus.UNKNOWN,
      reason: "no_fresh_samples",
    });
  });

  it("ignores a sample observed in the future relative to the evaluation", () => {
    expect(
      classifySkew([estimate({ observedAtMs: T0 + 1 })], policy, T0).status,
    ).toBe(ClockSkewStatus.UNKNOWN);
  });

  it("decides on the smallest-magnitude source so one broken source cannot alarm alone", () => {
    const result = classifySkew(
      [
        estimate({ source: "horizon_ledger_close", skewMs: 60_000 }),
        estimate({ source: "horizon_http_date", skewMs: -500 }),
      ],
      policy,
      T0,
    );
    expect(result).toMatchObject({
      status: ClockSkewStatus.OK,
      skewMs: -500,
      source: "horizon_http_date",
      samplesConsidered: 2,
    });
  });

  it("breaks ties deterministically by source name", () => {
    const a = estimate({ source: "b_source", skewMs: 3_000 });
    const b = estimate({ source: "a_source", skewMs: -3_000 });
    expect(classifySkew([a, b], policy, T0).source).toBe("a_source");
    expect(classifySkew([b, a], policy, T0).source).toBe("a_source");
  });
});

describe("breachSeverity", () => {
  it("applies the explicit unknown-time policy", () => {
    const unknown = { status: ClockSkewStatus.UNKNOWN };
    expect(breachSeverity(unknown, "fail_closed")).toBe("critical");
    expect(breachSeverity(unknown, "fail_open")).toBeNull();
  });

  it("maps classified statuses regardless of the unknown policy", () => {
    expect(breachSeverity({ status: ClockSkewStatus.OK }, "fail_closed")).toBeNull();
    expect(breachSeverity({ status: ClockSkewStatus.WARNING }, "fail_open")).toBe("warning");
    expect(breachSeverity({ status: ClockSkewStatus.CRITICAL }, "fail_open")).toBe("critical");
  });
});

describe("advanceAlert", () => {
  const alertPolicy = { sustainForMs: 300_000, clearAfterAssessments: 2 };

  function run(
    steps: Array<["warning" | "critical" | null, number]>,
  ): { state: SustainedAlertState; transitions: string[] } {
    let state = INITIAL_ALERT_STATE;
    const transitions: string[] = [];
    for (const [severity, at] of steps) {
      const next = advanceAlert(state, severity, at, alertPolicy);
      state = next.state;
      if (next.transition) transitions.push(next.transition.type);
    }
    return { state, transitions };
  }

  it("does not alert on a transient breach", () => {
    const { state, transitions } = run([
      ["critical", T0],
      [null, T0 + 60_000],
      ["critical", T0 + 120_000],
    ]);
    expect(transitions).toEqual([]);
    expect(state.activeSeverity).toBeNull();
  });

  it("raises exactly when the breach has lasted sustainForMs", () => {
    const before = run([
      ["warning", T0],
      ["warning", T0 + 299_999],
    ]);
    expect(before.transitions).toEqual([]);

    const at = run([
      ["warning", T0],
      ["warning", T0 + 300_000],
    ]);
    expect(at.transitions).toEqual(["raised"]);
    expect(at.state.activeSeverity).toBe("warning");
  });

  it("escalates and de-escalates without re-raising", () => {
    const { transitions, state } = run([
      ["warning", T0],
      ["warning", T0 + 300_000],
      ["critical", T0 + 360_000],
      ["warning", T0 + 420_000],
      ["warning", T0 + 480_000],
    ]);
    expect(transitions).toEqual(["raised", "escalated", "deescalated"]);
    expect(state.activeSeverity).toBe("warning");
  });

  it("clears only after the configured healthy streak", () => {
    const { transitions, state } = run([
      ["critical", T0],
      ["critical", T0 + 300_000],
      [null, T0 + 360_000],
      [null, T0 + 420_000],
    ]);
    expect(transitions).toEqual(["raised", "cleared"]);
    expect(state).toEqual(INITIAL_ALERT_STATE);
  });

  it("resets the healthy streak when the breach returns before clearing", () => {
    const { transitions, state } = run([
      ["critical", T0],
      ["critical", T0 + 300_000],
      [null, T0 + 360_000],
      ["critical", T0 + 420_000],
      [null, T0 + 480_000],
    ]);
    expect(transitions).toEqual(["raised"]);
    expect(state.activeSeverity).toBe("critical");
    expect(state.healthyStreak).toBe(1);
  });

  it("is deterministic: replaying the same sequence yields the same alerts", () => {
    const steps: Array<["warning" | "critical" | null, number]> = [
      ["warning", T0],
      ["critical", T0 + 300_000],
      [null, T0 + 360_000],
      [null, T0 + 420_000],
    ];
    expect(run(steps)).toEqual(run(steps));
  });

  it("raises immediately when sustainForMs is zero", () => {
    const next = advanceAlert(INITIAL_ALERT_STATE, "critical", T0, {
      sustainForMs: 0,
      clearAfterAssessments: 1,
    });
    expect(next.transition).toEqual({ type: "raised", severity: "critical" });
  });
});

describe("assertValidClockSkewPolicy", () => {
  it("accepts the documented defaults", () => {
    expect(() => assertValidClockSkewPolicy(policy)).not.toThrow();
  });

  it.each([
    ["critical equal to warn", { criticalMs: 2_000 }],
    ["non-positive warn", { warnMs: 0 }],
    ["non-finite age", { maxSampleAgeMs: Number.POSITIVE_INFINITY }],
    ["unrecognised unknown policy", { unknownPolicy: "ignore" as never }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => assertValidClockSkewPolicy({ ...policy, ...overrides })).toThrow(
      ClockSkewPolicyError,
    );
  });
});
