import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { promisify } from "util";
import { sha256 } from "../common/crypto/hash";
import { redact } from "../common/observability/redaction";
import { StructuredLogger } from "../common/logger";
import { CircuitBreakerRegistry } from "../common/resilience/circuit-breaker.registry";
import {
  CircuitBreaker,
  CircuitOpenError,
  CircuitState,
} from "../common/resilience/circuit-breaker";
import { classifyContractError } from "./contract-error";

const execFileAsync = promisify(execFile);

/** Prefix for per-network, per-operation contract circuit names. */
export const CONTRACT_CIRCUIT_PREFIX = "contract";

/** Contract operation classes tracked as distinct circuits. */
export type ContractOperationClass = "register" | "revoke" | "read";

export type AnchorProofInput = {
  proofId: string;
  commitment: string;
  expiresAt: Date;
};

export type AnchorProofResult =
  | {
      anchored: true;
      transactionHash: string;
    }
  | {
      anchored: false;
      /**
       * `circuit_open` means the dependency circuit refused the call before it
       * ran: the contract was never touched, the intent was not consumed, and
       * the worker should hold it for a later probe rather than count an
       * attempt against it.
       */
      reason: "disabled" | "failed" | "circuit_open";
      error?: string;
    };

export type ContractProofStatus =
  | {
      checked: true;
      revoked: boolean;
      valid: boolean;
    }
  | {
      checked: false;
      reason: "disabled" | "failed" | "circuit_open";
      error?: string;
    };

@Injectable()
export class ContractAnchoringService {
  private readonly logger = new StructuredLogger(ContractAnchoringService.name);
  private readonly enabled: boolean;
  private readonly required: boolean;
  private readonly stellarCliPath: string;
  private readonly source: string | undefined;
  private readonly network: string;
  private readonly proofRegistryContractId: string | undefined;
  private readonly issuerAddress: string | undefined;
  private readonly schemaVersion: number;
  private readonly registry?: CircuitBreakerRegistry;
  private readonly breakerOptions: {
    failureThreshold?: number;
    openDurationMs?: number;
    halfOpenMaxProbes?: number;
    successThreshold?: number;
  };

  constructor(
    private readonly configService: ConfigService,
    /**
     * Optional so the existing unit tests (which construct the service with a
     * config alone) keep working. When present, every contract invocation runs
     * under a per-network, per-operation circuit breaker (issue #203).
     */
    @Optional() registry?: CircuitBreakerRegistry,
  ) {
    this.enabled = configService.get<boolean>("contractAnchoring.enabled") ?? false;
    this.required = configService.get<boolean>("contractAnchoring.required") ?? false;
    this.stellarCliPath =
      configService.get<string>("contractAnchoring.stellarCliPath") ?? "stellar";
    this.source = configService.get<string>("contractAnchoring.source");
    this.network = configService.get<string>("stellar.network") ?? "testnet";
    this.proofRegistryContractId = configService.get<string>(
      "contractAnchoring.proofRegistryContractId",
    );
    this.issuerAddress = configService.get<string>(
      "contractAnchoring.issuerAddress",
    );
    this.schemaVersion =
      configService.get<number>("contractAnchoring.schemaVersion") ?? 1;
    this.registry = registry;
    this.breakerOptions = {
      failureThreshold: configService.get<number>(
        "contractAnchoring.circuitBreaker.failureThreshold",
      ),
      openDurationMs: configService.get<number>(
        "contractAnchoring.circuitBreaker.openDurationMs",
      ),
      halfOpenMaxProbes: configService.get<number>(
        "contractAnchoring.circuitBreaker.halfOpenMaxProbes",
      ),
      successThreshold: configService.get<number>(
        "contractAnchoring.circuitBreaker.successThreshold",
      ),
    };
  }

  /**
   * State of the circuit governing a contract operation on the current network,
   * or `closed` when no breaker is wired. Read by the anchoring worker to decide
   * how many intents it may claim — see its backpressure logic.
   */
  circuitState(operation: ContractOperationClass): CircuitState {
    return this.breakerFor(operation)?.snapshot().state ?? "closed";
  }

  /** The breaker for a given network operation, created on first use. */
  private breakerFor(
    operation: ContractOperationClass,
  ): CircuitBreaker | undefined {
    return this.registry?.getOrCreate({
      name: `${CONTRACT_CIRCUIT_PREFIX}:${this.network}:${operation}`,
      ...this.breakerOptions,
    });
  }

  /**
   * Runs a CLI invocation under the operation's circuit breaker.
   *
   * When the circuit is open the breaker throws {@link CircuitOpenError} before
   * `run` executes, so the contract is never touched — the backpressure the
   * worker relies on. A permanent contract error is classified as `ignore` by
   * {@link classifyContractError} so it never opens the circuit; a transient
   * RPC/CLI failure is a `trip`.
   */
  private guarded<T>(
    operation: ContractOperationClass,
    run: () => Promise<T>,
  ): Promise<T> {
    const breaker = this.breakerFor(operation);
    if (!breaker) return run();
    return breaker.execute(run, classifyContractError);
  }

