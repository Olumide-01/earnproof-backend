import { createHash } from "crypto";

/**
 * Staged configuration rollouts with health gates (earnproof-backend#329).
 *
 * A rollout moves one configuration snapshot into one environment through
 * canary stages (for example 5% → 25% → 100% of instances). Each stage must
 * pass a health gate, with fresh evidence gathered *during that stage*, before
 * it can be promoted. A failed gate blocks the rollout; the only way forward
 * from a blocked rollout is a rollback, which records the evidence behind it.
 *
 * The functions here are pure. Every transition takes the version the caller
 * last saw; persistence applies it only if that version is still current, so
 * a stale or replayed decision is refused rather than applied twice.
 */

export const RolloutStatus = {
  CANARY: "CANARY",
  BLOCKED: "BLOCKED",
  COMPLETED: "COMPLETED",
  ROLLED_BACK: "ROLLED_BACK",
} as const;
export type RolloutStatusValue = (typeof RolloutStatus)[keyof typeof RolloutStatus];

export const OPEN_ROLLOUT_STATUSES: readonly RolloutStatusValue[] = [
  RolloutStatus.CANARY,
  RolloutStatus.BLOCKED,
];

export const RollbackReason = {
  HEALTH_GATE_FAILED: "health_gate_failed",
  OPERATOR_REQUEST: "operator_request",
  INCIDENT: "incident",
} as const;
export type RollbackReasonValue = (typeof RollbackReason)[keyof typeof RollbackReason];

/** Stable refusal codes. The service maps them onto HTTP errors. */
export type RolloutRefusal =
  | "stale_version"
  | "stale_stage"
  | "not_in_canary"
  | "not_open"
  | "gate_required"
  | "gate_expired";

export class RolloutPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RolloutPolicyError";
  }
}

/** Stages are strictly increasing whole percentages from at least 1, ending at 100. */
export function assertValidStages(stages: readonly number[]): void {
  if (stages.length === 0 || stages.length > 10) {
    throw new RolloutPolicyError("A rollout needs between 1 and 10 stages");
  }
  stages.forEach((stage, index) => {
    if (!Number.isInteger(stage) || stage < 1 || stage > 100) {
      throw new RolloutPolicyError("Stages must be whole percentages between 1 and 100");
    }
    if (index > 0 && stage <= stages[index - 1]) {
      throw new RolloutPolicyError("Stages must strictly increase");
    }
  });
  if (stages[stages.length - 1] !== 100) {
    throw new RolloutPolicyError("The final stage must be 100");
  }
}

/**
 * Whether an instance belongs to a stage's canary cohort.
 *
 * Deterministic and monotonic: each instance hashes to a fixed position in
 * [0, 10000) for this rollout, and is in the cohort while that position is
 * below `percent × 100`. An instance in the 5% cohort is therefore also in the
 * 25% cohort, so promotion only ever adds instances. Different rollouts hash
 * differently, so the same instances are not always the canaries.
 */
export function cohortPosition(rolloutId: string, instanceId: string): number {
  const digest = createHash("sha256").update(`${rolloutId}\u0000${instanceId}`).digest();
  return digest.readUInt32BE(0) % 10_000;
}

export function isInCohort(rolloutId: string, instanceId: string, percent: number): boolean {
  return cohortPosition(rolloutId, instanceId) < percent * 100;
}

/** One health signal submitted as gate evidence. */
export interface GateCheck {
  name: string;
  passed: boolean;
  observedAtMs: number;
}

export interface GatePolicy {
  /** Every one of these checks must be present and passing. */
  requiredChecks: readonly string[];
  /** Evidence older than this at evaluation time is refused (inclusive bound). */
  maxEvidenceAgeMs: number;
}

export type GateFailure =
  | { check: string; reason: "missing" | "failed" | "stale" | "predates_stage" | "from_future" }
  | { check: string; reason: "duplicate" };

export interface GateEvaluation {
  passed: boolean;
  failures: GateFailure[];
  evaluatedAtMs: number;
}

/**
 * Evaluates gate evidence for the current stage.
 *
 * Evidence must be observed after the stage began (so evidence from an
 * earlier stage — or an earlier rollout — cannot be replayed), no later than
 * now, and no older than `maxEvidenceAgeMs`. Exact boundaries: observed at the
 * stage start, at now, or exactly `maxEvidenceAgeMs` ago are all accepted.
 */
