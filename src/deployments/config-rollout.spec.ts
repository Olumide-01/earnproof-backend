import {
  applyGate,
  applyPromotion,
  applyRollback,
  assertValidStages,
  cohortPosition,
  evaluateGate,
  GateCheck,
  isInCohort,
  RolloutPolicyError,
  RolloutState,
} from "./config-rollout";

const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const MIN = 60_000;
const gatePolicy = { requiredChecks: ["error_rate", "readiness"], maxEvidenceAgeMs: 15 * MIN };

function state(overrides: Partial<RolloutState> = {}): RolloutState {
  return {
    id: "rollout-1",
    status: "CANARY",
    stages: [5, 25, 100],
    stageIndex: 0,
    stageStartedAtMs: T0,
    version: 3,
    lastGate: null,
    ...overrides,
  };
}

function checks(observedAtMs: number, overrides: Partial<GateCheck> = {}): GateCheck[] {
  return [
    { name: "readiness", passed: true, observedAtMs, ...overrides },
    { name: "error_rate", passed: true, observedAtMs },
  ];
}

describe("assertValidStages", () => {
  it.each([[[100]], [[5, 25, 100]], [[1, 2, 3, 4, 5, 6, 7, 8, 9, 100]]])("accepts %j", (stages) => {
    expect(() => assertValidStages(stages)).not.toThrow();
  });

  it.each([
    ["empty", []],
    ["not ending at 100", [5, 50]],
    ["non-increasing", [5, 5, 100]],
    ["decreasing", [50, 25, 100]],
    ["zero", [0, 100]],
    ["fractional", [2.5, 100]],
    ["over 100", [50, 101]],
    ["too many", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]],
  ])("rejects %s", (_label, stages) => {
    expect(() => assertValidStages(stages)).toThrow(RolloutPolicyError);
  });
});

describe("cohort assignment", () => {
  const instances = Array.from({ length: 2_000 }, (_, i) => `api-${i}`);

  it("is deterministic", () => {
    expect(cohortPosition("r1", "api-7")).toBe(cohortPosition("r1", "api-7"));
  });

  it("is monotonic: promotion only ever adds instances", () => {
    for (const instance of instances) {
      if (isInCohort("r1", instance, 5)) expect(isInCohort("r1", instance, 25)).toBe(true);
      expect(isInCohort("r1", instance, 100)).toBe(true);
    }
  });

  it("selects roughly the requested share", () => {
    const share = instances.filter((instance) => isInCohort("r1", instance, 25)).length / instances.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
  });

  it("varies the canaries between rollouts", () => {
    const a = instances.filter((instance) => isInCohort("r1", instance, 5));
    const b = instances.filter((instance) => isInCohort("r2", instance, 5));
    expect(a).not.toEqual(b);
  });

  it("cannot be steered by delimiter injection", () => {
    expect(cohortPosition("r1", "x")).not.toBe(cohortPosition("r1x", ""));
  });
});

describe("evaluateGate", () => {
  const now = T0 + 20 * MIN;

  it("passes fresh, passing, complete evidence", () => {
    expect(evaluateGate(checks(now - MIN), gatePolicy, T0, now)).toEqual({ passed: true, failures: [], evaluatedAtMs: now });
  });

  it("accepts evidence at the stage start, at now, and exactly max age old", () => {
    expect(evaluateGate(checks(T0 + 5 * MIN), gatePolicy, T0 + 5 * MIN, now).passed).toBe(true);
    expect(evaluateGate(checks(now), gatePolicy, T0, now).passed).toBe(true);
    expect(evaluateGate(checks(now - 15 * MIN), gatePolicy, T0, now).passed).toBe(true);
  });

  it("refuses evidence one millisecond past max age", () => {
    expect(evaluateGate(checks(now - 15 * MIN - 1), gatePolicy, T0, now).failures).toEqual([
      { check: "error_rate", reason: "stale" },
      { check: "readiness", reason: "stale" },
    ]);
  });

  it("refuses evidence gathered before the stage began (replay)", () => {
    expect(evaluateGate(checks(T0 - 1), gatePolicy, T0, now).failures.map((f) => f.reason)).toEqual([
      "predates_stage",
      "predates_stage",
    ]);
  });

  it("refuses evidence from the future", () => {
    expect(evaluateGate(checks(now + 1), gatePolicy, T0, now).failures[0].reason).toBe("from_future");
  });

  it("fails when a required check is missing", () => {
    const result = evaluateGate([{ name: "readiness", passed: true, observedAtMs: now }], gatePolicy, T0, now);
    expect(result).toMatchObject({ passed: false, failures: [{ check: "error_rate", reason: "missing" }] });
  });

  it("fails when any check fails, including optional extras", () => {
    const result = evaluateGate(
      [...checks(now), { name: "latency", passed: false, observedAtMs: now }],
      gatePolicy,
      T0,
      now,
    );
    expect(result.failures).toEqual([{ check: "latency", reason: "failed" }]);
  });

  it("refuses duplicate check names rather than picking one", () => {
    const result = evaluateGate([...checks(now), { name: "readiness", passed: false, observedAtMs: now }], gatePolicy, T0, now);
    expect(result.failures).toEqual([{ check: "readiness", reason: "duplicate" }]);
  });
});

