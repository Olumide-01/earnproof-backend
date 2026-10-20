import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { AuthenticatedUser } from "../auth/auth.types";
import { Clock, SystemClock } from "../common/time/clock";
import {
  buildSnapshot,
  ConfigDiff,
  ConfigSnapshotDocument,
  diffSnapshots,
  resolveSigningKey,
  SnapshotSigningKey,
  verifySnapshot,
} from "../config/config-snapshot";
import { configuration } from "../config/configuration";
import {
  applyGate,
  applyPromotion,
  applyRollback,
  assertValidStages,
  evaluateGate,
  GateCheck,
  GatePolicy,
  isInCohort,
  RollbackReasonValue,
  RolloutPolicyError,
  RolloutRefusal,
  RolloutStatus,
} from "./config-rollout";
import {
  ConfigRolloutStore,
  OpenRolloutExistsError,
  RolloutEvent,
  RolloutEventType,
  StoredRollout,
  StoredSnapshot,
} from "./config-rollout.store";

/** Supplies the raw configuration to snapshot. Injectable for tests. */
export const CONFIG_SOURCE = Symbol("CONFIG_SOURCE");
export type ConfigSource = () => Record<string, unknown>;

export interface SnapshotView {
  id: string;
  environment: string;
  origin: StoredSnapshot["origin"];
  created: boolean;
  document: ConfigSnapshotDocument;
}

export interface RolloutView {
  id: string;
  environment: string;
  snapshotId: string;
  baselineSnapshotId: string | null;
  status: StoredRollout["status"];
  stages: number[];
  stageIndex: number;
  currentPercent: number;
  stageStartedAt: string;
  version: number;
  lastGate: { passed: boolean; evaluatedAt: string; eventId: string } | null;
  completedAt: string | null;
  rolledBackAt: string | null;
  events: Array<Omit<RolloutEvent, "createdAtMs" | "rolloutId"> & { createdAt: string }>;
}

const REFUSAL_MESSAGES: Record<RolloutRefusal, string> = {
  stale_version: "Rollout changed since it was read; reload and retry",
  stale_stage: "Gate evidence is for a stage that is no longer current",
  not_in_canary: "Rollout is not in a canary stage",
  not_open: "Only an open rollout can be rolled back",
  gate_required: "A passing health gate for the current stage is required before promotion",
  gate_expired: "The passing health gate is too old; submit fresh evidence",
};

/**
 * Configuration rollout snapshots and canaries (earnproof-backend#329).
 *
 * This service is the system of record for *which* configuration an
 * environment is moving to and whether each stage was healthy. It does not
 * apply configuration itself: instances read their own environment, and use
 * the cohort endpoint to learn whether they are in the current canary.
 */
@Injectable()
export class ConfigRolloutService {
  private readonly environment: string;
  private readonly signingKey: SnapshotSigningKey | null;
  private readonly gatePolicy: GatePolicy;
  private readonly gateValidityMs: number;
  private readonly defaultStages: number[];

  constructor(
    private readonly store: ConfigRolloutStore,
    config: ConfigService,
    @Optional() private readonly clock: Clock = new SystemClock(),
    @Optional() @Inject(CONFIG_SOURCE) private readonly source: ConfigSource = configuration as ConfigSource,
  ) {
    this.environment = config.get<string>("configRollout.environment") ?? "development";
    this.signingKey = resolveSigningKey({
      dedicatedSecret: config.get<string>("configRollout.signingSecret"),
      credentialSigningSecret: config.get<string>("credentialSigningSecret"),
    });
    this.gatePolicy = {
      requiredChecks: config.get<string[]>("configRollout.requiredGateChecks") ?? [
        "readiness",
        "error_rate",
        "latency",
      ],
      maxEvidenceAgeMs: config.get<number>("configRollout.maxGateEvidenceAgeMs") ?? 900_000,
    };
    this.gateValidityMs = config.get<number>("configRollout.gateValidityMs") ?? 3_600_000;
    this.defaultStages = config.get<number[]>("configRollout.defaultStages") ?? [5, 25, 100];
    assertValidStages(this.defaultStages);
  }

