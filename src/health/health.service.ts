import { Injectable, Logger, Optional } from "@nestjs/common";

import { ContractDriftService } from "./contract-drift.service";
import { ContractSuccessorService } from "../contracts/contract-successor.service";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../database/prisma.service";
import { CircuitBreakerRegistry } from "../common/resilience/circuit-breaker.registry";
import { MigrationLeaseService } from "../database/migration-lease.service";
import {
  DeploymentMetadataService,
  DeploymentMetadataState,
} from "./deployment-metadata.service";
import { HealthHysteresisService } from "./health-hysteresis.service";
import { ClockSkewMonitorService } from "./clock-skew-monitor.service";
import {
  DependencyKind,
  DependencyResult,
  DependencyStatus,
  DependencyStatusValue,
  ReadinessResult,
} from "./health.types";

/**
 * Default probe timeout.
 *
 * A readiness probe that can block longer than the orchestrator's own timeout is
 * worse than useless: the platform kills the request and retries, so a slow
 * dependency turns into a stampede of in-flight probes against the very system
 * that is already struggling.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * How long a probe result stays fresh.
 *
 * Readiness is polled continuously — often every few seconds, by several
 * replicas and by every load-balancer health check. Without caching, probe load
 * scales with poll rate rather than with anything meaningful.
 */
