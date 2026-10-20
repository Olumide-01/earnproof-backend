import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StructuredLogger } from "../common/logger";
import { HorizonFault, classifyHorizonFault } from "../stellar/horizon-fault";

/**
 * Contract state checkpoint digest fetched from live contract.
 * Versioned to support multiple digest schema formats.
 */
export interface ContractStateDigest {
  network: string;
  contractId: string;
  checkpointNumber: string; // BigInt as string to preserve precision
  digestVersion: string; // e.g., "1.0", "2.0"
  components: Record<string, string>; // e.g., { "issuerCount": "5", "registrationHash": "sha256:..." }
  timestamp: Date;
}

/**
 * Verification failure details.
 */
export interface DigestVerificationFailure {
  code:
    | "UNKNOWN_VERSION"
    | "NETWORK_MISMATCH"
    | "CONTRACT_MISMATCH"
    | "FETCH_TIMEOUT"
    | "RPC_TRANSIENT_ERROR"
    | "RPC_PERMANENT_ERROR"
    | "PARSE_ERROR"
    | "STALE_CONTRACT_STATE";
  message: string; // Redacted, no sensitive data
}

/**
 * Result of attempting to fetch and verify a digest.
 */
export type DigestFetchResult =
  | { ok: true; digest: ContractStateDigest }
  | { ok: false; failure: DigestVerificationFailure };

/**
 * ContractDigestClient
 *
 * Fetches contract state checkpoint digests with fail-closed verification.
 * All verification failures (unknown versions, network/contract mismatches, staleness)
 * are detected BEFORE comparison; no digest is trusted until verified.
 *
 * Uses the same fault classification as StellarService for RPC resilience.
 */
@Injectable()
export class ContractDigestClient {
  private readonly logger = new StructuredLogger(ContractDigestClient.name);

  // Known digest versions supported by this backend
  private readonly supportedDigestVersions = ["1.0"];

  // Timeout for fetching digest (5 seconds, same as Horizon)
  private readonly fetchTimeoutMs = 5000;

  // Max staleness threshold: digests older than 1 hour are not trusted
  private readonly maxStalenessDurationMs = 60 * 60 * 1000; // 1 hour

  constructor(private readonly configService: ConfigService) {}

  /**
   * Fetch and verify a checkpoint digest from the contract.
   *
   * Fail-closed verification:
   * 1. Fetch the digest via contract RPC
   * 2. Parse response
   * 3. Validate digest version (must be known)
   * 4. Validate network (must match expected)
   * 5. Validate contract ID (must match expected)
   * 6. Validate staleness (must be < 1 hour old)
   *
   * If any check fails, return a verification failure and do NOT proceed to comparison.
   *
   * @param network - Expected network (e.g., "testnet")
   * @param contractId - Expected contract ID
   * @param checkpointNumber - Checkpoint to fetch
   * @param allowStale - If true, skip staleness check (admin override)
   * @returns DigestFetchResult with digest or verification failure
   */
  async fetchAndVerify(
    network: string,
    contractId: string,
    checkpointNumber: string,
    allowStale: boolean = false,
  ): Promise<DigestFetchResult> {
    try {
      // Step 1: Fetch the digest from contract RPC
      const digest = await this.fetchDigestFromContract(
        network,
        contractId,
        checkpointNumber,
      );

      // Step 2: Validate version
      if (!this.supportedDigestVersions.includes(digest.digestVersion)) {
        return {
          ok: false,
          failure: {
            code: "UNKNOWN_VERSION",
            message: `Digest version '${digest.digestVersion}' is not supported by this backend. Supported versions: ${this.supportedDigestVersions.join(", ")}.`,
          },
        };
      }

      // Step 3: Validate network
      if (digest.network !== network) {
        return {
          ok: false,
          failure: {
            code: "NETWORK_MISMATCH",
            message: `Digest network '${digest.network}' does not match expected '${network}'.`,
          },
        };
      }

      // Step 4: Validate contract ID
      if (digest.contractId !== contractId) {
        return {
          ok: false,
          failure: {
            code: "CONTRACT_MISMATCH",
            message: `Digest contract ID does not match expected contract ID.`,
          },
        };
      }

      // Step 5: Validate staleness (unless overridden)
      if (!allowStale) {
        const now = new Date();
        const age = now.getTime() - digest.timestamp.getTime();
        if (age > this.maxStalenessDurationMs) {
          return {
            ok: false,
            failure: {
              code: "STALE_CONTRACT_STATE",
              message: `Digest is stale (${Math.round(age / 1000)}s old, max ${Math.round(this.maxStalenessDurationMs / 1000)}s).`,
            },
          };
        }
      }

      // All checks passed
      return { ok: true, digest };
    } catch (error) {
      // Catch any unexpected errors during verification
      this.logger.error("Unexpected error during digest fetch/verify", error as Error, {
        network,
        contractId,
        checkpointNumber,
      });
      return {
        ok: false,
        failure: {
          code: "PARSE_ERROR",
          message: "Unexpected error while verifying digest.",
        },
      };
    }
  }

