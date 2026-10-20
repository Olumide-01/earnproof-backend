import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ResourceStatus } from "@prisma/client";
import { execFile } from "child_process";
import { promisify } from "util";
import { sha256 } from "../common/crypto/hash";
import { redact } from "../common/observability/redaction";

const execFileAsync = promisify(execFile);

export type IssuerRegistrySyncInput = {
  issuerId: string;
  stellarAddress: string;
  metadataHash: string;
  status: ResourceStatus;
  contractSyncedStatus: ResourceStatus | null;
};

export type IssuerRegistrySyncResult =
  | { state: "synced"; transactionHash: string; operation: string }
  | { state: "pending"; reason: string }
  | { state: "disabled"; reason: string }
  | { state: "failed"; reason: string; error: string };

/** The issuer address the contract currently holds for an issuer. */
export type IssuerRegistryAddressRead =
  | { state: "found"; issuerAddress: string }
  | { state: "disabled"; reason: string }
  | { state: "failed"; error: string };

export type IssuerRegistryRotationResult =
  | { state: "submitted"; transactionHash: string }
  | { state: "disabled"; reason: string }
  | { state: "failed"; error: string };

/** A Stellar account (G...) or contract (C...) address in StrKey form. */
const STRKEY_ADDRESS = /\b([GC][A-Z2-7]{55})\b/;

@Injectable()
export class IssuerRegistryService {
  private readonly logger = new Logger(IssuerRegistryService.name);
  private readonly enabled: boolean;
  private readonly stellarCliPath: string;
  private readonly source?: string;
  private readonly network: string;
  private readonly contractId?: string;

  /** True when the registry is enabled and every setting it needs is present. */
  get isConfigured(): boolean {
    return Boolean(this.enabled && this.source && this.contractId);
  }