export function evaluateGate(
  checks: readonly GateCheck[],
  policy: GatePolicy,
  stageStartedAtMs: number,
  nowMs: number,
): GateEvaluation {
  const failures: GateFailure[] = [];
  const byName = new Map<string, GateCheck>();

  for (const check of checks) {
    if (byName.has(check.name)) {
      failures.push({ check: check.name, reason: "duplicate" });
      continue;
    }
    byName.set(check.name, check);
  }

  for (const required of policy.requiredChecks) {
    if (!byName.has(required)) failures.push({ check: required, reason: "missing" });
  }

  for (const check of byName.values()) {
    if (check.observedAtMs > nowMs) failures.push({ check: check.name, reason: "from_future" });
    else if (check.observedAtMs < stageStartedAtMs) failures.push({ check: check.name, reason: "predates_stage" });
    else if (nowMs - check.observedAtMs > policy.maxEvidenceAgeMs) failures.push({ check: check.name, reason: "stale" });
    else if (!check.passed) failures.push({ check: check.name, reason: "failed" });
  }

  failures.sort((a, b) => (a.check < b.check ? -1 : a.check > b.check ? 1 : a.reason < b.reason ? -1 : 1));
  return { passed: failures.length === 0, failures, evaluatedAtMs: nowMs };
}

/** The rollout fields transitions read and write. */
export interface RolloutState {
  id: string;
  status: RolloutStatusValue;
  stages: number[];
  stageIndex: number;
  stageStartedAtMs: number;
  version: number;
  lastGate: { passed: boolean; evaluatedAtMs: number; eventId: string } | null;
}

export type Transition<T> = { ok: true; next: T } | { ok: false; refusal: RolloutRefusal };

function guard(state: RolloutState, expectedVersion: number): RolloutRefusal | null {
  if (state.version !== expectedVersion) return "stale_version";
  return null;
}

/** Records a gate evaluation for the current stage. A failure blocks the rollout. */
export function applyGate(
  state: RolloutState,
  input: { expectedVersion: number; stageIndex: number; evaluation: GateEvaluation; eventId: string },
): Transition<RolloutState> {
  const stale = guard(state, input.expectedVersion);
  if (stale) return { ok: false, refusal: stale };
  if (state.status !== RolloutStatus.CANARY) return { ok: false, refusal: "not_in_canary" };
  if (input.stageIndex !== state.stageIndex) return { ok: false, refusal: "stale_stage" };

  return {
    ok: true,
    next: {
      ...state,
      status: input.evaluation.passed ? RolloutStatus.CANARY : RolloutStatus.BLOCKED,
      version: state.version + 1,
      lastGate: {
        passed: input.evaluation.passed,
        evaluatedAtMs: input.evaluation.evaluatedAtMs,
        eventId: input.eventId,
      },
    },
  };
}

/**
 * Promotes the current stage. Requires a passing gate for this stage that is
 * no older than `gateValidityMs` (inclusive). Promoting the final stage
 * completes the rollout.
 */
export function applyPromotion(
  state: RolloutState,
  input: { expectedVersion: number; nowMs: number; gateValidityMs: number },
): Transition<RolloutState> {
  const stale = guard(state, input.expectedVersion);
  if (stale) return { ok: false, refusal: stale };
  if (state.status !== RolloutStatus.CANARY) return { ok: false, refusal: "not_in_canary" };
  if (!state.lastGate || !state.lastGate.passed) return { ok: false, refusal: "gate_required" };
  if (input.nowMs - state.lastGate.evaluatedAtMs > input.gateValidityMs) {
    return { ok: false, refusal: "gate_expired" };
  }

  const finalStage = state.stageIndex === state.stages.length - 1;
  return {
    ok: true,
    next: {
      ...state,
      status: finalStage ? RolloutStatus.COMPLETED : RolloutStatus.CANARY,
      stageIndex: finalStage ? state.stageIndex : state.stageIndex + 1,
      stageStartedAtMs: finalStage ? state.stageStartedAtMs : input.nowMs,
      version: state.version + 1,
      lastGate: finalStage ? state.lastGate : null,
    },
  };
}

/** Rolls back an open (canary or blocked) rollout. Completed rollouts are final. */
export function applyRollback(
  state: RolloutState,
  input: { expectedVersion: number },
): Transition<RolloutState> {
  const stale = guard(state, input.expectedVersion);
  if (stale) return { ok: false, refusal: stale };
  if (!OPEN_ROLLOUT_STATUSES.includes(state.status)) return { ok: false, refusal: "not_open" };
  return { ok: true, next: { ...state, status: RolloutStatus.ROLLED_BACK, version: state.version + 1 } };
}
