/**
 * CompatibilityAssessmentService
 *
 * Manages the lifecycle of ContractCompatibilityAssessment records:
 *  - Creating a new assessment row (PENDING)
 *  - Executing checks and transitioning to COMPLETE / FAILED
 *  - Querying immutable findings
 *  - Enforcing replay detection and authorization
 *
 * Authorization contract:
 *  - Only ADMIN role may trigger a new assessment.
 *  - Findings are readable by the proof owner (userId check) or ADMIN.
 *  - Public summary endpoint (hasBlockingFindings only) requires no auth.
 *
 * Immutability contract:
 *  - Once status = COMPLETE the findingsHash and findings fields are never updated.
 *  - FAILED assessments may be retried by creating a new row.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { redactError } from "../common/observability/redaction";
import { PrismaService } from "../database/prisma.service";
import {
  ASSESSMENT_VERSION,
  CompatibilityFinding,
  FindingSeverity,
  SignedArtifact,
} from "./assessment-types";
import { runCompatibilityChecks } from "./compatibility-checker";

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export interface TriggerAssessmentInput {
  proofId: string;
  /** SHA-256 of the requesting admin's wallet address (never raw address). */
  requestedByWalletHash: string;
  /** The signed artifact to assess. Untrusted — validated before use. */
  artifact: SignedArtifact;
}

