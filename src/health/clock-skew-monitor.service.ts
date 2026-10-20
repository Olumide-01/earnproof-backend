import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  advanceAlert,
  assertValidClockSkewPolicy,
  breachSeverity,
  classifySkew,
  ClockSkewAssessment,
  ClockSkewPolicy,
  ClockSkewStatus,
  estimateSkew,
  INITIAL_ALERT_STATE,
  SampleRejection,
  SkewEstimate,
  SustainedAlertPolicy,
  SustainedAlertState,
  UnknownTimePolicy,
} from "../common/time/clock-skew";
import { Clock, SystemClock } from "../common/time/clock";
import {
  HorizonHttpDateTimeSource,
  HorizonLedgerTimeSource,
  TimeSource,
  TimeSourceError,
} from "../stellar/ledger-time-source";

/**
 * How clock skew affects readiness.
 *
 * - `none`     — reported in diagnostics only; readiness never changes.
 * - `critical` — readiness fails while a *sustained* critical alert is active
 *                (which, under `fail_closed`, includes sustained unknown time).
 *
 * Readiness is gated on the sustained alert rather than on one assessment, so a
 * single slow or lying response cannot drain a replica from the load balancer.
 */
export type ClockSkewReadinessImpact = "none" | "critical";

export interface ClockSkewMonitorSettings {
  enabled: boolean;
  intervalMs: number;
  probeTimeoutMs: number;
  readinessImpact: ClockSkewReadinessImpact;
  policy: ClockSkewPolicy;
  alert: SustainedAlertPolicy;
}

export const CLOCK_SKEW_DEFAULTS: ClockSkewMonitorSettings = {
  enabled: true,
  intervalMs: 60_000,
  probeTimeoutMs: 2_000,
  readinessImpact: "critical",
  policy: {
    warnMs: 2_000,
    criticalMs: 10_000,
    maxRoundTripMs: 5_000,
    maxSampleAgeMs: 180_000,
    unknownPolicy: "fail_open",
  },
  alert: { sustainForMs: 300_000, clearAfterAssessments: 2 },
};

/** Privacy-safe snapshot for the authorized diagnostics endpoint. */
export interface ClockSkewSnapshot {
  status: ClockSkewAssessment["status"];
  skewMs?: number;
  source?: string;
  reason?: string;
  samplesConsidered: number;
  evaluatedAt: string;
  alert: { active: boolean; severity: "warning" | "critical" | null; breachStartedAt: string | null };
  policy: {
    warnMs: number;
    criticalMs: number;
    unknownPolicy: UnknownTimePolicy;
    readinessImpact: ClockSkewReadinessImpact;
  };
  /** Per-source outcome of the most recent measurement. Codes and numbers only. */
  sources: Array<{ name: string; outcome: "ok" | SampleRejection | string; skewMs?: number }>;
}

/**
 * Measures local clock skew against trusted network time and raises an alert
 * on sustained deviation (earnproof-backend#328).
 *
 * The monitor only ever *reads* the injected {@link Clock}. It has no code
 * path that sets, slews or offsets time, and nothing downstream consumes its
 * estimate as a correction.
 */
