import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FixedClock } from "../../test/time/fixed-clock";
import type { TimeSourceReading } from "../common/time/clock-skew";
import { TimeSource, TimeSourceError } from "../stellar/ledger-time-source";
import { ClockSkewMonitorService, resolveSettings } from "./clock-skew-monitor.service";

const T0 = Date.parse("2030-01-01T00:00:00.000Z");

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    "clockSkew.enabled": true,
    "clockSkew.warnMs": 2_000,
    "clockSkew.criticalMs": 10_000,
    "clockSkew.maxRoundTripMs": 5_000,
    "clockSkew.maxSampleAgeMs": 180_000,
    "clockSkew.sustainForMs": 300_000,
    "clockSkew.clearAfterAssessments": 2,
    "clockSkew.unknownPolicy": "fail_closed",
    "clockSkew.readinessImpact": "critical",
    "clockSkew.probeTimeoutMs": 50,
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

/**
 * A source that reports network time as `clock - offsetMs`, so a positive
 * offset means the local clock is ahead. `roundTripMs` advances the clock
 * during the read to model latency.
 */
class ScriptedSource implements TimeSource {
  offsetMs = 0;
  roundTripMs = 100;
  failure: Error | null = null;
  reads = 0;

  constructor(
    readonly name: string,
    private readonly clock: FixedClock,
  ) {}

  async read(): Promise<TimeSourceReading> {
    this.reads += 1;
    if (this.failure) throw this.failure;
    const referenceMs = this.clock.nowMs() - this.offsetMs;
    this.clock.advanceMs(this.roundTripMs);
    return { referenceMs, resolutionMs: 0, maxReferenceLagMs: 0 };
  }
}

function setup(overrides: Record<string, unknown> = {}) {
  const clock = new FixedClock(T0);
  const source = new ScriptedSource("scripted", clock);
  const monitor = new ClockSkewMonitorService(config(overrides), clock, [source]);
  return { clock, source, monitor };
}