  /**
   * Reads the address the contract holds for `issuerId`.
   *
   * A read-only simulation: no source account signs it and nothing is
   * submitted, so it is safe to repeat as often as reconciliation needs.
   */
  async readIssuerAddress(issuerId: string): Promise<IssuerRegistryAddressRead> {
    if (!this.isConfigured) {
      return { state: "disabled", reason: "Issuer registry synchronization is not configured" };
    }

    try {
      const stdout = await this.execute(
        [
          "contract",
          "invoke",
          "--network",
          this.network,
          "--id",
          this.contractId!,
          "--",
          "get_issuer",
          "--issuer_id_hash",
          sha256(issuerId),
        ],
        60_000,
      );
      const issuerAddress = parseIssuerAddress(stdout);
      if (!issuerAddress) {
        return { state: "failed", error: "Issuer registry returned no issuer address" };
      }
      return { state: "found", issuerAddress };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "Unknown error");
      this.logger.warn(`Issuer registry read failed: ${message}`);
      return { state: "failed", error: message };
    }
  }

  /**
   * Submits `rotate_issuer_address`. The contract itself rejects a revoked
   * issuer, an unchanged address and an address already registered to any
   * issuer.
   */
  async rotateIssuerAddress(
    issuerId: string,
    newAddress: string,
  ): Promise<IssuerRegistryRotationResult> {
    if (!this.isConfigured) {
      return { state: "disabled", reason: "Issuer registry synchronization is not configured" };
    }

    try {
      const stdout = await this.execute(
        [
          "contract",
          "invoke",
          "--source",
          this.source!,
          "--network",
          this.network,
          "--id",
          this.contractId!,
          "--",
          "rotate_issuer_address",
          "--issuer_id_hash",
          sha256(issuerId),
          "--new_address",
          newAddress,
        ],
        120_000,
      );
      const transactionHash = lastLine(stdout);
      if (!transactionHash) {
        return { state: "failed", error: "Issuer registry returned no transaction evidence" };
      }
      return { state: "submitted", transactionHash };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : "Unknown error");
      this.logger.warn(`Issuer address rotation submission failed: ${message}`);
      return { state: "failed", error: message };
    }
  }

  /** Runs the Stellar CLI. Separate so tests can substitute the process. */
  protected async execute(args: string[], timeout: number): Promise<string> {
    const { stdout } = await execFileAsync(this.stellarCliPath, args, {
      windowsHide: true,
      timeout,
    });
    return stdout;
  }

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>("issuerRegistry.enabled") ?? false;
    this.stellarCliPath =
      config.get<string>("issuerRegistry.stellarCliPath") ?? "stellar";
    this.source = config.get<string>("issuerRegistry.source");
    this.network = config.get<string>("stellar.network") ?? "testnet";
    this.contractId = config.get<string>("issuerRegistry.contractId");
  }

  async sync(
    input: IssuerRegistrySyncInput,
  ): Promise<IssuerRegistrySyncResult> {
    if (input.status === ResourceStatus.PENDING) {
      return {
        state: "pending",
        reason: "Issuer must be ACTIVE before contract registration",
      };
    }

    if (!this.enabled || !this.source || !this.contractId) {
      return {
        state: "disabled",
        reason: "Issuer registry synchronization is not configured",
      };
    }

    const issuerIdHash = sha256(input.issuerId);
    let operation: string;
    let args: string[];

    if (!input.contractSyncedStatus) {
      if (input.status !== ResourceStatus.ACTIVE) {
        return {
          state: "pending",
          reason:
            "Issuer must be registered while ACTIVE before status synchronization",
        };
      }
      operation = "register_issuer";
      args = [
        "--issuer_id_hash",
        issuerIdHash,
        "--issuer_address",
        input.stellarAddress,
        "--metadata_hash",
        input.metadataHash,
      ];
    } else if (
      input.status === ResourceStatus.ACTIVE &&
      input.contractSyncedStatus === ResourceStatus.SUSPENDED
    ) {
      operation = "reactivate_issuer";
      args = ["--issuer_id_hash", issuerIdHash];
    } else if (input.status === ResourceStatus.ACTIVE) {
      operation = "update_issuer";
      args = [
        "--issuer_id_hash",
        issuerIdHash,
        "--metadata_hash",
        input.metadataHash,
      ];
    } else if (input.status === ResourceStatus.SUSPENDED) {
      operation = "suspend_issuer";
      args = ["--issuer_id_hash", issuerIdHash];
    } else if (input.status === ResourceStatus.REVOKED) {
      operation = "revoke_issuer";
      args = ["--issuer_id_hash", issuerIdHash];
    } else {
      return {
        state: "pending",
        reason: `Status ${input.status} is not syncable`,
      };
    }

    try {
      const { stdout } = await execFileAsync(
        this.stellarCliPath,
        [
          "contract",
          "invoke",
          "--source",
          this.source,
          "--network",
          this.network,
          "--id",
          this.contractId,
          "--",
          operation,
          ...args,
        ],
        { windowsHide: true, timeout: 120_000 },
      );
      const transactionHash = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);

      if (!transactionHash) {
        throw new Error("Issuer registry returned no transaction evidence");
      }
      return { state: "synced", transactionHash, operation };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(`Issuer registry sync failed: ${message}`);
      return { state: "failed", reason: "failed", error: message };
    }
  }
}

function lastLine(stdout: string): string | undefined {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

/**
 * Extracts `issuer_address` from `get_issuer` output. The CLI prints the
 * record as JSON; the pattern fallback tolerates a CLI version that wraps it.
 */
export function parseIssuerAddress(stdout: string): string | undefined {
  const line = lastLine(stdout);
  if (!line) return undefined;
  try {
    const record = JSON.parse(line) as { issuer_address?: unknown };
    if (typeof record.issuer_address === "string" && STRKEY_ADDRESS.test(record.issuer_address)) {
      return record.issuer_address;
    }
  } catch {
    // Not JSON; fall through to the pattern.
  }
  const match = /"?issuer_address"?\s*:\s*"?([GC][A-Z2-7]{55})/.exec(stdout);
  return match?.[1];
}
