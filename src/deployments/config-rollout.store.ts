import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { ConfigSnapshotDocument } from "../config/config-snapshot";
import { PrismaService } from "../database/prisma.service";
import type { RolloutState, RolloutStatusValue } from "./config-rollout";

export type SnapshotOrigin = "CAPTURED" | "IMPORTED";

export interface StoredSnapshot {
  id: string;
  environment: string;
  origin: SnapshotOrigin;
  document: ConfigSnapshotDocument;
  createdById: string | null;
  createdAtMs: number;
}

export interface StoredRollout extends RolloutState {
  environment: string;
  snapshotId: string;
  baselineSnapshotId: string | null;
  createdById: string;
  createdAtMs: number;
  completedAtMs: number | null;
  rolledBackAtMs: number | null;
}

export type RolloutEventType =
  | "CREATED"
  | "GATE_PASSED"
  | "GATE_FAILED"
  | "PROMOTED"
  | "COMPLETED"
  | "ROLLED_BACK";

export interface RolloutEvent {
  id: string;
  rolloutId: string;
  type: RolloutEventType;
  stageIndex: number;
  percent: number;
  actorId: string;
  /** Codes, ids, numbers and timestamps only. Never configuration values. */
  evidence: Record<string, unknown>;
  createdAtMs: number;
}

/** Raised when an environment already has an open rollout. */
export class OpenRolloutExistsError extends Error {
  constructor() {
    super("open_rollout_exists");
    this.name = "OpenRolloutExistsError";
  }
}

/**
 * Persistence port for snapshots and rollouts.
 *
 * Snapshots are append-only: there is no update or delete. A rollout changes
 * only through {@link transition}, which applies a new state and its event
 * together, and only if the stored version still equals `expectedVersion`.
 */
export abstract class ConfigRolloutStore {
  /** Stores a snapshot, or returns the existing one with the same environment and content. */
  abstract saveSnapshot(
    snapshot: Omit<StoredSnapshot, "id" | "createdAtMs">,
  ): Promise<{ snapshot: StoredSnapshot; created: boolean }>;
  abstract getSnapshot(id: string): Promise<StoredSnapshot | null>;
  /** Throws {@link OpenRolloutExistsError} when the environment already has an open rollout. */
  abstract createRollout(rollout: StoredRollout, event: RolloutEvent): Promise<StoredRollout>;
  abstract getRollout(id: string): Promise<StoredRollout | null>;
  abstract listEvents(rolloutId: string): Promise<RolloutEvent[]>;
  /** Applies `next` and appends `event` iff the stored version is `expectedVersion`. */
  abstract transition(next: StoredRollout, expectedVersion: number, event: RolloutEvent): Promise<boolean>;
  /** The snapshot of the environment's most recently completed rollout. */
  abstract activeSnapshotId(environment: string): Promise<string | null>;
}

const OPEN: RolloutStatusValue[] = ["CANARY", "BLOCKED"];

@Injectable()
export class PrismaConfigRolloutStore extends ConfigRolloutStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async saveSnapshot(
    snapshot: Omit<StoredSnapshot, "id" | "createdAtMs">,
  ): Promise<{ snapshot: StoredSnapshot; created: boolean }> {
    const { document } = snapshot;
    const existing = await this.prisma.configSnapshot.findUnique({
      where: {
        environment_contentHash: { environment: snapshot.environment, contentHash: document.contentHash },
      },
    });
    if (existing) return { snapshot: toSnapshot(existing), created: false };
    try {
      const row = await this.prisma.configSnapshot.create({
        data: {
          environment: snapshot.environment,
          origin: snapshot.origin,
          schemaVersion: document.schema,
          contentHash: document.contentHash,
          capturedAt: new Date(document.capturedAt),
          entries: document.entries as Prisma.InputJsonValue,
          excluded: document.excluded as unknown as Prisma.InputJsonValue,
          signatureAlg: document.signature.alg,
          signatureKeyId: document.signature.keyId,
          signature: document.signature.value,
          createdById: snapshot.createdById,
        },
      });
      return { snapshot: toSnapshot(row), created: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const row = await this.prisma.configSnapshot.findUniqueOrThrow({
          where: {
            environment_contentHash: { environment: snapshot.environment, contentHash: document.contentHash },
          },
        });
        return { snapshot: toSnapshot(row), created: false };
      }
      throw error;
    }
  }

  async getSnapshot(id: string): Promise<StoredSnapshot | null> {
    const row = await this.prisma.configSnapshot.findUnique({ where: { id } });
    return row ? toSnapshot(row) : null;
  }

  async createRollout(rollout: StoredRollout, event: RolloutEvent): Promise<StoredRollout> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.configRollout.create({ data: { id: rollout.id, ...rolloutData(rollout) } });
        await tx.configRolloutEvent.create({ data: eventData(event) });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new OpenRolloutExistsError();
      throw error;
    }
    return rollout;
  }

  async getRollout(id: string): Promise<StoredRollout | null> {
    const row = await this.prisma.configRollout.findUnique({ where: { id } });
    return row ? toRollout(row) : null;
  }

  async listEvents(rolloutId: string): Promise<RolloutEvent[]> {
    const rows = await this.prisma.configRolloutEvent.findMany({
      where: { rolloutId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      rolloutId: row.rolloutId,
      type: row.type as RolloutEventType,
      stageIndex: row.stageIndex,
      percent: row.percent,
      actorId: row.actorId,
      evidence: (row.evidence ?? {}) as Record<string, unknown>,
      createdAtMs: row.createdAt.getTime(),
    }));
  }

  async transition(next: StoredRollout, expectedVersion: number, event: RolloutEvent): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.configRollout.updateMany({
        where: { id: next.id, version: expectedVersion },
        data: rolloutData(next),
      });
      if (updated.count !== 1) return false;
      await tx.configRolloutEvent.create({ data: eventData(event) });
      return true;
    });
  }

  async activeSnapshotId(environment: string): Promise<string | null> {
    const row = await this.prisma.configRollout.findFirst({
      where: { environment, status: "COMPLETED" },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      select: { snapshotId: true },
    });
    return row?.snapshotId ?? null;
  }
}

