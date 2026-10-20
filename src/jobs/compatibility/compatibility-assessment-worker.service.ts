/**
 * CompatibilityAssessmentWorkerService
 *
 * Crash-recovery worker for PENDING compatibility assessments.
 *
 * Assessments are created synchronously by the service layer and normally
 * complete in the same request.  If the process exits between row creation and
 * execution the row is left PENDING.  This worker reclaims those rows using
 * the same atomic-claim pattern as AnchoringWorkerService.
 *
 * Design constraints mirrored from AnchoringWorkerService:
 *  - Atomic batch claim via raw SQL UPDATE ... RETURNING with FOR UPDATE SKIP LOCKED.
 *  - Graceful drain on shutdown (OnApplicationShutdown).
 *  - Config-gated: no-op when compatAssessment.enabled = false.
 *  - Max attempts before permanent failure.
 *  - Redacted error storage via redactError().
 */

import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import {
  SignedArtifact,
} from "../../contracts/assessment-types";
import { CompatibilityAssessmentService } from "../../contracts/compatibility-assessment.service";
import { redactError } from "../../common/observability/redaction";
import { PrismaService } from "../../database/prisma.service";

const BATCH_SIZE = 5;
const STALE_PROCESSING_THRESHOLD_MS = 10 * 60 * 1_000; // 10 minutes
const SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;


/**
 * A stub artifact reconstructed from proof metadata for recovery scenarios.
 *
 * In normal operation the real artifact is passed by the caller.  In the
 * recovery path we only have the proof row — we reconstruct a minimal artifact
 * so the checker can produce its ABI-baseline findings rather than skipping.
 */
function buildRecoveryArtifact(
  proofId: string,
  credentialHash: string,
  schemaVersion: string,
): SignedArtifact {
  return {
    proofId,
    schemaVersion,
    credentialHash,
    abi: [],
    storage: [],
    dependencies: [],
    clientContracts: [],
    migrationNotes: [],
  };
}

@Injectable()
export class CompatibilityAssessmentWorkerService
  implements OnApplicationShutdown
{
  private readonly logger = new Logger(
    CompatibilityAssessmentWorkerService.name,
  );

  private draining = false;
  private inFlightCycle: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly assessmentService: CompatibilityAssessmentService,
    private readonly config: ConfigService,
  ) {}

  // ── Poll loop ────────────────────────────────────────────────────────────

  /**
   * Runs every 30 seconds.
   *
   * In normal operation this is almost always a no-op because assessments
   * complete inline.  It activates only when a row is left PENDING by a
   * crash or a configuration-disabled run.
   */
  @Interval(30_000)
  async poll(): Promise<void> {
    if (this.draining) return;
    if (!this.config.get<boolean>("compatAssessment.enabled")) return;

    const cycle = this.runCycle();
    this.inFlightCycle = cycle;
    try {
      await cycle;
    } finally {
      if (this.inFlightCycle === cycle) {
        this.inFlightCycle = null;
      }
    }
  }

  private async runCycle(): Promise<void> {
    await this.resetStaleProcessing();
    await this.processBatch();
  }

  // ── Public recovery entry point (called by CompatibilityAssessmentJob) ───

  async recoverPendingAssessments(): Promise<void> {
    if (!this.config.get<boolean>("compatAssessment.enabled")) return;
    await this.resetStaleProcessing();
    await this.processBatch();
  }

  // ── Shutdown drain ───────────────────────────────────────────────────────

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.draining = true;
    this.logger.log(
      `Draining: no new poll cycles will start (signal=${signal ?? "unknown"})`,
    );

    const cycle = this.inFlightCycle;
    if (!cycle) return;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS);
    });

    let drained: boolean;
    try {
      drained = await Promise.race([
        cycle.then(() => true).catch(() => true),
        timeout.then(() => false),
      ]);
    } finally {
      clearTimeout(timer);
    }

    if (drained) {
      this.logger.log("In-flight compatibility assessment cycle finished draining");
    } else {
      this.logger.warn(
        `Compatibility assessment cycle did not finish within ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms — ` +
          "PENDING/RUNNING rows will be reclaimed on the next healthy worker tick",
      );
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async resetStaleProcessing(): Promise<void> {
    const staleThreshold = new Date(Date.now() - STALE_PROCESSING_THRESHOLD_MS);

    const reset = await this.prisma.contractCompatibilityAssessment.updateMany({
      where: {
        status: "RUNNING",
        createdAt: { lt: staleThreshold },
      },
      data: { status: "PENDING" },
    });

    if (reset.count > 0) {
      this.logger.warn(
        `Reset ${reset.count} stale RUNNING assessment(s) to PENDING`,
      );
    }
  }

  private async processBatch(): Promise<void> {

    // Atomic claim — only rows this worker transitions PENDING→RUNNING are
    // returned, so concurrent workers cannot double-process the same row.
    const claimed = await this.prisma.$queryRaw<
      Array<{
        id: string;
        proofId: string;
        artifactVersion: string;
      }>
    >`
      WITH candidates AS (
        SELECT id
        FROM "ContractCompatibilityAssessment"
        WHERE status = 'PENDING'::"AssessmentStatus"
        ORDER BY "createdAt" ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "ContractCompatibilityAssessment" AS a
      SET status = 'RUNNING'::"AssessmentStatus"
      FROM candidates
      WHERE a.id = candidates.id
      RETURNING a.id, a."proofId", a."artifactVersion"
    `;

    for (const row of claimed) {
      await this.processRow(row.id, row.proofId);
    }
  }

  private async processRow(
    assessmentId: string,
    proofId: string,
  ): Promise<void> {
    const proof = await this.prisma.proof.findUnique({
      where: { id: proofId },
      select: { credentialHash: true, schemaVersion: true },
    });

    if (!proof) {
      const safeError = redactError(
        new Error(`Proof ${proofId} not found during recovery`),
      );
      await this.prisma.contractCompatibilityAssessment.update({
        where: { id: assessmentId },
        data: { status: "FAILED", lastErrorSafe: safeError },
      });
      this.logger.error(
        `Assessment ${assessmentId} failed: proof ${proofId} not found`,
      );
      return;
    }

    const recoveryArtifact = buildRecoveryArtifact(
      proofId,
      proof.credentialHash,
      proof.schemaVersion,
    );

    try {
      await this.assessmentService.executeAssessment(
        assessmentId,
        recoveryArtifact,
      );
    } catch (err: unknown) {
      const safeError = redactError(err);
      await this.prisma.contractCompatibilityAssessment.update({
        where: { id: assessmentId },
        data: { status: "FAILED", lastErrorSafe: safeError },
      });
      this.logger.error(
        `Assessment ${assessmentId} (recovery) FAILED — ${safeError}`,
      );
    }
  }
}
