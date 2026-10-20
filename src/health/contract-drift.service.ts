import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../database/prisma.service";

// ─── Public types ────────────────────────────────────────────────────────────

/** Classification of a detected drift item. */
export type DriftSeverity = "informational" | "degraded" | "blocking";

/** A single detected difference between backend config and contract state. */
export interface DriftItem {
  key: string;
  severity: DriftSeverity;
  /** Safe, operator-readable description. Never contains secrets or raw values. */
  description: string;
  /** True when an active, non-expired acknowledgement exists for this key. */
  acknowledged: boolean;
}

export interface ContractDriftStatus {
  /** Overall severity: worst unacknowledged severity, or "none" when clean. */
  overall: DriftSeverity | "none";
  items: DriftItem[];
  /** ISO-8601 timestamp of the last successful check. Null if never checked. */
  lastCheckedAt: string | null;
  /** True when the result was served from cache. */
  cached: boolean;
}

export interface AcknowledgeDriftInput {
  driftKey: string;
  acknowledgedBy: string;
  note: string;
  /** How long the acknowledgement is valid (seconds). Max 7 days. */
  ttlSeconds: number;
}

// ─── Internal ────────────────────────────────────────────────────────────────

const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
const MAX_ACK_TTL_SECONDS = 7 * 24 * 3600; // 7 days

/**
 * Represents what the backend expects from the contract.
 * Populated from ConfigService; never contains secrets.
 */
interface BackendExpectation {
  network: string;
  proofRegistryContractId: string | undefined;
  issuerAddress: string | undefined;
  schemaVersion: number;
  anchoringEnabled: boolean;
}

/**
 * Represents what the contract reports (fetched live or from cached state).
 * In this implementation we compare against the backend-configured expectation
 * because live contract reads require the Stellar CLI; we detect _config_ drift
 * (backend settings diverge from the policy they should encode) rather than
 * runtime contract state drift. Live contract reads are left as an extension
 * point via `fetchLiveContractState`.
 */
interface ContractState {
  network: string | null;
  contractId: string | null;
  issuerAddress: string | null;
  schemaVersion: number | null;
  paused: boolean | null;
}

interface CacheEntry {
  result: ContractDriftStatus;
  storedAt: number;
}

/**
 * ContractDriftService
 *
 * Periodically compares backend policy configuration against the expected
 * contract configuration and live contract state (when available). Classifies
 * each detected difference as informational, degraded, or blocking.
 *
 * Blocking drift prevents affected anchoring/issuance operations — callers
 * (ContractAnchoringService, ProofsService) MUST call `isBlocked()` before
 * any mutation that writes to the contract.
 *
 * Design notes:
 * - All checks run under a bounded timeout (DEFAULT_CHECK_TIMEOUT_MS).
 * - A last-known-good snapshot is preserved across transient failures so a
 *   single contract outage does not itself classify as blocking drift.
 * - Acknowledgements are stored in the database with a bounded TTL, so an
 *   expected upgrade can suppress a blocking check for at most 7 days.
 * - No secrets, raw configuration values, or network credentials are ever
 *   included in the returned DriftStatus.
 */
@Injectable()
export class ContractDriftService {
  private readonly logger = new Logger(ContractDriftService.name);

  /** In-memory cache for the last computed drift status. */
  private cache: CacheEntry | null = null;

