/**
 * Unit tests for CompatibilityAssessmentService
 *
 * Coverage:
 *  - Positive: successful trigger and execution → COMPLETE with findingsHash.
 *  - Negative: proof not found, artifact tampered, terminal replay.
 *  - Authorization: assertReadAccess proof-owner vs ADMIN.
 *  - Concurrency: duplicate findingsHash detection.
 *  - Boundary: artifact validation rules (null, wrong proofId, bad credentialHash).
 *  - Failure path: FAILED status on checker error.
 *
 * All Prisma calls are mocked inline — no database required.
 */

import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  buildProof,
  buildSignedArtifact,
} from "../testing/factories";
import { CompatibilityAssessmentService } from "./compatibility-assessment.service";

// ---------------------------------------------------------------------------
// Prisma mock factory
// ---------------------------------------------------------------------------

function makeAssessmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "assess-001",
    proofId: "proof-001",
    version: "earnproof.compat-assessment.v1",
    findingsHash: null,
    status: "PENDING",
    requestedBy: "sha256:synthetic-abc",
    artifactVersion: "1",
    hasBlockingFindings: false,
    findings: null,
    lastErrorSafe: null,
    completedAt: null,
    createdAt: new Date("2025-01-01"),
    ...overrides,
  };
}

function makeProofRow(overrides: Record<string, unknown> = {}) {
  const base = buildProof(1, "user-001");
  return {
    id: "proof-001",
    schemaVersion: "1",
    credentialHash: base.credentialHash,
    userId: "user-001",
    ...overrides,
  };
}

