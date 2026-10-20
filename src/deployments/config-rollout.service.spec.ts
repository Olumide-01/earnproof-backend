import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FixedClock } from "../../test/time/fixed-clock";
import { buildSnapshot, resolveSigningKey } from "../config/config-snapshot";
import { ConfigRolloutService } from "./config-rollout.service";
import { InMemoryConfigRolloutStore } from "./testing/in-memory-config-rollout.store";

const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const MIN = 60_000;
const admin = { id: "admin-1", role: "ADMIN", walletAddress: "GADMIN", walletHash: "h" } as never;
const SIGNING = "s".repeat(32);

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    "configRollout.environment": "staging",
    "configRollout.signingSecret": SIGNING,
    "configRollout.requiredGateChecks": ["readiness", "error_rate"],
    "configRollout.maxGateEvidenceAgeMs": 15 * MIN,
    "configRollout.gateValidityMs": 60 * MIN,
    "configRollout.defaultStages": [5, 25, 100],
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function setup(overrides: Record<string, unknown> = {}) {
  const clock = new FixedClock(T0);
  const store = new InMemoryConfigRolloutStore(() => clock.nowMs());
  let current: Record<string, unknown> = { health: { probeTimeoutMs: 2000 }, sessionSecret: "never-stored" };
  const service = new ConfigRolloutService(store, config(overrides), clock, () => current);
  const setConfig = (next: Record<string, unknown>) => {
    current = next;
  };
  return { clock, store, service, setConfig };
}

function evidence(observedAtMs: number, passed = true) {
  return [
    { name: "readiness", passed, observedAtMs },
    { name: "error_rate", passed: true, observedAtMs },
  ];
}

async function startRollout(ctx: ReturnType<typeof setup>) {
  const baseline = await ctx.service.captureSnapshot(admin);
  ctx.setConfig({ health: { probeTimeoutMs: 3000 } });
  const target = await ctx.service.captureSnapshot(admin);
  const rollout = await ctx.service.createRollout(admin, {
    snapshotId: target.id,
    environment: "production",
    baselineSnapshotId: baseline.id,
  });
  return { baseline, target, rollout };
}