describe("transitions", () => {
  const passing = { passed: true, failures: [], evaluatedAtMs: T0 + MIN };
  const failing = { passed: false, failures: [{ check: "readiness", reason: "failed" as const }], evaluatedAtMs: T0 + MIN };

  it("records a passing gate and bumps the version", () => {
    const result = applyGate(state(), { expectedVersion: 3, stageIndex: 0, evaluation: passing, eventId: "e1" });
    expect(result).toEqual({
      ok: true,
      next: expect.objectContaining({ status: "CANARY", version: 4, lastGate: { passed: true, evaluatedAtMs: T0 + MIN, eventId: "e1" } }),
    });
  });

  it("blocks the rollout on a failing gate", () => {
    const result = applyGate(state(), { expectedVersion: 3, stageIndex: 0, evaluation: failing, eventId: "e1" });
    expect(result.ok && result.next.status).toBe("BLOCKED");
  });

  it.each([
    ["a stale version", { expectedVersion: 2, stageIndex: 0 }, {}, "stale_version"],
    ["a stale stage", { expectedVersion: 3, stageIndex: 1 }, {}, "stale_stage"],
    ["a blocked rollout", { expectedVersion: 3, stageIndex: 0 }, { status: "BLOCKED" as const }, "not_in_canary"],
  ])("refuses gate evidence for %s", (_label, input, overrides, refusal) => {
    expect(applyGate(state(overrides), { ...input, evaluation: passing, eventId: "e1" })).toEqual({ ok: false, refusal });
  });

  it("promotes to the next stage and resets the gate", () => {
    const gated = state({ lastGate: { passed: true, evaluatedAtMs: T0 + MIN, eventId: "e1" } });
    const result = applyPromotion(gated, { expectedVersion: 3, nowMs: T0 + 2 * MIN, gateValidityMs: 60 * MIN });
    expect(result).toEqual({
      ok: true,
      next: expect.objectContaining({ stageIndex: 1, stageStartedAtMs: T0 + 2 * MIN, lastGate: null, version: 4, status: "CANARY" }),
    });
  });

  it("completes when the final stage is promoted", () => {
    const gated = state({ stageIndex: 2, lastGate: { passed: true, evaluatedAtMs: T0, eventId: "e1" } });
    const result = applyPromotion(gated, { expectedVersion: 3, nowMs: T0, gateValidityMs: MIN });
    expect(result.ok && result.next).toMatchObject({ status: "COMPLETED", stageIndex: 2 });
  });

  it("refuses promotion without a passing gate", () => {
    expect(applyPromotion(state(), { expectedVersion: 3, nowMs: T0, gateValidityMs: MIN })).toEqual({ ok: false, refusal: "gate_required" });
    const failed = state({ lastGate: { passed: false, evaluatedAtMs: T0, eventId: "e1" } });
    expect(applyPromotion(failed, { expectedVersion: 3, nowMs: T0, gateValidityMs: MIN })).toEqual({ ok: false, refusal: "gate_required" });
  });

  it("accepts a gate exactly at its validity limit and refuses it one millisecond later", () => {
    const gated = state({ lastGate: { passed: true, evaluatedAtMs: T0, eventId: "e1" } });
    expect(applyPromotion(gated, { expectedVersion: 3, nowMs: T0 + MIN, gateValidityMs: MIN }).ok).toBe(true);
    expect(applyPromotion(gated, { expectedVersion: 3, nowMs: T0 + MIN + 1, gateValidityMs: MIN })).toEqual({
      ok: false,
      refusal: "gate_expired",
    });
  });

  it("rolls back canary and blocked rollouts only", () => {
    expect(applyRollback(state(), { expectedVersion: 3 })).toMatchObject({ ok: true, next: { status: "ROLLED_BACK", version: 4 } });
    expect(applyRollback(state({ status: "BLOCKED" }), { expectedVersion: 3 }).ok).toBe(true);
    expect(applyRollback(state({ status: "COMPLETED" }), { expectedVersion: 3 })).toEqual({ ok: false, refusal: "not_open" });
    expect(applyRollback(state({ status: "ROLLED_BACK" }), { expectedVersion: 3 })).toEqual({ ok: false, refusal: "not_open" });
    expect(applyRollback(state(), { expectedVersion: 1 })).toEqual({ ok: false, refusal: "stale_version" });
  });
});