  /** Captures this process's effective configuration as an immutable snapshot. */
  async captureSnapshot(actor: AuthenticatedUser): Promise<SnapshotView> {
    const key = this.requireKey();
    const document = buildSnapshot(this.source(), this.environment, this.clock.now(), key);
    const { snapshot, created } = await this.store.saveSnapshot({
      environment: this.environment,
      origin: "CAPTURED",
      document,
      createdById: actor.id,
    });
    return toSnapshotView(snapshot, created);
  }

  /**
   * Imports a snapshot captured in another environment, for comparison.
   * Accepted only if it verifies under this deployment's signing key, so a
   * hand-edited or foreign-signed document is refused.
   */
  async importSnapshot(actor: AuthenticatedUser, document: ConfigSnapshotDocument): Promise<SnapshotView> {
    const key = this.requireKey();
    if (!isSnapshotShape(document)) {
      throw new BadRequestException("Snapshot rejected: malformed_document");
    }
    const verification = verifySnapshot(document, key);
    if (!verification.valid) {
      throw new BadRequestException(`Snapshot rejected: ${verification.reason}`);
    }
    const { snapshot, created } = await this.store.saveSnapshot({
      environment: document.environment,
      origin: "IMPORTED",
      document,
      createdById: actor.id,
    });
    return toSnapshotView(snapshot, created);
  }

  async getSnapshot(id: string): Promise<SnapshotView & { verified: boolean }> {
    const snapshot = await this.requireSnapshot(id);
    const verified = this.signingKey ? verifySnapshot(snapshot.document, this.signingKey).valid : false;
    return { ...toSnapshotView(snapshot, false), verified };
  }

  /** Semantic diff of two snapshots, typically of two environments. */
  async compare(baseId: string, targetId: string): Promise<{
    base: { id: string; environment: string; contentHash: string };
    target: { id: string; environment: string; contentHash: string };
    diff: ConfigDiff;
  }> {
    const [base, target] = await Promise.all([this.requireSnapshot(baseId), this.requireSnapshot(targetId)]);
    return {
      base: { id: base.id, environment: base.environment, contentHash: base.document.contentHash },
      target: { id: target.id, environment: target.environment, contentHash: target.document.contentHash },
      diff: diffSnapshots(base.document, target.document),
    };
  }

  /** Starts a canary rollout of a snapshot into an environment. */
  async createRollout(
    actor: AuthenticatedUser,
    input: { snapshotId: string; environment: string; stages?: number[]; baselineSnapshotId?: string },
  ): Promise<RolloutView> {
    const stages = input.stages ?? this.defaultStages;
    try {
      assertValidStages(stages);
    } catch (error) {
      if (error instanceof RolloutPolicyError) throw new BadRequestException(error.message);
      throw error;
    }
    await this.requireSnapshot(input.snapshotId);
    const baselineSnapshotId =
      input.baselineSnapshotId ?? (await this.store.activeSnapshotId(input.environment));
    if (baselineSnapshotId) await this.requireSnapshot(baselineSnapshotId);
    if (baselineSnapshotId === input.snapshotId) {
      throw new BadRequestException("Snapshot is already the environment's active configuration");
    }

    const now = this.clock.nowMs();
    const rollout: StoredRollout = {
      id: randomUUID(),
      environment: input.environment,
      snapshotId: input.snapshotId,
      baselineSnapshotId,
      status: RolloutStatus.CANARY,
      stages: [...stages],
      stageIndex: 0,
      stageStartedAtMs: now,
      version: 0,
      lastGate: null,
      createdById: actor.id,
      createdAtMs: now,
      completedAtMs: null,
      rolledBackAtMs: null,
    };
    try {
      await this.store.createRollout(
        rollout,
        this.event(rollout, "CREATED", actor, { snapshotId: input.snapshotId, baselineSnapshotId }),
      );
    } catch (error) {
      if (error instanceof OpenRolloutExistsError) {
        throw new ConflictException("This environment already has an open rollout");
      }
      throw error;
    }
    return this.getRollout(rollout.id);
  }