  async anchorProof(input: AnchorProofInput): Promise<AnchorProofResult> {
    if (!this.enabled || !this.hasRequiredConfig()) {
      return {
        anchored: false,
        reason: "disabled",
      };
    }

    const args = [
      "contract",
      "invoke",
      "--source",
      this.source!,
      "--network",
      this.network,
      "--id",
      this.proofRegistryContractId!,
      "--",
      "register_proof",
      "--proof_id_hash",
      sha256(input.proofId),
      "--commitment_hash",
      this.hexFromSha256(input.commitment),
      "--issuer_address",
      this.issuerAddress!,
      "--schema_version",
      String(this.schemaVersion),
      "--expires_at",
      String(Math.floor(input.expiresAt.getTime() / 1000)),
    ];

    try {
      const { stdout } = await this.guarded("register", () =>
        execFileAsync(this.stellarCliPath, args, {
          windowsHide: true,
          timeout: 120_000,
        }),
      );
      return {
        anchored: true,
        transactionHash: this.lastOutputLine(stdout),
      };
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        return this.circuitOpenResult("Contract anchoring");
      }

      const message = safeCliError(error);
      if (this.required) {
        throw new Error(message);
      }

      this.logger.warn(`Contract anchoring failed: ${message}`);
      return {
        anchored: false,
        reason: "failed",
        error: message,
      };
    }
  }

  /**
   * Shared handling for an open-circuit refusal.
   *
   * In `required` mode the caller (synchronous proof issuance) cannot proceed
   * without a successful anchor, so an open circuit is surfaced as an error. In
   * the default asynchronous mode the worker holds the intent for a later probe,
   * so `circuit_open` is returned without consuming an attempt.
   */
  private circuitOpenResult(
    context: string,
  ): { anchored: false; reason: "circuit_open" } {
    if (this.required) {
      throw new Error(`${context} unavailable: dependency circuit is open`);
    }
    this.logger.warn(`${context} skipped: dependency circuit is open`);
    return { anchored: false, reason: "circuit_open" };
  }

  async revokeProof(proofId: string): Promise<AnchorProofResult> {
    if (!this.enabled || !this.hasRequiredConfig()) {
      return {
        anchored: false,
        reason: "disabled",
      };
    }

    return this.invokeMutation("revoke_proof", [
      "--proof_id_hash",
      sha256(proofId),
    ]);
  }

  async getProofStatus(proofId: string): Promise<ContractProofStatus> {
    if (!this.enabled || !this.hasRequiredConfig()) {
      return {
        checked: false,
        reason: "disabled",
      };
    }

    try {
      const [revoked, valid] = await Promise.all([
        this.invokeRead("is_revoked", ["--proof_id_hash", sha256(proofId)]),
        this.invokeRead("is_valid_proof", ["--proof_id_hash", sha256(proofId)]),
      ]);

      return {
        checked: true,
        revoked: this.parseBoolean(revoked),
        valid: this.parseBoolean(valid),
      };
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        if (this.required) {
          throw new Error("Contract status check unavailable: circuit is open");
        }
        this.logger.warn("Contract status check skipped: circuit is open");
        return { checked: false, reason: "circuit_open" };
      }

      const message = safeCliError(error);
      if (this.required) {
        throw new Error(message);
      }

      this.logger.warn(`Contract status check failed: ${message}`);
      return {
        checked: false,
        reason: "failed",
        error: message,
      };
    }
  }

  private async invokeMutation(functionName: string, functionArgs: string[]) {
    try {
      const { stdout } = await this.guarded("revoke", () =>
        execFileAsync(
          this.stellarCliPath,
          this.contractInvokeArgs(functionName, functionArgs, true),
          {
            windowsHide: true,
            timeout: 120_000,
          },
        ),
      );
      return {
        anchored: true as const,
        transactionHash: this.lastOutputLine(stdout),
      };
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        return this.circuitOpenResult("Contract mutation");
      }

      const message = safeCliError(error);
      if (this.required) {
        throw new Error(message);
      }

      this.logger.warn(`Contract mutation failed: ${message}`);
      return {
        anchored: false as const,
        reason: "failed" as const,
        error: message,
      };
    }
  }

  private async invokeRead(functionName: string, functionArgs: string[]) {
    const { stdout } = await this.guarded("read", () =>
      execFileAsync(
        this.stellarCliPath,
        this.contractInvokeArgs(functionName, functionArgs, false),
        {
          windowsHide: true,
          timeout: 60_000,
        },
      ),
    );
    return this.lastOutputLine(stdout);
  }

  private contractInvokeArgs(
    functionName: string,
    functionArgs: string[],
    includeSource: boolean,
  ) {
    const args = ["contract", "invoke"];
    if (includeSource) {
      args.push("--source", this.source!);
    }

    args.push(
      "--network",
      this.network,
      "--id",
      this.proofRegistryContractId!,
      "--",
      functionName,
      ...functionArgs,
    );

    return args;
  }

  private hasRequiredConfig() {
    return Boolean(
      this.source && this.proofRegistryContractId && this.issuerAddress,
    );
  }

  private hexFromSha256(value: string) {
    const normalized = value.startsWith("sha256:") ? value.slice(7) : value;
    if (!/^[a-fA-F0-9]{64}$/.test(normalized)) {
      return sha256(value);
    }

    return normalized.toLowerCase();
  }

  private lastOutputLine(stdout: string) {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.at(-1) ?? "";
  }

  private parseBoolean(value: string) {
    return value.trim().toLowerCase() === "true";
  }
}

/** Node includes execFile argv in failures, including the signing source. */
function safeCliError(error: unknown): string {
  return redact(error instanceof Error ? error.message : "Unknown error");
}
