import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { v4 as uuidv4 } from "uuid";
import { StructuredLogger } from "../common/logger";
import { PrismaService } from "../database/prisma.service";
import { ContractDigestClient } from "./contract-digest-client";
import { BackendStateDigestCalculator } from "./backend-state-digest-calculator";

/**
 * ContractStateReconciliationService
 *
 * Scheduled job that compares backend projections against live contract digests.
 * Runs every hour (configurable) to detect drift between backend and contract state.
 *
 * Pipeline:
 * 1. Fetch checkpoint digest from contract (with retries for transient errors)
 * 2. Verify digest (version, network, contract ID, staleness)
 * 3. If verification passes, compute backend projection digest
 * 4. Compare component-by-component
 * 5. Persist mismatches and verification failures with idempotency per runId
 *
 * Idempotency: Same (network, contractId, checkpointNumber, digestVersion, componentName, runId)
 * can only be stored once via unique constraint. Re-runs use new runId.
 */
@Injectable()
export class ContractStateReconciliationService {
  private readonly logger = new StructuredLogger(
    ContractStateReconciliationService.name,
  );

  private readonly enabled: boolean;
  private readonly network: string;
  private readonly contractId: string;
  private readonly stalestateThresholdMs: number; // Default 1 hour

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly digestClient: ContractDigestClient,
    private readonly digestCalculator: BackendStateDigestCalculator,
  ) {
    this.enabled =
      configService.get<boolean>(
        "contractReconciliation.enabled",
      ) ?? false;
    this.network = configService.get<string>("stellar.network") ?? "testnet";
    this.contractId =
      configService.get<string>("contractReconciliation.contractId") ?? "";
    this.stalestateThresholdMs =
      configService.get<number>(
        "contractReconciliation.staleThresholdMs",
      ) ?? 60 * 60 * 1000; // 1 hour
  }

  /**
   * Scheduled comparison job.
   * Runs every hour by default.
   */
  @Interval(60 * 60 * 1000) // Every 1 hour
  async reconcile(): Promise<void> {
    if (!this.enabled || !this.contractId) {
      this.logger.debug("Reconciliation disabled or unconfigured", {
        enabled: this.enabled,
        hasContractId: !!this.contractId,
      });
      return;
    }

    try {
      // For now, use a fixed checkpoint (e.g., the "current" one from contract)
      // In production, this could query the contract for the latest checkpoint
      const checkpointNumber = await this.getLatestCheckpoint();
      if (!checkpointNumber) {
        this.logger.warn("No checkpoint available for comparison");
        return;
      }

      await this.compareCheckpoint(
        this.network,
        this.contractId,
        checkpointNumber,
        false, // allowStale: false by default
      );
    } catch (error) {
      this.logger.error(
        "Error during scheduled reconciliation",
        error as Error,
        {
          network: this.network,
          contractId: this.contractId,
        },
      );
    }
  }

  /**
   * On-demand comparison of a specific checkpoint.
   *
   * @param network - Network identifier
   * @param contractId - Contract ID
   * @param checkpointNumber - Checkpoint to compare
   * @param allowStale - If true, skip staleness check (admin override)
   * @returns Comparison results (verification status, mismatch count, etc.)
   */
  async compareCheckpoint(
    network: string,
    contractId: string,
    checkpointNumber: string,
    allowStale: boolean = false,
  ): Promise<{
    runId: string;
    verificationStatus: "PASSED" | "FAILED";
    comparisonStatus?: "MATCH" | "MISMATCH";
    mismatchCount?: number;
    verificationFailures?: Array<{
      code: string;
      message: string;
    }>;
  }> {
    const runId = uuidv4();
    const detectedAt = new Date();

    this.logger.debug("Starting checkpoint comparison", {
      runId,
      network,
      contractId,
      checkpointNumber,
      allowStale,
    });

    try {
      // Step 1: Fetch and verify digest
      const digestResult = await this.digestClient.fetchAndVerify(
        network,
        contractId,
        checkpointNumber,
        allowStale,
      );

      if (!digestResult.ok) {
        // Verification failed: persist failure and return
        await this.persistVerificationFailure(
          network,
          contractId,
          digestResult.failure.code,
          digestResult.failure.message,
          runId,
          detectedAt,
        );

        await this.persistReconciliationRun(
          network,
          contractId,
          checkpointNumber,
          undefined,
          runId,
          "FAILED",
          undefined,
          undefined,
          detectedAt,
        );

        this.logger.info("Verification failed", {
          runId,
          code: digestResult.failure.code,
          network,
          contractId,
        });

        return {
          runId,
          verificationStatus: "FAILED",
          verificationFailures: [digestResult.failure],
        };
      }

      const liveDigest = digestResult.digest;

      // Step 2: Compute backend projection digest
      const backendDigest = await this.digestCalculator.computeDigest(
        network,
        checkpointNumber,
      );

      // Step 3: Compare component-by-component
      const mismatches = this.compareDigests(
        network,
        contractId,
        checkpointNumber,
        backendDigest.digestVersion,
        backendDigest.components,
        liveDigest.components,
      );

      // Step 4: Persist mismatches
      await this.persistMismatches(
        network,
        contractId,
        checkpointNumber,
        backendDigest.digestVersion,
        mismatches,
        runId,
        detectedAt,
      );

      const comparisonStatus = mismatches.length === 0 ? "MATCH" : "MISMATCH";

      // Step 5: Persist reconciliation run record
      await this.persistReconciliationRun(
        network,
        contractId,
        checkpointNumber,
        backendDigest.digestVersion,
        runId,
        "PASSED",
        comparisonStatus,
        mismatches.length,
        detectedAt,
      );

      this.logger.info("Checkpoint comparison complete", {
        runId,
        network,
        contractId,
        checkpointNumber,
        comparisonStatus,
        mismatchCount: mismatches.length,
      });

      return {
        runId,
        verificationStatus: "PASSED",
        comparisonStatus,
        mismatchCount: mismatches.length,
      };
    } catch (error) {
      this.logger.error("Unexpected error during checkpoint comparison", error as Error, {
        runId,
        network,
        contractId,
        checkpointNumber,
      });

      throw error;
    }
  }

  /**
   * Compare backend and live digests component-by-component.
   * @private
   */
  private compareDigests(
    network: string,
    contractId: string,
    checkpointNumber: string,
    digestVersion: string,
    backendComponents: Record<string, string>,
    liveComponents: Record<string, string>,
  ): Array<{
    componentName: string;
    expectedValue: string;
    observedValue: string;
  }> {
    const mismatches: Array<{
      componentName: string;
      expectedValue: string;
      observedValue: string;
    }> = [];

    // Check all backend components
    for (const [componentName, expectedValue] of Object.entries(
      backendComponents,
    )) {
      const observedValue = liveComponents[componentName];
      if (observedValue === undefined) {
        // Component missing in live digest
        mismatches.push({
          componentName,
          expectedValue,
          observedValue: "(missing)",
        });
      } else if (observedValue !== expectedValue) {
        // Component value differs
        mismatches.push({
          componentName,
          expectedValue,
          observedValue,
        });
      }
    }

    // Check for extra components in live digest (should not happen, but log if found)
    for (const componentName of Object.keys(liveComponents)) {
      if (!(componentName in backendComponents)) {
        this.logger.warn("Extra component in live digest", {
          network,
          contractId,
          checkpointNumber,
          digestVersion,
          componentName,
        });
      }
    }

    return mismatches;
  }

  /**
   * Persist mismatches to database.
   * Uses unique constraint to prevent duplicates within a runId.
   * @private
   */
  private async persistMismatches(
    network: string,
    contractId: string,
    checkpointNumber: string,
    digestVersion: string,
    mismatches: Array<{
      componentName: string;
      expectedValue: string;
      observedValue: string;
    }>,
    runId: string,
    detectedAt: Date,
  ): Promise<void> {
    for (const mismatch of mismatches) {
      try {
        // Try to insert; ignore if already exists (unique constraint)
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO "ContractStateCheckpointMismatch" 
           (id, network, "contractId", "checkpointNumber", "digestVersion", "componentName", 
            "expectedValue", "observedValue", "detectionTime", "runId", "createdAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT ("network", "contractId", "checkpointNumber", "digestVersion", "componentName", "runId") 
           DO NOTHING`,
          [
            `mismatch_${uuidv4()}`,
            network,
            contractId,
            checkpointNumber,
            digestVersion,
            mismatch.componentName,
            mismatch.expectedValue,
            mismatch.observedValue,
            detectedAt,
            runId,
            new Date(),
          ],
        );
      } catch (error) {
        this.logger.error("Error persisting mismatch", error as Error, {
          network,
          contractId,
          checkpointNumber,
          componentName: mismatch.componentName,
          runId,
        });
        throw error;
      }
    }
  }

  /**
   * Persist verification failure to database.
   * @private
   */
  private async persistVerificationFailure(
    network: string,
    contractId: string,
    failureCode: string,
    failureMessage: string,
    runId: string,
    detectedAt: Date,
  ): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "ContractStateVerificationFailure"
         (id, network, "contractId", "digestVersion", "failureCode", "failureMessage", 
          "detectionTime", "runId", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          `failure_${uuidv4()}`,
          network,
          contractId,
          null, // digestVersion may be unknown
          failureCode,
          failureMessage,
          detectedAt,
          runId,
          new Date(),
        ],
      );
    } catch (error) {
      this.logger.error("Error persisting verification failure", error as Error, {
        network,
        contractId,
        failureCode,
        runId,
      });
      throw error;
    }
  }

  /**
   * Persist reconciliation run record.
   * @private
   */
  private async persistReconciliationRun(
    network: string,
    contractId: string,
    checkpointNumber: string,
    digestVersion: string | undefined,
    runId: string,
    verificationStatus: "PASSED" | "FAILED",
    comparisonStatus: string | undefined,
    mismatchCount: number | undefined,
    detectedAt: Date,
  ): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "ContractStateReconciliationRun"
         (id, network, "contractId", "checkpointNumber", "digestVersion", "runId",
          "verificationStatus", "comparisonStatus", "mismatchCount", "detectedAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          `run_${uuidv4()}`,
          network,
          contractId,
          checkpointNumber,
          digestVersion ?? null,
          runId,
          verificationStatus,
          comparisonStatus ?? null,
          mismatchCount ?? null,
          detectedAt,
          new Date(),
        ],
      );
    } catch (error) {
      this.logger.error("Error persisting reconciliation run", error as Error, {
        network,
        contractId,
        runId,
      });
      throw error;
    }
  }

  /**
   * Get the latest checkpoint to compare.
   * For now, returns a fixed value; in production, query from contract or config.
   * @private
   */
  private async getLatestCheckpoint(): Promise<string | null> {
    // TODO: In production, query the contract or use a configured checkpoint
    // For now, return null to indicate no checkpoint available
    return null;
  }
}
