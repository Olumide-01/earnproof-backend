/**
 * Unit tests for GovernanceReviewService / evaluateAssessment()
 *
 * Coverage:
 *  - Positive: COMPLETE assessment with no BLOCKING findings → AUTO_APPROVED.
 *  - Negative: BLOCKING findings → BLOCKED_BLOCKING_FINDINGS.
 *  - Negative: FAILED assessment → BLOCKED_ASSESSMENT_FAILED.
 *  - Negative: PENDING/RUNNING → BLOCKED_ASSESSMENT_INCOMPLETE.
 *  - Negative: unknown check kind → BLOCKED_UNKNOWN_CHECK.
 *  - Negative: empty findings → BLOCKED_NO_FINDINGS.
 *  - Exact boundary: mixed BLOCKING + WARNING → blocked (not approved).
 *  - Determinism: same input → same verdict + reason.
 *  - Hash binding: findingsHash propagated to review.
 *
 * No DB, no I/O — evaluateAssessment() is a pure function.
 */

import {
  blockingCompatibilityAssessment,
  buildCompatibilityAssessment,
  failedCompatibilityAssessment,
  pendingCompatibilityAssessment,
} from "../testing/factories";
import { CheckKind, FindingSeverity } from "../contracts/assessment-types";
import { AssessmentResult } from "../contracts/compatibility-assessment.service";
import {
  GovernanceReviewService,
  evaluateAssessment,
} from "./governance-review.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toResult(
  input: ReturnType<typeof buildCompatibilityAssessment>,
): AssessmentResult {
  return {
    assessmentId: input.id,
    proofId: input.proofId,
    status: input.status,
    hasBlockingFindings: input.hasBlockingFindings,
    findingsHash: input.findingsHash ?? null,
    findings: input.findings,
    completedAt: input.completedAt,
    createdAt: new Date("2025-01-01"),
  };
}

// ---------------------------------------------------------------------------
// Positive path
// ---------------------------------------------------------------------------

describe("evaluateAssessment() — positive", () => {
  it("returns AUTO_APPROVED for a clean completed assessment", () => {
    const result = toResult(buildCompatibilityAssessment(1, "proof-001"));
    const review = evaluateAssessment(result);

    expect(review.verdict).toBe("AUTO_APPROVED");
    expect(review.blockingFindings).toHaveLength(0);
    expect(review.findingsHash).toBe(result.findingsHash);
    expect(review.assessmentId).toBe(result.assessmentId);
  });

  it("propagates findingsHash to the review", () => {
    const result = toResult(buildCompatibilityAssessment(5, "proof-005"));
    const review = evaluateAssessment(result);

    expect(review.findingsHash).toBe(result.findingsHash);
  });
});

// ---------------------------------------------------------------------------
// Blocking findings
// ---------------------------------------------------------------------------

describe("evaluateAssessment() — blocking findings", () => {
  it("returns BLOCKED_BLOCKING_FINDINGS when blocking findings exist", () => {
    const result = toResult(blockingCompatibilityAssessment(2, "proof-002"));
    const review = evaluateAssessment(result);

    expect(review.verdict).toBe("BLOCKED_BLOCKING_FINDINGS");
    expect(review.blockingFindings.length).toBeGreaterThanOrEqual(1);
    expect(review.blockingFindings.every(
      (f) => f.severity === FindingSeverity.BLOCKING,
    )).toBe(true);
  });

  it("includes all BLOCKING findings in the review (not just first)", () => {
    const result: AssessmentResult = {
      assessmentId: "a1",
      proofId: "p1",
      status: "COMPLETE",
      hasBlockingFindings: true,
      findingsHash: "sha256:abc",
      findings: [
        {
          checkKind: CheckKind.ABI,
          severity: FindingSeverity.BLOCKING,
          description: "ABI breaking change 1",
          hash: "sha256:hash1",
        },
        {
          checkKind: CheckKind.STORAGE,
          severity: FindingSeverity.BLOCKING,
          description: "Storage breaking change 2",
          hash: "sha256:hash2",
        },
        {
          checkKind: CheckKind.MIGRATION,
          severity: FindingSeverity.INFO,
          description: "Migration info",
          hash: "sha256:hash3",
        },
      ],
      completedAt: new Date(),
      createdAt: new Date(),
    };

    const review = evaluateAssessment(result);
    expect(review.blockingFindings).toHaveLength(2);
  });

  it("mixed BLOCKING and WARNING is still blocked (not approved)", () => {
    const result: AssessmentResult = {
      assessmentId: "a2",
      proofId: "p2",
      status: "COMPLETE",
      hasBlockingFindings: true,
      findingsHash: "sha256:def",
      findings: [
        {
          checkKind: CheckKind.ABI,
          severity: FindingSeverity.BLOCKING,
          description: "Breaking",
          hash: "sha256:h1",
        },
        {
          checkKind: CheckKind.DEPENDENCY,
          severity: FindingSeverity.WARNING,
          description: "Warning only",
          hash: "sha256:h2",
        },
      ],
      completedAt: new Date(),
      createdAt: new Date(),
    };

    const review = evaluateAssessment(result);
    expect(review.verdict).toBe("BLOCKED_BLOCKING_FINDINGS");
  });
});