describe("ConfigRolloutService", () => {
  describe("snapshots", () => {
    it("captures a signed snapshot without secret values", async () => {
      const { service } = setup();
      const snapshot = await service.captureSnapshot(admin);

      expect(snapshot).toMatchObject({ environment: "staging", origin: "CAPTURED", created: true });
      expect(JSON.stringify(snapshot)).not.toContain("never-stored");
      expect(snapshot.document.excluded).toEqual([{ path: "sessionSecret", reason: "secret_name" }]);
      await expect(service.getSnapshot(snapshot.id)).resolves.toMatchObject({ verified: true });
    });

    it("returns the existing snapshot when configuration is unchanged (replay-safe)", async () => {
      const { clock, service, store } = setup();
      const first = await service.captureSnapshot(admin);
      clock.advanceMs(MIN);
      const second = await service.captureSnapshot(admin);

      expect(second).toMatchObject({ id: first.id, created: false });
      expect(second.document.capturedAt).toBe(first.document.capturedAt);
      expect(store.snapshots.size).toBe(1);
    });

    it("refuses to capture without a signing key", async () => {
      const { service } = setup({ "configRollout.signingSecret": undefined });
      await expect(service.captureSnapshot(admin)).rejects.toThrow(ServiceUnavailableException);
    });

    it("derives a signing key from the credential secret when no dedicated one is set", async () => {
      const { service } = setup({ "configRollout.signingSecret": undefined, credentialSigningSecret: "cred-secret" });
      await expect(service.captureSnapshot(admin)).resolves.toMatchObject({
        document: { signature: { keyId: "derived-credential" } },
      });
    });

    it("imports a peer environment's snapshot and compares it semantically", async () => {
      const { service } = setup();
      const local = await service.captureSnapshot(admin);
      const key = resolveSigningKey({ dedicatedSecret: SIGNING })!;
      const production = buildSnapshot({ health: { probeTimeoutMs: 5000 }, extra: true }, "production", new Date(T0), key);

      const imported = await service.importSnapshot(admin, production);
      const comparison = await service.compare(local.id, imported.id);

      expect(imported).toMatchObject({ environment: "production", origin: "IMPORTED" });
      expect(comparison.diff).toMatchObject({
        identical: false,
        added: [{ path: "extra", value: true }],
        changed: [{ path: "health.probeTimeoutMs", before: 2000, after: 5000 }],
        excludedRemoved: ["sessionSecret"],
      });
    });

    it.each([
      ["a tampered document", () => {
        const doc = buildSnapshot({ a: 1 }, "production", new Date(T0), resolveSigningKey({ dedicatedSecret: SIGNING })!);
        doc.entries.a = 2;
        return doc;
      }, "content_hash_mismatch"],
      ["a foreign-signed document", () =>
        buildSnapshot({ a: 1 }, "production", new Date(T0), { keyId: "dedicated", secret: "f".repeat(32) }), "signature_invalid"],
      ["a malformed document", () => ({ schema: "x" }) as never, "malformed_document"],
    ])("refuses to import %s", async (_label, make, reason) => {
      const { service } = setup();
      await expect(service.importSnapshot(admin, make())).rejects.toThrow(
        new BadRequestException(`Snapshot rejected: ${reason}`),
      );
    });

    it("returns 404 for unknown snapshots", async () => {
      const { service } = setup();
      await expect(service.compare("nope", "nope")).rejects.toThrow(NotFoundException);
    });
  });

  describe("rollouts", () => {
    it("walks every stage behind passing gates and completes", async () => {
      const ctx = setup();
      const { target, rollout } = await startRollout(ctx);
      let view = rollout;
      expect(view).toMatchObject({ status: "CANARY", stageIndex: 0, currentPercent: 5, version: 0 });

      for (const percent of [5, 25, 100]) {
        expect(view.currentPercent).toBe(percent);
        ctx.clock.advanceMs(5 * MIN);
        view = await ctx.service.recordGate(admin, view.id, {
          expectedVersion: view.version,
          stageIndex: view.stageIndex,
          checks: evidence(ctx.clock.nowMs()),
        });
        view = await ctx.service.promote(admin, view.id, view.version);
      }

      expect(view).toMatchObject({ status: "COMPLETED", completedAt: expect.any(String) });
      expect(view.events.map((event) => event.type)).toEqual([
        "CREATED",
        "GATE_PASSED",
        "PROMOTED",
        "GATE_PASSED",
        "PROMOTED",
        "GATE_PASSED",
        "COMPLETED",
      ]);
      // The completed snapshot becomes the next rollout's default baseline.
      await expect(ctx.store.activeSnapshotId("production")).resolves.toBe(target.id);
    });

    it("blocks promotion after a failed gate and records rollback evidence", async () => {
      const ctx = setup();
      const { baseline, target, rollout } = await startRollout(ctx);
      ctx.clock.advanceMs(MIN);

      const blocked = await ctx.service.recordGate(admin, rollout.id, {
        expectedVersion: 0,
        stageIndex: 0,
        checks: evidence(ctx.clock.nowMs(), false),
      });
      expect(blocked.status).toBe("BLOCKED");
      await expect(ctx.service.promote(admin, rollout.id, blocked.version)).rejects.toThrow(ConflictException);

      const rolledBack = await ctx.service.rollback(admin, rollout.id, {
        expectedVersion: blocked.version,
        reason: "health_gate_failed",
      });
      const event = rolledBack.events.at(-1)!;
      expect(rolledBack.status).toBe("ROLLED_BACK");
      expect(event).toMatchObject({
        type: "ROLLED_BACK",
        evidence: {
          reason: "health_gate_failed",
          restoredSnapshotId: baseline.id,
          abandonedSnapshotId: target.id,
          statusAtRollback: "BLOCKED",
          failedGateEventId: blocked.lastGate!.eventId,
        },
      });
      await expect(ctx.service.cohort(rollout.id, "api-1")).resolves.toEqual({
        inCohort: false,
        percent: 0,
        snapshotId: baseline.id,
      });
    });

    it("refuses promotion without any gate", async () => {
      const ctx = setup();
      const { rollout } = await startRollout(ctx);
      await expect(ctx.service.promote(admin, rollout.id, 0)).rejects.toMatchObject({
        response: { code: "gate_required" },
      });
    });

    it("refuses a promotion once the passing gate has expired", async () => {
      const ctx = setup();
      const { rollout } = await startRollout(ctx);
      const gated = await ctx.service.recordGate(admin, rollout.id, {
        expectedVersion: 0,
        stageIndex: 0,
        checks: evidence(ctx.clock.nowMs()),
      });
      ctx.clock.advanceMs(60 * MIN + 1);
      await expect(ctx.service.promote(admin, rollout.id, gated.version)).rejects.toMatchObject({
        response: { code: "gate_expired" },
      });
    });

    it("refuses gate evidence from before the current stage (replay)", async () => {
      const ctx = setup();
      const { rollout } = await startRollout(ctx);
      const old = ctx.clock.nowMs();
      ctx.clock.advanceMs(MIN);
      let view = await ctx.service.recordGate(admin, rollout.id, { expectedVersion: 0, stageIndex: 0, checks: evidence(old) });
      view = await ctx.service.promote(admin, rollout.id, view.version);
      // Re-submitting stage-0 evidence against stage 1 blocks it.
      view = await ctx.service.recordGate(admin, rollout.id, {
        expectedVersion: view.version,
        stageIndex: 1,
        checks: evidence(old),
      });
      expect(view.status).toBe("BLOCKED");
      expect(view.events.at(-1)!.evidence.failures).toEqual([
        { check: "error_rate", reason: "predates_stage" },
        { check: "readiness", reason: "predates_stage" },
      ]);
    });

    it("refuses stale versions and replayed decisions", async () => {
      const ctx = setup();
      const { rollout } = await startRollout(ctx);
      const gated = await ctx.service.recordGate(admin, rollout.id, { expectedVersion: 0, stageIndex: 0, checks: evidence(T0) });
      await ctx.service.promote(admin, rollout.id, gated.version);

      await expect(ctx.service.promote(admin, rollout.id, gated.version)).rejects.toMatchObject({
        response: { code: "stale_version" },
      });
      await expect(
        ctx.service.recordGate(admin, rollout.id, { expectedVersion: 0, stageIndex: 0, checks: evidence(T0) }),
      ).rejects.toMatchObject({ response: { code: "stale_version" } });
    });

    it("lets exactly one of two concurrent promotions win", async () => {
      const ctx = setup();
      const { rollout } = await startRollout(ctx);
      const gated = await ctx.service.recordGate(admin, rollout.id, { expectedVersion: 0, stageIndex: 0, checks: evidence(T0) });

      const results = await Promise.allSettled([
        ctx.service.promote(admin, rollout.id, gated.version),
        ctx.service.promote(admin, rollout.id, gated.version),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const final = await ctx.service.getRollout(rollout.id);
      expect(final).toMatchObject({ stageIndex: 1, version: gated.version + 1 });
      expect(final.events.filter((event) => event.type === "PROMOTED")).toHaveLength(1);
    });

    it("allows one open rollout per environment", async () => {
      const ctx = setup();
      const { target } = await startRollout(ctx);
      await expect(
        ctx.service.createRollout(admin, { snapshotId: target.id, environment: "production" }),
      ).rejects.toThrow(ConflictException);
      // A different environment is independent.
      await expect(
        ctx.service.createRollout(admin, { snapshotId: target.id, environment: "staging" }),
      ).resolves.toMatchObject({ status: "CANARY" });
    });

    it("cannot roll back a completed rollout", async () => {
      const ctx = setup();
      const { rollout } = await startRollout(ctx);
      let view = rollout;
      for (let i = 0; i < 3; i += 1) {
        view = await ctx.service.recordGate(admin, view.id, { expectedVersion: view.version, stageIndex: view.stageIndex, checks: evidence(ctx.clock.nowMs()) });
        view = await ctx.service.promote(admin, view.id, view.version);
      }
      await expect(
        ctx.service.rollback(admin, view.id, { expectedVersion: view.version, reason: "operator_request" }),
      ).rejects.toMatchObject({ response: { code: "not_open" } });
    });

    it.each([
      ["non-increasing stages", { stages: [50, 50, 100] }],
      ["stages not ending at 100", { stages: [5, 50] }],
    ])("rejects %s", async (_label, input) => {
      const ctx = setup();
      const snapshot = await ctx.service.captureSnapshot(admin);
      await expect(
        ctx.service.createRollout(admin, { snapshotId: snapshot.id, environment: "production", ...input }),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses to roll out the snapshot that is already the baseline", async () => {
      const ctx = setup();
      const snapshot = await ctx.service.captureSnapshot(admin);
      await expect(
        ctx.service.createRollout(admin, { snapshotId: snapshot.id, environment: "production", baselineSnapshotId: snapshot.id }),
      ).rejects.toThrow(BadRequestException);
    });

    it("assigns canary instances deterministically and grows the cohort on promotion", async () => {
      const ctx = setup();
      const { baseline, target, rollout } = await startRollout(ctx);
      const instances = Array.from({ length: 200 }, (_, i) => `api-${i}`);

      const atFive = await Promise.all(instances.map((id) => ctx.service.cohort(rollout.id, id)));
      const gated = await ctx.service.recordGate(admin, rollout.id, { expectedVersion: 0, stageIndex: 0, checks: evidence(T0) });
      await ctx.service.promote(admin, rollout.id, gated.version);
      const atTwentyFive = await Promise.all(instances.map((id) => ctx.service.cohort(rollout.id, id)));

      atFive.forEach((assignment, i) => {
        expect(assignment.snapshotId).toBe(assignment.inCohort ? target.id : baseline.id);
        if (assignment.inCohort) expect(atTwentyFive[i].inCohort).toBe(true);
      });
      expect(atTwentyFive.filter((a) => a.inCohort).length).toBeGreaterThan(atFive.filter((a) => a.inCohort).length);
    });
  });
});