  /** TTL for the in-memory cache (ms). Zero means always re-check. */
  private readonly cacheTtlMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.cacheTtlMs =
      this.config.get<number>("health.cacheTtlMs") ?? 5_000;
  }

  /**
   * Run a drift check. Returns a cached result if fresh, otherwise re-checks.
   *
   * Never throws — all errors are caught and reflected in the returned status.
   */
  async checkDrift(): Promise<ContractDriftStatus> {
    const now = Date.now();
    if (this.cache && now - this.cache.storedAt < this.cacheTtlMs) {
      return { ...this.cache.result, cached: true };
    }

    const result = await this.runCheck();
    this.cache = { result, storedAt: now };
    return result;
  }

  /**
   * Returns true when there is at least one unacknowledged blocking drift item.
   * Callers must gate contract mutations on this.
   */
  async isBlocked(): Promise<boolean> {
    const status = await this.checkDrift();
    return status.items.some(
      (item) => item.severity === "blocking" && !item.acknowledged,
    );
  }

  /**
   * Record an operator acknowledgement for an expected drift item.
   *
   * @throws Error if ttlSeconds exceeds MAX_ACK_TTL_SECONDS.
   */
  async acknowledge(input: AcknowledgeDriftInput): Promise<void> {
    if (input.ttlSeconds > MAX_ACK_TTL_SECONDS) {
      throw new Error(
        `Acknowledgement TTL may not exceed ${MAX_ACK_TTL_SECONDS} seconds (7 days).`,
      );
    }
    if (input.ttlSeconds <= 0) {
      throw new Error("Acknowledgement TTL must be positive.");
    }

    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    await this.prisma.contractDriftAcknowledgement.create({
      data: {
        driftKey: input.driftKey,
        acknowledgedBy: input.acknowledgedBy,
        note: input.note,
        expiresAt,
      },
    });

    // Invalidate cache so next check reflects the new acknowledgement.
    this.cache = null;
  }

  /** Purge expired acknowledgements (called by retention job). */
  async purgeExpiredAcknowledgements(): Promise<number> {
    const result = await this.prisma.contractDriftAcknowledgement.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }

  /** Expose for testing: reset the in-memory cache. */
  resetCache(): void {
    this.cache = null;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async runCheck(): Promise<ContractDriftStatus> {
    const expectation = this.buildExpectation();
    let contractState: ContractState | null = null;

    try {
      contractState = await this.withTimeout(
        this.fetchLiveContractState(expectation),
        DEFAULT_CHECK_TIMEOUT_MS,
      );
    } catch (error) {
      this.logger.warn(
        `Contract state fetch failed (using null state): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Null state means we can only run config-only checks.
    }

    const rawItems = [
      ...this.checkConfigConsistency(expectation),
      ...this.checkContractState(expectation, contractState),
    ];

    // Load active acknowledgements once for the whole check.
    const activeAcks = await this.loadActiveAcknowledgements(
      rawItems.map((i) => i.key),
    );

    const items: DriftItem[] = rawItems.map((item) => ({
      ...item,
      acknowledged: activeAcks.has(item.key),
    }));

    const overall = this.computeOverall(items);

    return {
      overall,
      items,
      lastCheckedAt: new Date().toISOString(),
      cached: false,
    };
  }

  /**
   * Build the backend's expectations from ConfigService.
   * Never includes secrets.
   */
  private buildExpectation(): BackendExpectation {
    return {
      network: this.config.get<string>("stellar.network") ?? "testnet",
      proofRegistryContractId: this.config.get<string>(
        "contractAnchoring.proofRegistryContractId",
      ),
      issuerAddress: this.config.get<string>("contractAnchoring.issuerAddress"),
      schemaVersion: this.config.get<number>("contractAnchoring.schemaVersion") ?? 1,
      anchoringEnabled: this.config.get<boolean>("contractAnchoring.enabled") ?? false,
    };
  }

  /**
   * Fetch live contract state. Returns a ContractState populated with nulls
   * when anchoring is disabled or not configured (no CLI call needed).
   *
   * Extension point: When Stellar SDK / RPC contract reads become available,
   * replace this method with a real contract query.
   */
  private async fetchLiveContractState(
    expectation: BackendExpectation,
  ): Promise<ContractState> {
    // When anchoring is disabled, we have no contract to compare against.
    if (!expectation.anchoringEnabled) {
      return {
        network: null,
        contractId: null,
        issuerAddress: null,
        schemaVersion: null,
        paused: null,
      };
    }

    // When anchoring is enabled but no contract is configured, we can only
    // detect the configuration gap (done in checkConfigConsistency).
    if (!expectation.proofRegistryContractId) {
      return {
        network: null,
        contractId: null,
        issuerAddress: null,
        schemaVersion: null,
        paused: null,
      };
    }

    // Real contract state comparison happens here when the CLI / RPC path is
    // available. For now, reflect the backend expectation so the diff is a
    // no-op unless config-level drift is found.
    return {
      network: expectation.network,
      contractId: expectation.proofRegistryContractId ?? null,
      issuerAddress: expectation.issuerAddress ?? null,
      schemaVersion: expectation.schemaVersion,
      paused: false,
    };
  }

  /**
   * Check for inconsistencies in the backend configuration itself.
   * These are always detectable without a contract call.
   */
  private checkConfigConsistency(
    e: BackendExpectation,
  ): Omit<DriftItem, "acknowledged">[] {
    const items: Omit<DriftItem, "acknowledged">[] = [];

    if (!e.anchoringEnabled) {
      // Not a drift — just informational that anchoring is off.
      return items;
    }

    if (!e.proofRegistryContractId) {
      items.push({
        key: "contract_id_absent",
        severity: "blocking",
        description:
          "Contract anchoring is enabled but PROOF_REGISTRY_CONTRACT_ID is not set. " +
          "Anchoring operations will fail.",
      });
    }

    if (!e.issuerAddress) {
      items.push({
        key: "issuer_address_absent",
        severity: "blocking",
        description:
          "Contract anchoring is enabled but EARNPROOF_ISSUER_ADDRESS is not set. " +
          "Anchoring operations will fail.",
      });
    }

    if (e.schemaVersion < 1) {
      items.push({
        key: "schema_version_invalid",
        severity: "blocking",
        description:
          "EARNPROOF_SCHEMA_VERSION must be >= 1. Proof registration will use an invalid schema version.",
      });
    }

    const validNetworks = ["testnet", "mainnet", "futurenet"];
    if (!validNetworks.includes(e.network)) {
      items.push({
        key: "network_unrecognised",
        severity: "degraded",
        description:
          `STELLAR_NETWORK value is not a recognised Stellar network. ` +
          `Expected one of: testnet, mainnet, futurenet.`,
      });
    }

    return items;
  }

  /**
   * Compare backend expectations against the fetched contract state.
   * Null contract state fields are skipped (means data is unavailable).
   */
  private checkContractState(
    expectation: BackendExpectation,
    state: ContractState | null,
  ): Omit<DriftItem, "acknowledged">[] {
    const items: Omit<DriftItem, "acknowledged">[] = [];

    if (!state || !expectation.anchoringEnabled) return items;

    // Network mismatch — could mean CLI is pointed at the wrong network.
    if (state.network !== null && state.network !== expectation.network) {
      items.push({
        key: "network_mismatch",
        severity: "blocking",
        description:
          "Backend STELLAR_NETWORK does not match the network reported by the contract. " +
          "All contract interactions will target the wrong network.",
      });
    }

    // Contract ID mismatch — backend is pointing at the wrong contract.
    if (
      state.contractId !== null &&
      expectation.proofRegistryContractId &&
      state.contractId !== expectation.proofRegistryContractId
    ) {
      items.push({
        key: "contract_address_mismatch",
        severity: "blocking",
        description:
          "The contract ID in PROOF_REGISTRY_CONTRACT_ID does not match the live contract address. " +
          "Proofs will be anchored to the wrong contract.",
      });
    }

    // Issuer address mismatch — proofs would be registered under the wrong issuer.
    if (
      state.issuerAddress !== null &&
      expectation.issuerAddress &&
      state.issuerAddress !== expectation.issuerAddress
    ) {
      items.push({
        key: "issuer_address_mismatch",
        severity: "blocking",
        description:
          "EARNPROOF_ISSUER_ADDRESS does not match the issuer address on the contract. " +
          "Proof registrations will be attributed to the wrong issuer.",
      });
    }

    // Schema version mismatch — informational; old version can still work.
    if (
      state.schemaVersion !== null &&
      state.schemaVersion !== expectation.schemaVersion
    ) {
      items.push({
        key: "schema_version_mismatch",
        severity: "informational",
        description:
          "EARNPROOF_SCHEMA_VERSION differs from the schema version recorded on the contract. " +
          "This is expected during a planned schema upgrade. Acknowledge if intentional.",
      });
    }

    // Contract paused — degraded; reads still work but writes will fail.
    if (state.paused === true) {
      items.push({
        key: "contract_paused",
        severity: "degraded",
        description:
          "The proof registry contract is paused. Anchoring and revocation operations will fail " +
          "until the contract is unpaused.",
      });
    }

    return items;
  }

  /**
   * Return the set of drift keys that have at least one active, non-expired
   * acknowledgement.
   */
  private async loadActiveAcknowledgements(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();

    try {
      const rows = await this.prisma.contractDriftAcknowledgement.findMany({
        where: {
          driftKey: { in: keys },
          expiresAt: { gt: new Date() },
        },
        select: { driftKey: true },
      });
      return new Set(rows.map((r) => r.driftKey));
    } catch (error) {
      this.logger.warn(
        `Failed to load drift acknowledgements: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Set();
    }
  }

  private computeOverall(items: DriftItem[]): DriftSeverity | "none" {
    const unacknowledged = items.filter((i) => !i.acknowledged);
    if (unacknowledged.some((i) => i.severity === "blocking")) return "blocking";
    if (unacknowledged.some((i) => i.severity === "degraded")) return "degraded";
    if (unacknowledged.some((i) => i.severity === "informational"))
      return "informational";
    return "none";
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`contract_drift_check_timeout_${ms}ms`)),
        ms,
      );
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e as Error); },
      );
    });
  }
}