  /** Evaluates and records health gate evidence for the current stage. */
  async recordGate(
    actor: AuthenticatedUser,
    rolloutId: string,
    input: { expectedVersion: number; stageIndex: number; checks: GateCheck[] },
  ): Promise<RolloutView> {
    const rollout = await this.requireRollout(rolloutId);
    const evaluation = evaluateGate(input.checks, this.gatePolicy, rollout.stageStartedAtMs, this.clock.nowMs());
    const eventId = randomUUID();
    const result = applyGate(rollout, { ...input, evaluation, eventId });
    if (!result.ok) this.refuse(result.refusal);

    const next = { ...rollout, ...result.next };
    await this.commit(
      next,
      rollout.version,
      {
        ...this.event(rollout, evaluation.passed ? "GATE_PASSED" : "GATE_FAILED", actor, {
          checks: input.checks.map((check) => ({
            name: check.name,
            passed: check.passed,
            observedAt: new Date(check.observedAtMs).toISOString(),
          })),
          failures: evaluation.failures,
        }),
        id: eventId,
      },
    );
    return this.getRollout(rolloutId);
  }

  /** Promotes the current stage; promoting the final stage completes the rollout. */
  async promote(actor: AuthenticatedUser, rolloutId: string, expectedVersion: number): Promise<RolloutView> {
    const rollout = await this.requireRollout(rolloutId);
    const now = this.clock.nowMs();
    const result = applyPromotion(rollout, { expectedVersion, nowMs: now, gateValidityMs: this.gateValidityMs });
    if (!result.ok) this.refuse(result.refusal);

    const completed = result.next.status === RolloutStatus.COMPLETED;
    const next: StoredRollout = { ...rollout, ...result.next, completedAtMs: completed ? now : null };
    await this.commit(
      next,
      rollout.version,
      this.event(next, completed ? "COMPLETED" : "PROMOTED", actor, {
        fromStageIndex: rollout.stageIndex,
        gateEventId: rollout.lastGate?.eventId ?? null,
      }),
    );
    return this.getRollout(rolloutId);
  }

  /**
   * Rolls back an open rollout and records the evidence: the snapshot being
   * restored, the stage reached, and the failing gate if there was one.
   */
  async rollback(
    actor: AuthenticatedUser,
    rolloutId: string,
    input: { expectedVersion: number; reason: RollbackReasonValue },
  ): Promise<RolloutView> {
    const rollout = await this.requireRollout(rolloutId);
    const result = applyRollback(rollout, input);
    if (!result.ok) this.refuse(result.refusal);

    const now = this.clock.nowMs();
    const next: StoredRollout = { ...rollout, ...result.next, rolledBackAtMs: now };
    const failedGate = rollout.lastGate && !rollout.lastGate.passed ? rollout.lastGate.eventId : null;
    await this.commit(
      next,
      rollout.version,
      this.event(rollout, "ROLLED_BACK", actor, {
        reason: input.reason,
        restoredSnapshotId: rollout.baselineSnapshotId,
        abandonedSnapshotId: rollout.snapshotId,
        statusAtRollback: rollout.status,
        failedGateEventId: failedGate,
      }),
    );
    return this.getRollout(rolloutId);
  }