function rolloutData(rollout: StoredRollout) {
  return {
    environment: rollout.environment,
    snapshotId: rollout.snapshotId,
    baselineSnapshotId: rollout.baselineSnapshotId,
    status: rollout.status,
    stages: rollout.stages,
    stageIndex: rollout.stageIndex,
    stageStartedAt: new Date(rollout.stageStartedAtMs),
    version: rollout.version,
    lastGateEventId: rollout.lastGate?.eventId ?? null,
    lastGatePassed: rollout.lastGate?.passed ?? null,
    lastGateEvaluatedAt: rollout.lastGate ? new Date(rollout.lastGate.evaluatedAtMs) : null,
    // The partial-unique "one open rollout per environment" key.
    openEnvironmentKey: OPEN.includes(rollout.status) ? rollout.environment : null,
    createdById: rollout.createdById,
    completedAt: rollout.completedAtMs === null ? null : new Date(rollout.completedAtMs),
    rolledBackAt: rollout.rolledBackAtMs === null ? null : new Date(rollout.rolledBackAtMs),
  };
}

function eventData(event: RolloutEvent) {
  return {
    id: event.id,
    rolloutId: event.rolloutId,
    type: event.type,
    stageIndex: event.stageIndex,
    percent: event.percent,
    actorId: event.actorId,
    evidence: event.evidence as Prisma.InputJsonValue,
    createdAt: new Date(event.createdAtMs),
  };
}

type SnapshotRow = Prisma.ConfigSnapshotGetPayload<object>;
type RolloutRow = Prisma.ConfigRolloutGetPayload<object>;

function toSnapshot(row: SnapshotRow): StoredSnapshot {
  return {
    id: row.id,
    environment: row.environment,
    origin: row.origin as SnapshotOrigin,
    createdById: row.createdById,
    createdAtMs: row.createdAt.getTime(),
    document: {
      schema: row.schemaVersion as ConfigSnapshotDocument["schema"],
      environment: row.environment,
      capturedAt: row.capturedAt.toISOString(),
      contentHash: row.contentHash,
      entries: row.entries as ConfigSnapshotDocument["entries"],
      excluded: row.excluded as unknown as ConfigSnapshotDocument["excluded"],
      signature: {
        alg: row.signatureAlg as "HMAC-SHA256",
        keyId: row.signatureKeyId,
        value: row.signature,
      },
    },
  };
}

function toRollout(row: RolloutRow): StoredRollout {
  return {
    id: row.id,
    environment: row.environment,
    snapshotId: row.snapshotId,
    baselineSnapshotId: row.baselineSnapshotId,
    status: row.status as RolloutStatusValue,
    stages: row.stages,
    stageIndex: row.stageIndex,
    stageStartedAtMs: row.stageStartedAt.getTime(),
    version: row.version,
    lastGate:
      row.lastGateEventId && row.lastGatePassed !== null && row.lastGateEvaluatedAt
        ? {
            eventId: row.lastGateEventId,
            passed: row.lastGatePassed,
            evaluatedAtMs: row.lastGateEvaluatedAt.getTime(),
          }
        : null,
    createdById: row.createdById,
    createdAtMs: row.createdAt.getTime(),
    completedAtMs: row.completedAt?.getTime() ?? null,
    rolledBackAtMs: row.rolledBackAt?.getTime() ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