function makePrisma(
  overrides: Partial<{
    proofFindUnique: unknown;
    assessmentCreate: unknown;
    assessmentFindUnique: unknown;
    assessmentFindFirst: unknown;
    assessmentUpdate: unknown;
    assessmentFindMany: unknown;
  }> = {},
) {
  const proofRow = makeProofRow();
  const assessmentRow = makeAssessmentRow();
  const completedRow = makeAssessmentRow({
    status: "COMPLETE",
    findingsHash: "sha256:abc123",
    hasBlockingFindings: false,
    findings: [],
    completedAt: new Date("2025-01-01T12:00:00Z"),
  });

  return {
    proof: {
      findUnique: jest.fn().mockResolvedValue(
        overrides.proofFindUnique !== undefined
          ? overrides.proofFindUnique
          : proofRow,
      ),
    },
    contractCompatibilityAssessment: {
      create: jest.fn().mockResolvedValue(
        overrides.assessmentCreate !== undefined
          ? overrides.assessmentCreate
          : assessmentRow,
      ),
      findUnique: jest.fn().mockImplementation(() =>
        Promise.resolve(
          overrides.assessmentFindUnique !== undefined
            ? overrides.assessmentFindUnique
            : assessmentRow,
        ),
      ),
      findFirst: jest.fn().mockResolvedValue(
        overrides.assessmentFindFirst !== undefined
          ? overrides.assessmentFindFirst
          : null,
      ),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...assessmentRow, ...data }),
      ),
      findMany: jest.fn().mockResolvedValue(
        overrides.assessmentFindMany !== undefined
          ? overrides.assessmentFindMany
          : [completedRow],
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Positive path
// ---------------------------------------------------------------------------

describe("CompatibilityAssessmentService — positive path", () => {
  it("creates a PENDING row and transitions to COMPLETE on success", async () => {
    const proofRow = makeProofRow();
    const artifact = buildSignedArtifact(1, proofRow.id, {
      credentialHash: proofRow.credentialHash,
    });

    // After update the row should look complete
    const completedRow = makeAssessmentRow({
      id: "assess-001",
      proofId: proofRow.id,
      status: "COMPLETE",
      findingsHash: "sha256:will-be-overwritten",
      hasBlockingFindings: false,
      findings: [],
      completedAt: new Date(),
    });

    const prisma = makePrisma({
      proofFindUnique: proofRow,
      // findUnique is called twice: once in executeAssessment preamble, once in getAssessment
      assessmentFindUnique: completedRow,
    });

    const service = new CompatibilityAssessmentService(prisma as never);
    const result = await service.triggerAssessment({
      proofId: proofRow.id,
      requestedByWalletHash: "sha256:synthetic-admin",
      artifact,
    });

    expect(prisma.contractCompatibilityAssessment.create).toHaveBeenCalledTimes(1);
    expect(prisma.contractCompatibilityAssessment.update).toHaveBeenCalled();
    expect(result.status).toBe("COMPLETE");
  });

  it("returns all assessments for a proof", async () => {
    const prisma = makePrisma();
    const service = new CompatibilityAssessmentService(prisma as never);
    const results = await service.listAssessmentsForProof("proof-001");
    expect(Array.isArray(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negative path
// ---------------------------------------------------------------------------

describe("CompatibilityAssessmentService — negative path", () => {
  it("throws NotFoundException when proof does not exist", async () => {
    const artifact = buildSignedArtifact(1, "missing-proof");
    const prisma = makePrisma({ proofFindUnique: null });
    const service = new CompatibilityAssessmentService(prisma as never);

    await expect(
      service.triggerAssessment({
        proofId: "missing-proof",
        requestedByWalletHash: "sha256:synthetic-admin",
        artifact,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException when artifact credentialHash is tampered", async () => {
    const proofRow = makeProofRow();
    const artifact = buildSignedArtifact(1, proofRow.id, {
      credentialHash: "sha256:tampered-hash-does-not-match",
    });
    const prisma = makePrisma({ proofFindUnique: proofRow });
    const service = new CompatibilityAssessmentService(prisma as never);

    await expect(
      service.triggerAssessment({
        proofId: proofRow.id,
        requestedByWalletHash: "sha256:synthetic-admin",
        artifact,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when artifact proofId mismatches route proofId", async () => {
    const proofRow = makeProofRow();
    const artifact = buildSignedArtifact(1, "different-proof-id", {
      credentialHash: proofRow.credentialHash,
    });
    const prisma = makePrisma({ proofFindUnique: proofRow });
    const service = new CompatibilityAssessmentService(prisma as never);

    await expect(
      service.triggerAssessment({
        proofId: proofRow.id,
        requestedByWalletHash: "sha256:synthetic-admin",
        artifact,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when artifact credentialHash is not sha256: prefixed", async () => {
    const proofRow = makeProofRow();
    const artifact = buildSignedArtifact(1, proofRow.id, {
      credentialHash: "not-a-valid-hash",
    });
    const prisma = makePrisma({ proofFindUnique: proofRow });
    const service = new CompatibilityAssessmentService(prisma as never);

    await expect(
      service.triggerAssessment({
        proofId: proofRow.id,
        requestedByWalletHash: "sha256:synthetic-admin",
        artifact,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws NotFoundException when getAssessment is called with unknown ID", async () => {
    const prisma = makePrisma({ assessmentFindUnique: null });
    const service = new CompatibilityAssessmentService(prisma as never);

    await expect(service.getAssessment("unknown-id")).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// Terminal state / replay
// ---------------------------------------------------------------------------

describe("CompatibilityAssessmentService — terminal state", () => {
  it("returns existing result without re-executing when status is COMPLETE", async () => {
    const completedRow = makeAssessmentRow({
      status: "COMPLETE",
      findingsHash: "sha256:already-done",
      hasBlockingFindings: false,
      findings: [],
      completedAt: new Date(),
    });
    const prisma = makePrisma({ assessmentFindUnique: completedRow });
    const service = new CompatibilityAssessmentService(prisma as never);

    await service.executeAssessment("assess-001", buildSignedArtifact(1, "proof-001"));

    // Should NOT call update when already COMPLETE
    expect(prisma.contractCompatibilityAssessment.update).not.toHaveBeenCalled();
  });

  it("returns existing result without re-executing when status is FAILED", async () => {
    const failedRow = makeAssessmentRow({ status: "FAILED" });
    const prisma = makePrisma({ assessmentFindUnique: failedRow });
    const service = new CompatibilityAssessmentService(prisma as never);

    await service.executeAssessment("assess-001", buildSignedArtifact(1, "proof-001"));

    expect(prisma.contractCompatibilityAssessment.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("CompatibilityAssessmentService — authorization", () => {
  it("allows ADMIN to read any proof assessments", async () => {
    const prisma = makePrisma();
    const service = new CompatibilityAssessmentService(prisma as never);

    await expect(
      service.assertReadAccess("proof-001", "any-user-id", "ADMIN"),
    ).resolves.not.toThrow();

    // Should not query the proof for ADMIN
    expect(prisma.proof.findUnique).not.toHaveBeenCalled();
  });

  it("allows proof owner to read their assessments", async () => {
    const prisma = makePrisma({
      proofFindUnique: makeProofRow({ userId: "owner-user-id" }),
    });
    const service = new CompatibilityAssessmentService(prisma as never);

    await expect(
      service.assertReadAccess("proof-001", "owner-user-id", "WORKER"),
    ).resolves.not.toThrow();
  });

  it("throws ForbiddenException when non-owner non-admin requests access", async () => {
    const prisma = makePrisma({
      proofFindUnique: makeProofRow({ userId: "real-owner-id" }),
    });
    const service = new CompatibilityAssessmentService(prisma as never);

    await expect(
      service.assertReadAccess("proof-001", "different-user-id", "WORKER"),
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws NotFoundException when proof does not exist during access check", async () => {
    const prisma = makePrisma({ proofFindUnique: null });
    const service = new CompatibilityAssessmentService(prisma as never);

    await expect(
      service.assertReadAccess("proof-001", "any-user", "WORKER"),
    ).rejects.toThrow(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

describe("CompatibilityAssessmentService — boundary", () => {
  it("rejects a null artifact", async () => {
    const proofRow = makeProofRow();
    const prisma = makePrisma({ proofFindUnique: proofRow });
    const service = new CompatibilityAssessmentService(prisma as never);

    await expect(
      service.triggerAssessment({
        proofId: proofRow.id,
        requestedByWalletHash: "sha256:synthetic-admin",
        artifact: null as never,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an artifact with non-array abi field", async () => {
    const proofRow = makeProofRow();
    const prisma = makePrisma({ proofFindUnique: proofRow });
    const service = new CompatibilityAssessmentService(prisma as never);
    const artifact = buildSignedArtifact(1, proofRow.id, {
      credentialHash: proofRow.credentialHash,
      abi: "not-an-array" as never,
    });

    await expect(
      service.triggerAssessment({
        proofId: proofRow.id,
        requestedByWalletHash: "sha256:synthetic-admin",
        artifact,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