  async getRollout(rolloutId: string): Promise<RolloutView> {
    const rollout = await this.requireRollout(rolloutId);
    const events = await this.store.listEvents(rolloutId);
    return {
      id: rollout.id,
      environment: rollout.environment,
      snapshotId: rollout.snapshotId,
      baselineSnapshotId: rollout.baselineSnapshotId,
      status: rollout.status,
      stages: rollout.stages,
      stageIndex: rollout.stageIndex,
      currentPercent: rollout.stages[rollout.stageIndex],
      stageStartedAt: iso(rollout.stageStartedAtMs),
      version: rollout.version,
      lastGate: rollout.lastGate
        ? { passed: rollout.lastGate.passed, evaluatedAt: iso(rollout.lastGate.evaluatedAtMs), eventId: rollout.lastGate.eventId }
        : null,
      completedAt: rollout.completedAtMs === null ? null : iso(rollout.completedAtMs),
      rolledBackAt: rollout.rolledBackAtMs === null ? null : iso(rollout.rolledBackAtMs),
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        stageIndex: event.stageIndex,
        percent: event.percent,
        actorId: event.actorId,
        evidence: event.evidence,
        createdAt: iso(event.createdAtMs),
      })),
    };
  }

  /**
   * Which snapshot an instance should run under this rollout. Canary members
   * get the new snapshot; everyone else keeps the baseline. After completion
   * everyone gets the new snapshot; after rollback everyone gets the baseline.
   */
  async cohort(rolloutId: string, instanceId: string): Promise<{
    inCohort: boolean;
    percent: number;
    snapshotId: string | null;
  }> {
    const rollout = await this.requireRollout(rolloutId);
    const percent = rollout.stages[rollout.stageIndex];
    if (rollout.status === RolloutStatus.COMPLETED) {
      return { inCohort: true, percent: 100, snapshotId: rollout.snapshotId };
    }
    if (rollout.status === RolloutStatus.ROLLED_BACK) {
      return { inCohort: false, percent: 0, snapshotId: rollout.baselineSnapshotId };
    }
    // A blocked rollout stops growing but its existing canaries are not
    // silently reverted: rollback is an explicit, recorded decision.
    const inCohort = isInCohort(rollout.id, instanceId, percent);
    return { inCohort, percent, snapshotId: inCohort ? rollout.snapshotId : rollout.baselineSnapshotId };
  }

  private async commit(next: StoredRollout, expectedVersion: number, event: RolloutEvent): Promise<void> {
    const applied = await this.store.transition(next, expectedVersion, event);
    if (!applied) this.refuse("stale_version");
  }

  private event(
    rollout: StoredRollout,
    type: RolloutEventType,
    actor: AuthenticatedUser,
    evidence: Record<string, unknown>,
  ): RolloutEvent {
    return {
      id: randomUUID(),
      rolloutId: rollout.id,
      type,
      stageIndex: rollout.stageIndex,
      percent: rollout.stages[rollout.stageIndex],
      actorId: actor.id,
      evidence,
      createdAtMs: this.clock.nowMs(),
    };
  }

  private refuse(refusal: RolloutRefusal): never {
    throw new ConflictException({ message: REFUSAL_MESSAGES[refusal], code: refusal });
  }

  private requireKey(): SnapshotSigningKey {
    if (!this.signingKey) {
      throw new ServiceUnavailableException("Snapshot signing key is not configured");
    }
    return this.signingKey;
  }

  private async requireSnapshot(id: string): Promise<StoredSnapshot> {
    const snapshot = await this.store.getSnapshot(id);
    if (!snapshot) throw new NotFoundException("Snapshot not found");
    return snapshot;
  }

  private async requireRollout(id: string): Promise<StoredRollout> {
    const rollout = await this.store.getRollout(id);
    if (!rollout) throw new NotFoundException("Rollout not found");
    return rollout;
  }
}

function toSnapshotView(snapshot: StoredSnapshot, created: boolean): SnapshotView {
  return {
    id: snapshot.id,
    environment: snapshot.environment,
    origin: snapshot.origin,
    created,
    document: snapshot.document,
  };
}

/** Structural check before cryptographic verification of an untrusted document. */
function isSnapshotShape(value: unknown): value is ConfigSnapshotDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as Record<string, unknown>;
  const signature = doc.signature as Record<string, unknown> | undefined;
  return (
    typeof doc.schema === "string" &&
    typeof doc.environment === "string" &&
    /^[a-z][a-z0-9-]{0,31}$/.test(doc.environment) &&
    typeof doc.capturedAt === "string" &&
    Number.isFinite(Date.parse(doc.capturedAt)) &&
    typeof doc.contentHash === "string" &&
    !!doc.entries &&
    typeof doc.entries === "object" &&
    !Array.isArray(doc.entries) &&
    Array.isArray(doc.excluded) &&
    !!signature &&
    typeof signature.alg === "string" &&
    typeof signature.keyId === "string" &&
    typeof signature.value === "string"
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
