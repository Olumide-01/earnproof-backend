/**
 * GovernanceReviewService
 *
 * Evaluates a completed compatibility assessment and produces a deterministic
 * approval or rejection recommendation for governance reviewers.
 *
 * Rules (acceptance criteria verbatim):
 *  - BLOCKING findings → automatic rejection.
 *  - Unknown check kinds → block automatic approval.
 *  - FAILED assessments → block approval (stale-state safety).
 *  - PENDING / RUNNING → block approval (assessment not complete).
 *  - Only COMPLETE assessments with zero BLOCKING findings → auto-approve.
 *
 * This service is intentionally free of I/O and NestJS decorators on its core
 * evaluation logic so the decision rules can be tested in pure unit tests.
 */

import { Injectable, Logger } from "@nestjs/common";
import {
  KNOWN_CHECK_KINDS,
  CompatibilityFinding,
  FindingSeverity,
} from "../contracts/assessment-types";
import { AssessmentResult } from "../contracts/compatibility-assessment.service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GovernanceVerdict =
  | "AUTO_APPROVED"
  | "BLOCKED_BLOCKING_FINDINGS"
  | "BLOCKED_UNKNOWN_CHECK"
  | "BLOCKED_ASSESSMENT_INCOMPLETE"
  | "BLOCKED_ASSESSMENT_FAILED"
  | "BLOCKED_NO_FINDINGS";

export interface GovernanceReview {
  assessmentId: string;
  proofId: string;
  verdict: GovernanceVerdict;
  reason: string;
  /** The specific findings that caused a block, if any. */
  blockingFindings: CompatibilityFinding[];
  /** Hash binding this review to the assessment findings. */
  findingsHash: string | null;
  reviewedAt: Date;
}

// ---------------------------------------------------------------------------
// Evaluation logic (pure function — testable without DI)
// ---------------------------------------------------------------------------

/**
 * Evaluate an assessment and produce a governance verdict.
 *
 * This is a pure function: given the same `AssessmentResult` it always
 * produces the same `GovernanceReview`.
 */
export function evaluateAssessment(
  assessment: AssessmentResult,
): GovernanceReview {
  const reviewedAt = new Date();
  const base = {
    assessmentId: assessment.assessmentId,
    proofId: assessment.proofId,
    findingsHash: assessment.findingsHash,
    reviewedAt,
    blockingFindings: [] as CompatibilityFinding[],
  };

  // Status checks first — stale or incomplete assessments block approval
  if (assessment.status === "FAILED") {
    return {
      ...base,
      verdict: "BLOCKED_ASSESSMENT_FAILED",
      reason:
        "Assessment is in FAILED state. A new assessment must be triggered before approval.",
    };
  }

  if (assessment.status === "PENDING" || assessment.status === "RUNNING") {
    return {
      ...base,
      verdict: "BLOCKED_ASSESSMENT_INCOMPLETE",
      reason: `Assessment has not completed (status: ${assessment.status}). Wait for COMPLETE status.`,
    };
  }

  // COMPLETE from here on
  if (!assessment.findings || assessment.findings.length === 0) {
    return {
      ...base,
      verdict: "BLOCKED_NO_FINDINGS",
      reason:
        "Assessment completed but produced no findings. Re-trigger the assessment.",
    };
  }

  // Unknown check kind → block (unknown checks must not be silently skipped)
  const unknownKinds = assessment.findings
    .map((f) => f.checkKind)
    .filter((k) => !KNOWN_CHECK_KINDS.has(k));

  if (unknownKinds.length > 0) {
    return {
      ...base,
      verdict: "BLOCKED_UNKNOWN_CHECK",
      reason: `Unknown check kind(s) encountered: ${[...new Set(unknownKinds)].join(", ")}. These must be reviewed manually before approval.`,
    };
  }

  // BLOCKING findings → block
  const blockingFindings = assessment.findings.filter(
    (f) => f.severity === FindingSeverity.BLOCKING,
  );

  if (blockingFindings.length > 0) {
    return {
      ...base,
      verdict: "BLOCKED_BLOCKING_FINDINGS",
      reason: `${blockingFindings.length} BLOCKING finding(s) must be resolved before approval.`,
      blockingFindings,
    };
  }

  // All checks pass
  return {
    ...base,
    verdict: "AUTO_APPROVED",
    reason: "All compatibility checks passed with no BLOCKING findings.",
    blockingFindings: [],
  };
}

// ---------------------------------------------------------------------------
// Injectable service wrapper
// ---------------------------------------------------------------------------

@Injectable()
export class GovernanceReviewService {
  private readonly logger = new Logger(GovernanceReviewService.name);

  review(assessment: AssessmentResult): GovernanceReview {
    const review = evaluateAssessment(assessment);
    this.logger.log(
      `Governance review for assessment ${assessment.assessmentId}: ${review.verdict}`,
    );
    return review;
  }
}