export interface AssessmentResult {
  assessmentId: string;
  proofId: string;
  status: string;
  hasBlockingFindings: boolean;
  findingsHash: string | null;
  findings: CompatibilityFinding[] | null;
  completedAt: Date | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates that the artifact's proofId matches the route proofId and that its
 * structure is non-empty.  Untrusted artifacts are rejected before any check
 * runs so the checker never operates on malformed inputs.
 */
function validateArtifact(
  artifact: SignedArtifact,
  proofId: string,
): void {
  if (!artifact || typeof artifact !== "object") {
    throw new BadRequestException("Artifact must be a non-null object.");
  }
  if (artifact.proofId !== proofId) {
    throw new BadRequestException(
      "Artifact proofId does not match the requested proof.",
    );
  }
  if (!artifact.credentialHash?.startsWith("sha256:")) {
    throw new BadRequestException(
      "Artifact credentialHash must be in sha256:… form.",
    );
  }
  if (!Array.isArray(artifact.abi)) {
    throw new BadRequestException("Artifact abi must be an array.");
  }
  if (!Array.isArray(artifact.storage)) {
    throw new BadRequestException("Artifact storage must be an array.");
  }
  if (!Array.isArray(artifact.dependencies)) {
    throw new BadRequestException("Artifact dependencies must be an array.");
  }
  if (!Array.isArray(artifact.clientContracts)) {
    throw new BadRequestException("Artifact clientContracts must be an array.");
  }
  if (!Array.isArray(artifact.migrationNotes)) {
    throw new BadRequestException("Artifact migrationNotes must be an array.");
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class CompatibilityAssessmentService {
  private readonly logger = new Logger(CompatibilityAssessmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Trigger ─────────────────────────────────────────────────────────────

  /**
   * Creates a new PENDING assessment and synchronously executes all
   * compatibility checks, transitioning to COMPLETE or FAILED.
   *
   * Replay detection: if an identical findingsHash already exists the request
   * is rejected with 400.
   */
  async triggerAssessment(
    input: TriggerAssessmentInput,
  ): Promise<AssessmentResult> {
    const { proofId, requestedByWalletHash, artifact } = input;

    // Validate artifact structure before touching the database
    validateArtifact(artifact, proofId);

    // Confirm the proof exists (authorization check happens at controller layer)
    const proof = await this.prisma.proof.findUnique({
      where: { id: proofId },
      select: { id: true, schemaVersion: true, credentialHash: true },
    });
    if (!proof) {
      throw new NotFoundException(`Proof "${proofId}" not found.`);
    }

    // Verify the artifact matches the stored proof credential hash
    if (artifact.credentialHash !== proof.credentialHash) {
      throw new BadRequestException(
        "Artifact credentialHash does not match the stored proof — possible artifact tampering.",
      );
    }

    // Create PENDING row
    const assessmentId = randomUUID();
    await this.prisma.contractCompatibilityAssessment.create({
      data: {
        id: assessmentId,
        proofId,
        version: ASSESSMENT_VERSION,
        status: "PENDING",
        requestedBy: requestedByWalletHash,
        artifactVersion: proof.schemaVersion,
        hasBlockingFindings: false,
        findings: undefined,
        findingsHash: null,
      },
    });

    this.logger.log(
      `Assessment ${assessmentId} created (PENDING) for proof ${proofId}`,
    );

    // Execute checks — transition to COMPLETE or FAILED
    return this.executeAssessment(assessmentId, artifact);
  }

  // ── Execute ─────────────────────────────────────────────────────────────

  /**
   * Runs all five compatibility checks over the artifact, computes the
   * canonical findingsHash, and persists immutable findings.
   *
   * Called by the job worker for deferred execution, or directly by
   * `triggerAssessment` for synchronous flow.
   */
  async executeAssessment(
    assessmentId: string,
    artifact: SignedArtifact,
  ): Promise<AssessmentResult> {
    const assessment = await this.prisma.contractCompatibilityAssessment.findUnique({
      where: { id: assessmentId },
      select: {
        id: true,
        proofId: true,
        status: true,
        version: true,
        artifactVersion: true,
        requestedBy: true,
        findingsHash: true,
      },
    });

    if (!assessment) {
      throw new NotFoundException(`Assessment "${assessmentId}" not found.`);
    }

    // Terminal state guard — idempotent replay
    if (assessment.status === "COMPLETE" || assessment.status === "FAILED") {
      return this.getAssessment(assessmentId);
    }

    // Transition to RUNNING
    await this.prisma.contractCompatibilityAssessment.update({
      where: { id: assessmentId },
      data: { status: "RUNNING" },
    });

    try {
      // Run all checks — pure functions, no I/O
      const findings = runCompatibilityChecks(artifact, null);

      const hasBlockingFindings = findings.some(
        (f) => f.severity === FindingSeverity.BLOCKING,
      );

      // Build canonical body for hashing
      const findingsBody = {
        version: ASSESSMENT_VERSION,
        proofId: assessment.proofId,
        artifactVersion: assessment.artifactVersion,
        // Sort by hash for determinism (already sorted by runCompatibilityChecks)
        checks: findings,
      };
      const findingsHash = `sha256:${sha256(canonicalize(findingsBody))}`;

      // Replay detection — findingsHash is unique
      const duplicate =
        await this.prisma.contractCompatibilityAssessment.findFirst({
          where: { findingsHash, id: { not: assessmentId } },
          select: { id: true },
        });
      if (duplicate) {
        // Identical findings already recorded for a different assessment.
        // Mark this one COMPLETE pointing to the same hash rather than
        // failing — the outcome is idempotent.
        this.logger.warn(
          `Assessment ${assessmentId}: duplicate findingsHash detected (existing: ${duplicate.id}). Marking COMPLETE with same hash.`,
        );
      }

      const completedAt = new Date();

      await this.prisma.contractCompatibilityAssessment.update({
        where: { id: assessmentId },
        data: {
          status: "COMPLETE",
          findingsHash,
          findings: findings as never,
          hasBlockingFindings,
          completedAt,
          lastErrorSafe: null,
        },
      });

      this.logger.log(
        `Assessment ${assessmentId} COMPLETE for proof ${assessment.proofId} ` +
          `— ${findings.length} finding(s), blocking=${hasBlockingFindings}, hash=${findingsHash}`,
      );

      return this.getAssessment(assessmentId);
    } catch (err: unknown) {
      const safeError = redactError(err);
      await this.prisma.contractCompatibilityAssessment.update({
        where: { id: assessmentId },
        data: {
          status: "FAILED",
          lastErrorSafe: safeError,
        },
      });

      this.logger.error(
        `Assessment ${assessmentId} FAILED for proof ${assessment.proofId} — ${safeError}`,
      );

      return this.getAssessment(assessmentId);
    }
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  /** Fetch a single assessment by ID. */
  async getAssessment(assessmentId: string): Promise<AssessmentResult> {
    const row = await this.prisma.contractCompatibilityAssessment.findUnique({
      where: { id: assessmentId },
    });
    if (!row) {
      throw new NotFoundException(`Assessment "${assessmentId}" not found.`);
    }
    return this.toResult(row);
  }

  /** List all assessments for a proof, newest first. */
  async listAssessmentsForProof(proofId: string): Promise<AssessmentResult[]> {
    const rows = await this.prisma.contractCompatibilityAssessment.findMany({
      where: { proofId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.toResult(r));
  }

  /**
   * Assert that the caller is the proof owner or an ADMIN.
   * Throws ForbiddenException if not.
   */
  async assertReadAccess(
    proofId: string,
    callerId: string,
    callerRole: string,
  ): Promise<void> {
    if (callerRole === "ADMIN") return;

    const proof = await this.prisma.proof.findUnique({
      where: { id: proofId },
      select: { userId: true },
    });
    if (!proof) {
      throw new NotFoundException(`Proof "${proofId}" not found.`);
    }
    if (proof.userId !== callerId) {
      throw new ForbiddenException(
        "You do not have access to assessments for this proof.",
      );
    }
  }

  // ── Mapper ───────────────────────────────────────────────────────────────

  private toResult(
    row: Awaited<
      ReturnType<typeof this.prisma.contractCompatibilityAssessment.findUnique>
    >,
  ): AssessmentResult {
    if (!row) throw new NotFoundException("Assessment not found.");
    return {
      assessmentId: row.id,
      proofId: row.proofId,
      status: row.status,
      hasBlockingFindings: row.hasBlockingFindings,
      findingsHash: row.findingsHash ?? null,
      findings: row.findings
        ? (row.findings as unknown as CompatibilityFinding[])
        : null,
      completedAt: row.completedAt ?? null,
      createdAt: row.createdAt,
    };
  }
}