// ---------------------------------------------------------------------------
// Stale / incomplete state
// ---------------------------------------------------------------------------

describe("evaluateAssessment() — stale and incomplete states", () => {
  it("returns BLOCKED_ASSESSMENT_FAILED for a FAILED assessment", () => {
    const result = toResult(failedCompatibilityAssessment(3, "proof-003"));
    const review = evaluateAssessment(result);

    expect(review.verdict).toBe("BLOCKED_ASSESSMENT_FAILED");
    expect(review.reason).toMatch(/FAILED/);
  });

  it("returns BLOCKED_ASSESSMENT_INCOMPLETE for PENDING", () => {
    const result = toResult(pendingCompatibilityAssessment(4, "proof-004"));
    const review = evaluateAssessment(result);

    expect(review.verdict).toBe("BLOCKED_ASSESSMENT_INCOMPLETE");
    expect(review.reason).toMatch(/PENDING/);
  });

  it("returns BLOCKED_ASSESSMENT_INCOMPLETE for RUNNING", () => {
    const result = toResult(
      pendingCompatibilityAssessment(4, "proof-004", { status: "RUNNING" }),
    );
    const review = evaluateAssessment(result);

    expect(review.verdict).toBe("BLOCKED_ASSESSMENT_INCOMPLETE");
    expect(review.reason).toMatch(/RUNNING/);
  });
});

// ---------------------------------------------------------------------------
// Unknown check kind
// ---------------------------------------------------------------------------

describe("evaluateAssessment() — unknown check kind", () => {
  it("returns BLOCKED_UNKNOWN_CHECK when an unknown checkKind appears", () => {
    const result: AssessmentResult = {
      assessmentId: "a3",
      proofId: "p3",
      status: "COMPLETE",
      hasBlockingFindings: false,
      findingsHash: "sha256:xyz",
      findings: [
        {
          checkKind: "CUSTOM_UNKNOWN_CHECK" as never,
          severity: FindingSeverity.INFO,
          description: "Unknown check kind",
          hash: "sha256:h1",
        },
      ],
      completedAt: new Date(),
      createdAt: new Date(),
    };

    const review = evaluateAssessment(result);
    expect(review.verdict).toBe("BLOCKED_UNKNOWN_CHECK");
    expect(review.reason).toMatch(/CUSTOM_UNKNOWN_CHECK/);
  });
});

// ---------------------------------------------------------------------------
// Empty findings
// ---------------------------------------------------------------------------

describe("evaluateAssessment() — empty findings", () => {
  it("returns BLOCKED_NO_FINDINGS when findings is an empty array", () => {
    const result: AssessmentResult = {
      assessmentId: "a4",
      proofId: "p4",
      status: "COMPLETE",
      hasBlockingFindings: false,
      findingsHash: "sha256:empty",
      findings: [],
      completedAt: new Date(),
      createdAt: new Date(),
    };

    const review = evaluateAssessment(result);
    expect(review.verdict).toBe("BLOCKED_NO_FINDINGS");
  });

  it("returns BLOCKED_NO_FINDINGS when findings is null", () => {
    const result: AssessmentResult = {
      assessmentId: "a5",
      proofId: "p5",
      status: "COMPLETE",
      hasBlockingFindings: false,
      findingsHash: "sha256:null-findings",
      findings: null,
      completedAt: new Date(),
      createdAt: new Date(),
    };

    const review = evaluateAssessment(result);
    expect(review.verdict).toBe("BLOCKED_NO_FINDINGS");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("evaluateAssessment() — determinism", () => {
  it("produces the same verdict for identical input on repeated calls", () => {
    const result = toResult(buildCompatibilityAssessment(10, "proof-010"));
    const r1 = evaluateAssessment(result);
    const r2 = evaluateAssessment(result);

    expect(r1.verdict).toBe(r2.verdict);
    expect(r1.reason).toBe(r2.reason);
    expect(r1.findingsHash).toBe(r2.findingsHash);
  });
});

// ---------------------------------------------------------------------------
// Injectable service wrapper
// ---------------------------------------------------------------------------

describe("GovernanceReviewService", () => {
  it("delegates to evaluateAssessment and returns the same result", () => {
    const service = new GovernanceReviewService();
    const result = toResult(buildCompatibilityAssessment(1, "proof-001"));
    const review = service.review(result);

    expect(review.verdict).toBe("AUTO_APPROVED");
  });
});