describe("ClockSkewMonitorService", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("measures skew without ever setting the clock", async () => {
    const { clock, source, monitor } = setup();
    source.offsetMs = 30_000;
    const set = jest.spyOn(clock, "set");
    const before = clock.nowMs();

    const assessment = await monitor.measure();

    expect(assessment.status).toBe("critical");
    expect(set).not.toHaveBeenCalled();
    // Only the simulated network latency moved the clock, never a correction.
    expect(clock.nowMs()).toBe(before + source.roundTripMs);
  });

  it("reports OK for agreeing clocks", async () => {
    const { monitor } = setup();
    await expect(monitor.measure()).resolves.toMatchObject({ status: "ok", skewMs: 0 });
  });

  it("coalesces concurrent measurements into one read per source", async () => {
    const { source, monitor } = setup();

    const [a, b, c] = await Promise.all([monitor.measure(), monitor.measure(), monitor.measure()]);

    expect(source.reads).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("starts a fresh measurement once the previous one settled", async () => {
    const { source, monitor } = setup();
    await monitor.measure();
    await monitor.measure();
    expect(source.reads).toBe(2);
  });

  describe("readiness impact", () => {
    it("does not block readiness on a transient critical reading", async () => {
      const { source, monitor } = setup();
      source.offsetMs = 60_000;

      await monitor.measure();

      expect(monitor.snapshot().status).toBe("critical");
      expect(monitor.blocksReadiness()).toBe(false);
    });

    it("blocks readiness once a critical breach is sustained", async () => {
      const { clock, source, monitor } = setup();
      source.offsetMs = 60_000;

      await monitor.measure();
      clock.advanceMs(300_000);
      await monitor.measure();

      expect(monitor.snapshot().alert).toMatchObject({ active: true, severity: "critical" });
      expect(monitor.blocksReadiness()).toBe(true);
    });

    it("never blocks readiness on a sustained warning", async () => {
      const { clock, source, monitor } = setup();
      source.offsetMs = 3_000;

      await monitor.measure();
      clock.advanceMs(300_000);
      await monitor.measure();

      expect(monitor.snapshot().alert).toMatchObject({ active: true, severity: "warning" });
      expect(monitor.blocksReadiness()).toBe(false);
    });

    it("unblocks as soon as a fresh healthy reading arrives, before the alert clears", async () => {
      const { clock, source, monitor } = setup();
      source.offsetMs = 60_000;
      await monitor.measure();
      clock.advanceMs(300_000);
      await monitor.measure();

      source.offsetMs = 0;
      await monitor.measure();

      expect(monitor.snapshot().alert.active).toBe(true);
      expect(monitor.blocksReadiness()).toBe(false);
    });

    it("never blocks when readiness impact is none", async () => {
      const { clock, source, monitor } = setup({ "clockSkew.readinessImpact": "none" });
      source.offsetMs = 60_000;
      await monitor.measure();
      clock.advanceMs(300_000);
      await monitor.measure();

      expect(monitor.blocksReadiness()).toBe(false);
    });
  });

  describe("unknown time health", () => {
    async function sustainedOutage(unknownPolicy: string) {
      const { clock, source, monitor } = setup({ "clockSkew.unknownPolicy": unknownPolicy });
      source.failure = new TimeSourceError("upstream_status_503");
      await monitor.measure();
      clock.advanceMs(300_000);
      await monitor.measure();
      return monitor;
    }

    it("fails closed: a sustained unknown blocks readiness", async () => {
      const monitor = await sustainedOutage("fail_closed");
      expect(monitor.snapshot()).toMatchObject({ status: "unknown", reason: "no_samples" });
      expect(monitor.blocksReadiness()).toBe(true);
    });

    it("fails open: a sustained unknown is reported but never blocks", async () => {
      const monitor = await sustainedOutage("fail_open");
      expect(monitor.snapshot()).toMatchObject({ status: "unknown", alert: { active: false } });
      expect(monitor.blocksReadiness()).toBe(false);
    });

    it("degrades a stopped sampler to UNKNOWN instead of serving its last verdict", async () => {
      const { clock, monitor } = setup();
      await monitor.measure();
      expect(monitor.assess().status).toBe("ok");

      clock.advanceMs(180_001);

      expect(monitor.assess()).toMatchObject({ status: "unknown", reason: "no_fresh_samples" });
    });
  });

  describe("source failures", () => {
    it("echoes only codes it minted itself", async () => {
      const { source, monitor } = setup();
      source.failure = new TimeSourceError("ledger_response_malformed");
      await monitor.measure();
      expect(monitor.snapshot().sources).toEqual([
        { name: "scripted", outcome: "ledger_response_malformed" },
      ]);
    });

    it("collapses arbitrary errors to a generic code", async () => {
      const { source, monitor } = setup();
      source.failure = new Error("connect ECONNREFUSED https://user:pw@horizon.internal");
      await monitor.measure();
      const snapshot = JSON.stringify(monitor.snapshot());
      expect(snapshot).toContain("probe_failed");
      expect(snapshot).not.toContain("horizon.internal");
    });

    it("reports a hung source as a timeout", async () => {
      const clock = new FixedClock(T0);
      const hung: TimeSource = {
        name: "hung",
        read: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      };
      const monitor = new ClockSkewMonitorService(config(), clock, [hung]);
      await monitor.measure();
      expect(monitor.snapshot().sources).toEqual([{ name: "hung", outcome: "probe_timeout" }]);
    });

    it("discards samples whose round trip is too slow to bound skew", async () => {
      const { source, monitor } = setup();
      source.roundTripMs = 5_001;
      await monitor.measure();
      expect(monitor.snapshot()).toMatchObject({
        status: "unknown",
        sources: [{ name: "scripted", outcome: "round_trip_exceeded" }],
      });
    });
  });

  it("logs alert transitions as structured events without identifiers", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { clock, source, monitor } = setup();
    source.offsetMs = 60_000;
    await monitor.measure();
    clock.advanceMs(300_000);
    await monitor.measure();

    expect(error).toHaveBeenCalledTimes(1);
    const event = JSON.parse(error.mock.calls[0][0] as string);
    expect(event).toMatchObject({ event: "clock_skew.alert_raised", severity: "critical" });
  });

  describe("lifecycle", () => {
    it("does not schedule sampling when disabled", () => {
      const spy = jest.spyOn(global, "setInterval");
      const { monitor } = setup({ "clockSkew.enabled": false });
      monitor.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
      expect(monitor.blocksReadiness()).toBe(false);
    });

    it("does not schedule sampling without any time source", () => {
      const spy = jest.spyOn(global, "setInterval");
      const monitor = new ClockSkewMonitorService(config(), new FixedClock(T0), []);
      monitor.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
    });

    it("schedules and cancels the background sampler", () => {
      jest.useFakeTimers();
      try {
        const { monitor, source } = setup({ "clockSkew.intervalMs": 60_000 });
        monitor.onModuleInit();
        expect(source.reads).toBe(1);
        monitor.onModuleDestroy();
        jest.advanceTimersByTime(120_000);
        expect(source.reads).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("resolveSettings", () => {
    it("rejects an unrecognised readiness impact", () => {
      expect(() => resolveSettings(config({ "clockSkew.readinessImpact": "warning" }))).toThrow(
        /readinessImpact/,
      );
    });

    it("rejects inverted thresholds", () => {
      expect(() => resolveSettings(config({ "clockSkew.criticalMs": 1_000 }))).toThrow(
        /criticalMs/,
      );
    });

    it("rejects a zero clear streak", () => {
      expect(() => resolveSettings(config({ "clockSkew.clearAfterAssessments": 0 }))).toThrow(
        /clearAfterAssessments/,
      );
    });

    it("falls back to documented defaults for absent keys", () => {
      const settings = resolveSettings({ get: () => undefined } as unknown as ConfigService);
      expect(settings).toMatchObject({
        readinessImpact: "critical",
        policy: { warnMs: 2_000, criticalMs: 10_000, unknownPolicy: "fail_open" },
      });
    });
  });
});