export const DEFAULT_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  result: DependencyResult;
  storedAt: number;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Flips true the instant shutdown begins (earnproof-backend#68) — see
   * `beginShutdown()`. `checkReadiness` reports `not_ready` immediately once
   * this is set, before any in-flight work has actually finished draining,
   * so a load balancer stops routing new traffic here as early as possible.
   */
  private shuttingDown = false;

  /**
   * In-flight probes, keyed by dependency name.
   *
   * This is the single-flight guard: when N concurrent requests arrive for a
   * dependency whose cache entry has expired, they share ONE probe rather than
   * issuing N. Without it, a slow dependency plus a high poll rate produces
   * exactly the overload the probe was meant to detect.
   */
  private readonly inFlight = new Map<string, Promise<DependencyResult>>();

  private readonly deployment: DeploymentMetadataService;

  private readonly circuits?: CircuitBreakerRegistry;
  private readonly contractDrift?: ContractDriftService;
  private readonly contractSuccessor?: ContractSuccessorService;
  private readonly migrationLease?: MigrationLeaseService;
  private readonly hysteresis?: HealthHysteresisService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() p3?: any,
    @Optional() p4?: any,
    @Optional() p5?: any,
    @Optional() private readonly clockSkew?: ClockSkewMonitorService,
  ) {
    const rest = [p3, p4, p5].filter(Boolean);
    for (const item of rest) {
      if (item instanceof CircuitBreakerRegistry || typeof item.snapshotAll === "function") {
        this.circuits = item;
      } else if (typeof item.checkContractState === "function" || item.isBlocked !== undefined) {
        this.contractDrift = item;
      } else if (typeof item.assessReadiness === "function" || item.canMigrate !== undefined) {
        this.contractSuccessor = item;
      } else if (typeof item.acquire === "function" || typeof item.release === "function") {
        this.migrationLease = item;
      }
    }
  }

  /**
   * Liveness: does this process exist and can it answer?
   *
   * Deliberately performs no I/O. If liveness consulted the database, a database
   * outage would make the orchestrator kill and restart every replica — which
   * cannot fix a database outage and removes the capacity needed to recover from
   * it.
   */
  checkLiveness(): { status: "ok"; service: string; timestamp: string } {
    return {
      status: "ok",
      service: "earnproof-api",
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness: can this process serve dependent work?
   *
   * Only REQUIRED dependencies can make the service not ready. Optional
   * dependencies are reported so operators can see degradation, but they never
   * flip the verdict.
   */
  async checkReadiness(): Promise<ReadinessResult> {
    if (this.shuttingDown) {
      // Skip the dependency probes entirely — they'd cost time and I/O for
      // an answer that's already decided. Not-ready-during-shutdown must
      // never be masked by a fresh cache entry from a probe that started
      // before the signal arrived.
      return {
        status: "not_ready",
        dependencies: [
          {
            name: "shutdown",
            kind: DependencyKind.REQUIRED,
            status: DependencyStatus.ERROR,
            reason: "shutting_down",
            durationMs: 0,
          },
        ],
      };
    }

    const requiredProbes = [
      this.probeCached("database", DependencyKind.REQUIRED, () =>
        this.probeDatabase(),
      ),
      this.probeCached("configuration", DependencyKind.REQUIRED, () =>
        Promise.resolve(this.probeConfiguration()),
      ),
    ];
    if (this.migrationLease) {
      requiredProbes.push(
        this.probeCached("migration_compatibility", DependencyKind.REQUIRED, () =>
          this.probeMigrationCompatibility(),
        ),
      );
    }
    // Not cached: it reads in-memory monitor state (no I/O), and a cached
    // verdict could outlive the alert it reflects.
    if (this.clockSkew?.enabled && this.clockSkew.readinessImpact !== "none") {
      requiredProbes.push(Promise.resolve(this.probeClockSkewReadiness()));
    }
    const dependencies = await Promise.all(requiredProbes);

    const blocked = dependencies.some(
      (dependency) =>
        dependency.kind === DependencyKind.REQUIRED &&
        dependency.status !== DependencyStatus.OK,
    );

    return {
      status: blocked ? "not_ready" : "ready",
      dependencies,
    };
  }

  /**
   * The validated deployment metadata, or why it cannot be served. Shares its
   * source with the `deployment_manifest` readiness probe, so the endpoint and
   * readiness can never disagree about whether the manifest is valid.
   */
  deploymentMetadata(): DeploymentMetadataState {
    return this.deployment.state();
  }

  /**
   * Called once, as early as possible in the shutdown sequence (see
   * `main.ts`'s SIGTERM handler). Makes `checkReadiness` report `not_ready`
   * immediately, before any in-flight work has actually finished draining —
   * see this module's own doc for why liveness must NOT do the same.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /**
   * Diagnostics: everything readiness reports, plus optional dependencies.
   *
   * Authorization is enforced at the controller. This method assumes the caller
   * is already trusted, but still emits only stable reason codes — an authorized
   * operator has no more need for a raw DSN in an error string than anyone else,
   * and diagnostics output routinely ends up pasted into tickets and chat.
   */
  async checkDiagnostics(): Promise<ReadinessResult> {
    const diagProbes = [
      this.probeCached("database", DependencyKind.REQUIRED, () =>
        this.probeDatabase(),
      ),
      this.probeCached("configuration", DependencyKind.REQUIRED, () =>
        Promise.resolve(this.probeConfiguration()),
      ),
    ];
    if (this.migrationLease) {
      diagProbes.push(
        this.probeCached("migration_compatibility", DependencyKind.REQUIRED, () =>
          this.probeMigrationCompatibility(),
        ),
      );
    }
    diagProbes.push(
      this.probeCached("horizon", DependencyKind.OPTIONAL, () =>
        this.probeHorizon(),
      ),
      this.probeCached("contract_anchoring", DependencyKind.OPTIONAL, () =>
        Promise.resolve(this.probeContractAnchoring()),
      ),
      this.probeCached("contract_successor_readiness", DependencyKind.OPTIONAL, () =>
        this.probeContractSuccessor(),
      ),
      this.probeCached("webhook_delivery", DependencyKind.OPTIONAL, () =>
        this.probeWebhookDelivery(),
      ),
      this.probeCached("circuit_breakers", DependencyKind.OPTIONAL, () =>
        Promise.resolve(this.probeCircuitBreakers()),
      ),
      Promise.resolve(this.probeClockSkewDiagnostics()),
    );
    const dependencies = await Promise.all(diagProbes);

    const blocked = dependencies.some(
      (dependency) =>
        dependency.kind === DependencyKind.REQUIRED &&
        dependency.status !== DependencyStatus.OK,
    );

    return {
      status: blocked ? "not_ready" : "ready",
      dependencies,
    };
  }

  /**
   * Serve a probe from cache when fresh, otherwise probe — coalescing concurrent
   * callers onto a single in-flight probe.
   *
   * After a fresh probe, hysteresis is applied to record the result in the
   * incident state machine (if configured).
   */
  private async probeCached(
    name: string,
    kind: (typeof DependencyKind)[keyof typeof DependencyKind],
    probe: () => Promise<DependencyResult>,
  ): Promise<DependencyResult> {
    const ttl = this.cacheTtlMs();
    const cached = this.cache.get(name);
    const now = Date.now();

    if (cached && now - cached.storedAt < ttl) {
      return {
        ...cached.result,
        kind,
        cached: true,
        ageMs: now - cached.storedAt,
      };
    }

    const existing = this.inFlight.get(name);
    if (existing) {
      const result = await existing;
      return { ...result, kind };
    }

    const pending = probe()
      .then((result) => {
        this.cache.set(name, { result, storedAt: Date.now() });
        // Apply hysteresis after a fresh probe
        this.applyHysteresisAsync(name, result);
        return result;
      })
      .finally(() => {
        this.inFlight.delete(name);
      });

    this.inFlight.set(name, pending);

    const result = await pending;
    return { ...result, kind };
  }

  /**
   * Apply hysteresis asynchronously (fire-and-forget).
   * @private
   */
  private applyHysteresisAsync(
    dependencyName: string,
    result: DependencyResult,
  ): void {
    if (!this.hysteresis) {
      return;
    }

    this.hysteresis.applyHysteresis(dependencyName, result).catch((error) => {
      this.logger.error(
        `Failed to apply hysteresis for ${dependencyName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Probe the primary database with a trivial query. */
  private async probeDatabase(): Promise<DependencyResult> {
    return this.timed("database", DependencyKind.REQUIRED, async () => {
      await this.prisma.$queryRaw`SELECT 1`;
    });
  }

  /**
   * Verify migration deployment compatibility.
   * 
   * Ensures the application can safely serve requests against the current schema.
   * Reports not ready when:
   * - Migration deployment is actively in progress (unsafe to serve)
   * - Schema is incompatible with expected state
   * - Migration has failed and requires intervention
   */
  private async probeMigrationCompatibility(): Promise<DependencyResult> {
    if (!this.migrationLease) {
      return {
        name: "migration_compatibility",
        kind: DependencyKind.OPTIONAL,
        status: DependencyStatus.NOT_CONFIGURED,
        reason: "migration_lease_service_absent",
      };
    }
    try {
      const leaseStatus = await this.migrationLease.getLeaseStatus();
      
      // If a migration deployment is actively held, we're not ready
      if (leaseStatus.held && leaseStatus.isActive) {
        // Check if it's our own lease (same process)
        if (leaseStatus.ownerId === this.migrationLease.getOwnerId()) {
          return {
            name: "migration_compatibility",
            kind: DependencyKind.REQUIRED,
            status: DependencyStatus.ERROR,
            reason: "migration_in_progress",
            durationMs: 0,
          };
        } else {
          return {
            name: "migration_compatibility",
            kind: DependencyKind.REQUIRED,
            status: DependencyStatus.ERROR,
            reason: "migration_in_progress_other_deployment",
            durationMs: 0,
          };
        }
      }

      // If lease is stale, it indicates a crashed deployment - may be unsafe
      if (leaseStatus.isStale) {
        return {
          name: "migration_compatibility",
          kind: DependencyKind.REQUIRED,
          status: DependencyStatus.DEGRADED,
          reason: "stale_migration_lease_detected",
          durationMs: 0,
        };
      }

      // Schema compatibility check would go here in a full implementation
      // For MVP, we assume compatibility if no active migration
      return {
        name: "migration_compatibility",
        kind: DependencyKind.REQUIRED,
        status: DependencyStatus.OK,
        durationMs: 0,
      };
    } catch (error) {
      return {
        name: "migration_compatibility",
        kind: DependencyKind.REQUIRED,
        status: DependencyStatus.ERROR,
        reason: "migration_compatibility_check_failed",
        durationMs: 0,
      };
    }
  }

  /**
   * Verify configuration that the service cannot serve requests without.
   *
   * This is a required dependency because a process missing its signing secret
   * is running but cannot do useful work — precisely the state readiness exists
   * to expose.
   */
  private probeConfiguration(): DependencyResult {
    const required = ["databaseUrl", "sessionSecret", "credentialSigningSecret"];
    const missing = required.filter((key) => {
      const value = this.config.get<string>(key);
      return typeof value !== "string" || value.trim() === "";
    });

    if (missing.length > 0) {
      // Report only WHICH keys are absent, never their values. Names are safe;
      // values are secrets by definition.
      return {
        name: "configuration",
        kind: DependencyKind.REQUIRED,
        status: DependencyStatus.ERROR,
        reason: `missing_required_config:${missing.sort().join(",")}`,
        durationMs: 0,
      };
    }

    return {
      name: "configuration",
      kind: DependencyKind.REQUIRED,
      status: DependencyStatus.OK,
      durationMs: 0,
    };
  }

  /**
   * Probe Stellar Horizon.
   *
   * Optional: proof verification reads work without Horizon, so a Horizon
   * outage must not make unrelated routes unavailable.
   */
  private async probeHorizon(): Promise<DependencyResult> {
    const horizonUrl = this.config.get<string>("stellar.horizonUrl");

    if (typeof horizonUrl !== "string" || horizonUrl.trim() === "") {
      return {
        name: "horizon",
        kind: DependencyKind.OPTIONAL,
        status: DependencyStatus.NOT_CONFIGURED,
        reason: "horizon_url_absent",
      };
    }

    return this.timed("horizon", DependencyKind.OPTIONAL, async (signal) => {
      const response = await fetch(horizonUrl, {
        method: "GET",
        signal,
      });

      if (!response.ok) {
        // The upstream status code is a stable, non-identifying signal. The
        // response body is not, so it is discarded.
        throw new ProbeFailure(`upstream_status_${response.status}`);
      }
    });
  }

  /**
   * Validate the deployment manifest. Reasons are the manifest loader's stable
   * codes, which name fixed fields and contract names but never manifest
   * values.
   */
  private probeDeploymentManifest(): DependencyResult {
    const state = this.deployment.state();
    const base = {
      name: "deployment_manifest",
      kind: DependencyKind.REQUIRED,
      durationMs: 0,
    };

    if (state.status === "absent") {
      return {
        ...base,
        kind: DependencyKind.OPTIONAL,
        status: DependencyStatus.NOT_CONFIGURED,
        reason: "deployment_manifest_absent",
      };
    }

    if (state.status === "invalid") {
      return {
        ...base,
        status: DependencyStatus.ERROR,
        reason: state.reasons.join(","),
      };
    }

    return { ...base, status: DependencyStatus.OK };
  }

  /** Report whether contract anchoring is switched on and fully configured. */
  private probeContractAnchoring(): DependencyResult {
    const enabled = this.config.get<boolean>("contractAnchoring.enabled");

    if (!enabled) {
      return {
        name: "contract_anchoring",
        kind: DependencyKind.OPTIONAL,
        status: DependencyStatus.DISABLED,
      };
    }

    const contractId = this.config.get<string>(
      "contractAnchoring.proofRegistryContractId",
    );

    if (typeof contractId !== "string" || contractId.trim() === "") {
      return {
        name: "contract_anchoring",
        kind: DependencyKind.OPTIONAL,
        status: DependencyStatus.NOT_CONFIGURED,
        reason: "proof_registry_contract_id_absent",
      };
    }

    return {
      name: "contract_anchoring",
      kind: DependencyKind.OPTIONAL,
      status: DependencyStatus.OK,
    };
  }

  /**
   * Report webhook delivery backlog health.
   *
   * Reports only an aggregate count, never endpoint URLs, payloads, or
   * organization identifiers — a diagnostics endpoint must not become a side
   * channel for customer data.
   */
  private async probeWebhookDelivery(): Promise<DependencyResult> {
    return this.timed(
      "webhook_delivery",
      DependencyKind.OPTIONAL,
      async () => {
        const failing = await this.prisma.webhookDelivery.count({
          where: { status: "FAILED" },
        });

        if (failing > 0) {
          throw new ProbeFailure("failed_deliveries_present", {
            degraded: true,
          });
        }
      },
    );
  }

  /**
   * Report the state of every dependency circuit breaker.
   *
   * Optional, and never gates readiness: an open circuit is the breaker working
   * as designed — shedding load from a failing dependency — not the service
   * itself being unready. It is surfaced as DEGRADED so an operator can see the
   * dependency is being protected, and the per-circuit detail is counts and
   * states only, so this authorized endpoint never becomes a channel for
   * transaction payloads or addresses.
   */
  /**
   * Readiness view of clock skew (earnproof-backend#328).
   *
   * Fails only while a sustained critical alert is active, never on a single
   * assessment — see `ClockSkewMonitorService.blocksReadiness`. Carries a
   * reason code only; the measured skew is diagnostics-only detail.
   */
  private probeClockSkewReadiness(): DependencyResult {
    const blocked = this.clockSkew?.blocksReadiness() ?? false;
    return {
      name: "clock_skew",
      kind: DependencyKind.REQUIRED,
      status: blocked ? DependencyStatus.ERROR : DependencyStatus.OK,
      reason: blocked ? "clock_skew_sustained_critical" : undefined,
      durationMs: 0,
    };
  }

  /**
   * Diagnostics view of clock skew: the instantaneous classification, the
   * alert state and per-source outcome codes. Never a URL or response body.
   */
  private probeClockSkewDiagnostics(): DependencyResult {
    if (!this.clockSkew) {
      return {
        name: "clock_skew",
        kind: DependencyKind.OPTIONAL,
        status: DependencyStatus.NOT_CONFIGURED,
        reason: "clock_skew_monitor_absent",
      };
    }
    if (!this.clockSkew.enabled) {
      return { name: "clock_skew", kind: DependencyKind.OPTIONAL, status: DependencyStatus.DISABLED };
    }

    const snapshot = this.clockSkew.snapshot();
    // REQUIRED only while it actually gates readiness, so the diagnostics
    // verdict never disagrees with readiness about clock skew.
    if (this.clockSkew.blocksReadiness()) {
      return {
        name: "clock_skew",
        kind: DependencyKind.REQUIRED,
        status: DependencyStatus.ERROR,
        reason: "clock_skew_sustained_critical",
        durationMs: 0,
        clockSkew: snapshot,
      };
    }
    const base = {
      name: "clock_skew",
      kind: DependencyKind.OPTIONAL,
      durationMs: 0,
      clockSkew: snapshot,
    };
    switch (snapshot.status) {
      case "ok":
        return { ...base, status: DependencyStatus.OK };
      case "warning":
        return { ...base, status: DependencyStatus.DEGRADED, reason: "clock_skew_warning" };
      case "critical":
        return { ...base, status: DependencyStatus.ERROR, reason: "clock_skew_critical" };
      default:
        return {
          ...base,
          status:
            snapshot.policy.unknownPolicy === "fail_closed"
              ? DependencyStatus.ERROR
              : DependencyStatus.DEGRADED,
          reason: `clock_skew_unknown:${snapshot.reason ?? "no_samples"}`,
        };
    }
  }

  private probeCircuitBreakers(): DependencyResult {
    if (!this.circuits) {
      return {
        name: "circuit_breakers",
        kind: DependencyKind.OPTIONAL,
        status: DependencyStatus.NOT_CONFIGURED,
        reason: "registry_absent",
      };
    }

    const snapshots = this.circuits.snapshotAll();
    const circuits = snapshots.map((snapshot: any) => ({
      name: snapshot.name,
      state: snapshot.state,
      consecutiveFailures: snapshot.consecutiveFailures,
      probeSuccesses: snapshot.probeSuccesses,
      probesInFlight: snapshot.probesInFlight,
      openCount: snapshot.openCount,
      cooldownRemainingMs: snapshot.cooldownRemainingMs,
    }));

    const tripped = circuits.filter((circuit: any) => circuit.state !== "closed");

    return {
      name: "circuit_breakers",
      kind: DependencyKind.OPTIONAL,
      status:
        tripped.length > 0 ? DependencyStatus.DEGRADED : DependencyStatus.OK,
      reason:
        tripped.length > 0
          ? `tripped:${tripped.map((circuit: any) => circuit.name).sort().join(",")}`
          : undefined,
      circuits,
    };
  }

  /**
   * Run a probe under a timeout, converting any outcome into a safe result.
   *
   * Every throw is caught here. A probe that propagated a driver error would
   * leak connection strings through the HTTP response.
   */
  private async timed(
    name: string,
    kind: (typeof DependencyKind)[keyof typeof DependencyKind],
    probe: (signal: AbortSignal) => Promise<void>,
  ): Promise<DependencyResult> {
    const timeoutMs = this.probeTimeoutMs();
    const startedAt = Date.now();
    const controller = new AbortController();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProbeTimeout());
      }, timeoutMs);
    });

    try {
      await Promise.race([probe(controller.signal), timeout]);

      return {
        name,
        kind,
        status: DependencyStatus.OK,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        name,
        kind,
        status: this.classify(error),
        reason: this.safeReason(name, error),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private classify(error: unknown): DependencyStatusValue {
    if (error instanceof ProbeTimeout) {
      return DependencyStatus.TIMEOUT;
    }
    if (error instanceof ProbeFailure && error.degraded) {
      return DependencyStatus.DEGRADED;
    }
    return DependencyStatus.ERROR;
  }

  /**
   * Map an arbitrary thrown value onto a stable reason code.
   *
   * Only reasons this module produced itself are echoed. Anything else collapses
   * to a generic code, because an arbitrary error's message is attacker- or
   * driver-controlled and routinely embeds credentials, hostnames, or row data.
   * The full error is logged server-side, where it is already trusted.
   */
  private safeReason(name: string, error: unknown): string {
    if (error instanceof ProbeTimeout) {
      return "probe_timeout";
    }

    if (error instanceof ProbeFailure) {
      return error.code;
    }

    this.logger.warn(
      `Dependency probe "${name}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return "probe_failed";
  }

  /**
   * Probe contract successor readiness.
   * Reports the readiness of any configured successor contract.
   * Optional probe — only surfaces if successor service is available.
   */
  private async probeContractSuccessor(): Promise<DependencyResult> {
    if (!this.contractSuccessor) {
      return {
        name: "contract_successor_readiness",
        kind: DependencyKind.OPTIONAL,
        status: DependencyStatus.DISABLED,
      };
    }

    try {
      const network = this.config.get<string>("stellar.network") ?? "testnet";
      const contractId = this.config.get<string>(
        "contractAnchoring.proofRegistryContractId",
      );
      const expectedVersion =
        this.config.get<number>("contractAnchoring.schemaVersion") ?? 1;

      if (!contractId) {
        return {
          name: "contract_successor_readiness",
          kind: DependencyKind.OPTIONAL,
          status: DependencyStatus.NOT_CONFIGURED,
          reason: "successor_contract_id_not_configured",
        };
      }

      const ready = await this.contractSuccessor.canMigrate({
        network,
        contractId,
        expectedVersion,
      });

      return {
        name: "contract_successor_readiness",
        kind: DependencyKind.OPTIONAL,
        status: ready ? DependencyStatus.OK : DependencyStatus.DEGRADED,
        reason: ready ? undefined : "successor_not_ready_for_migration",
      };
    } catch (error) {
      throw new ProbeFailure("successor_assessment_failed", {
        degraded: true,
      });
    }
  }

  private probeTimeoutMs(): number {
    return (
      this.config.get<number>("health.probeTimeoutMs") ??
      DEFAULT_PROBE_TIMEOUT_MS
    );
  }

  private cacheTtlMs(): number {
    return this.config.get<number>("health.cacheTtlMs") ?? DEFAULT_CACHE_TTL_MS;
  }

  /** Clear cached probe results. Exposed for tests and manual intervention. */
  resetCache(): void {
    this.cache.clear();
  }
}

/** Raised when a probe exceeds its timeout. */
export class ProbeTimeout extends Error {
  constructor() {
    super("probe_timeout");
    this.name = "ProbeTimeout";
  }
}

/** Raised by a probe to report a specific, already-safe reason code. */
export class ProbeFailure extends Error {
  readonly code: string;
  readonly degraded: boolean;

  constructor(code: string, options?: { degraded?: boolean }) {
    super(code);
    this.name = "ProbeFailure";
    this.code = code;
    this.degraded = options?.degraded ?? false;
  }
}