  /**
   * Fetch the digest from the contract RPC.
   * Implements retry logic for transient errors.
   * Throws on permanent errors or timeouts.
   *
   * @private
   */
  private async fetchDigestFromContract(
    network: string,
    contractId: string,
    checkpointNumber: string,
  ): Promise<ContractStateDigest> {
    const maxRetries = 3;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Call contract RPC method (mock for now; production would use Soroban client)
        const response = await this.callContractRpc(
          network,
          contractId,
          "get_checkpoint_digest",
          [checkpointNumber],
        );

        // Parse response
        const digest = this.parseDigestResponse(response);
        return digest;
      } catch (error) {
        lastError = error;

        // Classify error as transient or permanent
        const fault = this.classifyFetchError(error);
        if (fault === "PERMANENT") {
          throw error; // Don't retry permanent errors
        }

        // Transient error: retry with backoff
        if (attempt < maxRetries - 1) {
          const backoffMs = Math.min(200 * Math.pow(2, attempt), 5000);
          await this.sleep(backoffMs);
        }
      }
    }

    // All retries exhausted
    throw new Error(
      `Failed to fetch digest after ${maxRetries} attempts: ${String(lastError)}`,
    );
  }

  /**
   * Call the contract RPC method.
   * @private
   */
  private async callContractRpc(
    network: string,
    contractId: string,
    method: string,
    params: string[],
  ): Promise<unknown> {
    // TODO: In production, integrate with Soroban client
    // For now, this is a placeholder that would be implemented
    // with actual Soroban contract calls

    // Mock implementation for testing
    throw new Error("callContractRpc not yet implemented; use mocks in tests");
  }

  /**
   * Parse the digest response from contract RPC.
   * @private
   */
  private parseDigestResponse(response: unknown): ContractStateDigest {
    if (typeof response !== "object" || response === null) {
      throw new Error("Response is not an object");
    }

    const obj = response as Record<string, unknown>;

    // Validate required fields
    const requiredFields = [
      "network",
      "contractId",
      "checkpointNumber",
      "digestVersion",
      "components",
      "timestamp",
    ];
    for (const field of requiredFields) {
      if (!(field in obj)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Type-check fields
    if (typeof obj.network !== "string") {
      throw new Error("network must be a string");
    }
    if (typeof obj.contractId !== "string") {
      throw new Error("contractId must be a string");
    }
    if (typeof obj.checkpointNumber !== "string") {
      throw new Error("checkpointNumber must be a string");
    }
    if (typeof obj.digestVersion !== "string") {
      throw new Error("digestVersion must be a string");
    }
    if (typeof obj.components !== "object" || obj.components === null) {
      throw new Error("components must be an object");
    }
    if (typeof obj.timestamp !== "string") {
      throw new Error("timestamp must be an ISO-8601 string");
    }

    // Parse timestamp
    const timestamp = new Date(obj.timestamp as string);
    if (isNaN(timestamp.getTime())) {
      throw new Error("timestamp is not a valid ISO-8601 date");
    }

    return {
      network: obj.network as string,
      contractId: obj.contractId as string,
      checkpointNumber: obj.checkpointNumber as string,
      digestVersion: obj.digestVersion as string,
      components: obj.components as Record<string, string>,
      timestamp,
    };
  }

  /**
   * Classify fetch errors as transient or permanent.
   * Mirrors the fault classification from HorizonFault.
   * @private
   */
  private classifyFetchError(error: unknown): "TRANSIENT" | "PERMANENT" {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      // Timeout errors are transient
      if (message.includes("timeout") || message.includes("timed out")) {
        return "TRANSIENT";
      }

      // Network errors are transient
      if (
        message.includes("econnrefused") ||
        message.includes("enotfound") ||
        message.includes("network")
      ) {
        return "TRANSIENT";
      }

      // Rate limit errors are transient
      if (message.includes("429") || message.includes("rate limit")) {
        return "TRANSIENT";
      }

      // Server errors (5xx) are transient
      if (message.includes("500") || message.includes("503")) {
        return "TRANSIENT";
      }

      // Malformed request, client errors (4xx) are permanent
      if (message.includes("400") || message.includes("404")) {
        return "PERMANENT";
      }

      // Parse errors are permanent
      if (message.includes("parse") || message.includes("json")) {
        return "PERMANENT";
      }
    }

    // Default to permanent to be safe
    return "PERMANENT";
  }

  /**
   * Sleep for specified duration.
   * @private
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
