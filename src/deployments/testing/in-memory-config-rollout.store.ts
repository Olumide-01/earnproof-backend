import {
  ConfigRolloutStore,
  OpenRolloutExistsError,
  RolloutEvent,
  StoredRollout,
  StoredSnapshot,
} from "../config-rollout.store";

/**
 * In-memory {@link ConfigRolloutStore} with the same uniqueness and
 * optimistic-concurrency semantics as the Prisma store, for unit tests.
 */
export class InMemoryConfigRolloutStore extends ConfigRolloutStore {
  readonly snapshots = new Map<string, StoredSnapshot>();
  readonly rollouts = new Map<string, StoredRollout>();
  readonly events: RolloutEvent[] = [];
  private sequence = 0;

  constructor(private readonly now: () => number = () => Date.now()) {
    super();
  }

  async saveSnapshot(
    snapshot: Omit<StoredSnapshot, "id" | "createdAtMs">,
  ): Promise<{ snapshot: StoredSnapshot; created: boolean }> {
    const existing = [...this.snapshots.values()].find(
      (row) =>
        row.environment === snapshot.environment &&
        row.document.contentHash === snapshot.document.contentHash,
    );
    if (existing) return { snapshot: structuredClone(existing), created: false };
    this.sequence += 1;
    const row: StoredSnapshot = { ...structuredClone(snapshot), id: `snap_${this.sequence}`, createdAtMs: this.now() };
    this.snapshots.set(row.id, row);
    return { snapshot: structuredClone(row), created: true };
  }

  async getSnapshot(id: string): Promise<StoredSnapshot | null> {
    const row = this.snapshots.get(id);
    return row ? structuredClone(row) : null;
  }

  async createRollout(rollout: StoredRollout, event: RolloutEvent): Promise<StoredRollout> {
    const open = [...this.rollouts.values()].some(
      (row) => row.environment === rollout.environment && (row.status === "CANARY" || row.status === "BLOCKED"),
    );
    if (open) throw new OpenRolloutExistsError();
    this.rollouts.set(rollout.id, structuredClone(rollout));
    this.events.push(structuredClone(event));
    return structuredClone(rollout);
  }

  async getRollout(id: string): Promise<StoredRollout | null> {
    const row = this.rollouts.get(id);
    return row ? structuredClone(row) : null;
  }

  async listEvents(rolloutId: string): Promise<RolloutEvent[]> {
    return this.events.filter((event) => event.rolloutId === rolloutId).map((event) => structuredClone(event));
  }

  async transition(next: StoredRollout, expectedVersion: number, event: RolloutEvent): Promise<boolean> {
    // Yield first, so concurrent callers interleave the way they would against
    // a database and the version check is what decides the winner.
    await Promise.resolve();
    const current = this.rollouts.get(next.id);
    if (!current || current.version !== expectedVersion) return false;
    this.rollouts.set(next.id, structuredClone(next));
    this.events.push(structuredClone(event));
    return true;
  }

  async activeSnapshotId(environment: string): Promise<string | null> {
    const completed = [...this.rollouts.values()]
      .filter((row) => row.environment === environment && row.status === "COMPLETED")
      .sort((a, b) => (b.completedAtMs ?? 0) - (a.completedAtMs ?? 0));
    return completed[0]?.snapshotId ?? null;
  }
}