@Injectable()
export class ClockSkewMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClockSkewMonitorService.name);
  private readonly settings: ClockSkewMonitorSettings;
  private readonly sources: readonly TimeSource[];

  private readonly latest = new Map<string, SkewEstimate>();
  private readonly lastSequence = new Map<string, number>();
  private sourceOutcomes: ClockSkewSnapshot["sources"] = [];
  private alertState: SustainedAlertState = INITIAL_ALERT_STATE;
  private inFlight: Promise<ClockSkewAssessment> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    config: ConfigService,
    @Optional() private readonly clock: Clock = new SystemClock(),
    @Optional() sources?: TimeSource[],
  ) {
    this.settings = resolveSettings(config);
    const horizonUrl = config.get<string>("stellar.horizonUrl");
    this.sources =
      sources ??
      (typeof horizonUrl === "string" && horizonUrl.trim() !== ""
        ? [
            new HorizonLedgerTimeSource(horizonUrl, config.get<number>("clockSkew.ledgerCloseAllowanceMs")),
            new HorizonHttpDateTimeSource(horizonUrl),
          ]
        : []);
  }

  onModuleInit(): void {
    if (!this.settings.enabled || this.sources.length === 0) return;
    // Background sampling, so the sustained-deviation window is measured even
    // when nothing polls readiness. unref() keeps it from holding the process
    // open at shutdown.
    this.timer = setInterval(() => {
      void this.measure().catch((error: unknown) => {
        this.logger.warn(
          `Clock skew measurement failed: ${error instanceof Error ? error.name : "unknown"}`,
        );
      });
    }, this.settings.intervalMs);
    this.timer.unref?.();
    void this.measure().catch(() => undefined);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  get readinessImpact(): ClockSkewReadinessImpact {
    return this.settings.readinessImpact;
  }

  /**
   * Samples every source once and advances the alert state.
   *
   * Single-flight: concurrent callers share one measurement, so a burst of
   * readiness polls cannot fan out into a burst of Horizon requests, and the
   * alert state machine is advanced exactly once per measurement.
   */
  measure(): Promise<ClockSkewAssessment> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.measureOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Classifies what is already known, without any I/O.
   *
   * Staleness is evaluated at the time of the call, so a monitor whose sampler
   * has stopped degrades to UNKNOWN on its own instead of serving its last
   * good verdict forever.
   */
  assess(): ClockSkewAssessment {
    return classifySkew([...this.latest.values()], this.settings.policy, this.clock.nowMs());
  }

  /** True when readiness must fail under the configured impact policy. */
  blocksReadiness(): boolean {
    if (!this.settings.enabled || this.settings.readinessImpact === "none") return false;
    // Re-evaluate staleness now: an alert raised on fresh data must not be the
    // only thing standing between a stopped sampler and a green readiness.
    const current = breachSeverity(this.assess(), this.settings.policy.unknownPolicy);
    return this.alertState.activeSeverity === "critical" && current === "critical";
  }

  snapshot(): ClockSkewSnapshot {
    const assessment = this.assess();
    return {
      status: assessment.status,
      skewMs: assessment.skewMs,
      source: assessment.source,
      reason: assessment.reason,
      samplesConsidered: assessment.samplesConsidered,
      evaluatedAt: new Date(assessment.evaluatedAtMs).toISOString(),
      alert: {
        active: this.alertState.activeSeverity !== null,
        severity: this.alertState.activeSeverity,
        breachStartedAt:
          this.alertState.breachStartedAtMs === null
            ? null
            : new Date(this.alertState.breachStartedAtMs).toISOString(),
      },
      policy: {
        warnMs: this.settings.policy.warnMs,
        criticalMs: this.settings.policy.criticalMs,
        unknownPolicy: this.settings.policy.unknownPolicy,
        readinessImpact: this.settings.readinessImpact,
      },
      sources: [...this.sourceOutcomes],
    };
  }

  private async measureOnce(): Promise<ClockSkewAssessment> {
    const outcomes = await Promise.all(this.sources.map((source) => this.sample(source)));
    this.sourceOutcomes = outcomes;

    const assessment = this.assess();

    const severity = breachSeverity(assessment, this.settings.policy.unknownPolicy);
    const { state, transition } = advanceAlert(
      this.alertState,
      severity,
      assessment.evaluatedAtMs,
      this.settings.alert,
    );
    this.alertState = state;
    if (transition) this.logTransition(transition.type, assessment);

    return assessment;
  }

  private async sample(source: TimeSource): Promise<ClockSkewSnapshot["sources"][number]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.probeTimeoutMs);
    const localSentMs = this.clock.nowMs();
    try {
      const reading = await source.read(controller.signal);
      const localReceivedMs = this.clock.nowMs();
      const estimate = estimateSkew(
        { ...reading, source: source.name, localSentMs, localReceivedMs },
        this.settings.policy,
        this.lastSequence.get(source.name),
      );
      if (typeof estimate === "string") {
        return { name: source.name, outcome: estimate };
      }
      if (reading.sequence !== undefined) this.lastSequence.set(source.name, reading.sequence);
      this.latest.set(source.name, estimate);
      return { name: source.name, outcome: "ok", skewMs: estimate.skewMs };
    } catch (error) {
      // Only codes this module minted are echoed; anything else may carry a
      // URL or a body fragment and collapses to a generic code.
      const outcome =
        error instanceof TimeSourceError
          ? error.code
          : controller.signal.aborted
            ? "probe_timeout"
            : "probe_failed";
      return { name: source.name, outcome };
    } finally {
      clearTimeout(timer);
    }
  }

  private logTransition(type: string, assessment: ClockSkewAssessment): void {
    const detail = JSON.stringify({
      event: `clock_skew.alert_${type}`,
      status: assessment.status,
      skewMs: assessment.skewMs ?? null,
      source: assessment.source ?? null,
      reason: assessment.reason ?? null,
      severity: this.alertState.activeSeverity,
    });
    if (type === "cleared" || type === "deescalated") {
      this.logger.log(detail);
    } else if (this.alertState.activeSeverity === "critical") {
      this.logger.error(detail);
    } else {
      this.logger.warn(detail);
    }
  }
}

/** Reads settings from configuration, falling back to documented defaults. */
export function resolveSettings(config: ConfigService): ClockSkewMonitorSettings {
  const d = CLOCK_SKEW_DEFAULTS;
  const unknownPolicy = config.get<string>("clockSkew.unknownPolicy") ?? d.policy.unknownPolicy;
  const readinessImpact = config.get<string>("clockSkew.readinessImpact") ?? d.readinessImpact;
  const settings: ClockSkewMonitorSettings = {
    enabled: config.get<boolean>("clockSkew.enabled") ?? d.enabled,
    intervalMs: config.get<number>("clockSkew.intervalMs") ?? d.intervalMs,
    probeTimeoutMs: config.get<number>("clockSkew.probeTimeoutMs") ?? d.probeTimeoutMs,
    readinessImpact: readinessImpact as ClockSkewReadinessImpact,
    policy: {
      warnMs: config.get<number>("clockSkew.warnMs") ?? d.policy.warnMs,
      criticalMs: config.get<number>("clockSkew.criticalMs") ?? d.policy.criticalMs,
      maxRoundTripMs: config.get<number>("clockSkew.maxRoundTripMs") ?? d.policy.maxRoundTripMs,
      maxSampleAgeMs: config.get<number>("clockSkew.maxSampleAgeMs") ?? d.policy.maxSampleAgeMs,
      unknownPolicy: unknownPolicy as UnknownTimePolicy,
    },
    alert: {
      sustainForMs: config.get<number>("clockSkew.sustainForMs") ?? d.alert.sustainForMs,
      clearAfterAssessments:
        config.get<number>("clockSkew.clearAfterAssessments") ?? d.alert.clearAfterAssessments,
    },
  };
  assertValidClockSkewPolicy(settings.policy);
  if (readinessImpact !== "none" && readinessImpact !== "critical") {
    throw new Error("clockSkew.readinessImpact must be none or critical");
  }
  if (!Number.isInteger(settings.alert.clearAfterAssessments) || settings.alert.clearAfterAssessments < 1) {
    throw new Error("clockSkew.clearAfterAssessments must be a positive integer");
  }
  if (settings.alert.sustainForMs < 0) {
    throw new Error("clockSkew.sustainForMs must not be negative");
  }
  return settings;
}

export { ClockSkewStatus };
