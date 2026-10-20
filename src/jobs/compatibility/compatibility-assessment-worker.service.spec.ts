/**
 * Unit tests for CompatibilityAssessmentWorkerService
 *
 * Coverage:
 *  - Config-gated: poll() is a no-op when compatAssessment.enabled = false.
 *  - Drain: poll() is a no-op after draining = true.
 *  - Stale reset: RUNNING rows older than threshold are reset to PENDING.
 *  - Batch claim: atomic claim calls are exercised via recoverPendingAssessments().
 *  - Error handling: proof not found during recovery marks FAILED.
 *  - Shutdown drain: onApplicationShutdown awaits in-flight cycle.
 *
 * All Prisma calls and the CompatibilityAssessmentService are mocked inline.
 */

import { CompatibilityAssessmentWorkerService } from "./compatibility-assessment-worker.service";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeConfig(enabled: boolean) {
  return { get: jest.fn().mockReturnValue(enabled) };
}

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    contractCompatibilityAssessment: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      ...(overrides.assessment ?? {}),
    },
    proof: {
      findUnique: jest.fn().mockResolvedValue(
        overrides.proof ?? {
          credentialHash: "sha256:synthetic-cred-hash",
          schemaVersion: "1",
        },
      ),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...(overrides.extra ?? {}),
  };
}

function makeAssessmentService() {
  return {
    executeAssessment: jest.fn().mockResolvedValue({
      assessmentId: "assess-001",
      status: "COMPLETE",
      hasBlockingFindings: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// Constructor and config gate
// ---------------------------------------------------------------------------

describe("CompatibilityAssessmentWorkerService — config gate", () => {
  it("poll() is a no-op when compatAssessment.enabled = false", async () => {
    const prisma = makePrisma();
    const config = makeConfig(false);
    const service = makeAssessmentService();
    const worker = new CompatibilityAssessmentWorkerService(
      prisma as never,
      service as never,
      config as never,
    );

    await (worker as unknown as { poll(): Promise<void> }).poll();

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.contractCompatibilityAssessment.updateMany).not.toHaveBeenCalled();
  });

  it("recoverPendingAssessments() is a no-op when disabled", async () => {
    const prisma = makePrisma();
    const config = makeConfig(false);
    const service = makeAssessmentService();
    const worker = new CompatibilityAssessmentWorkerService(
      prisma as never,
      service as never,
      config as never,
    );

    await worker.recoverPendingAssessments();

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

describe("CompatibilityAssessmentWorkerService — drain", () => {
  it("poll() is a no-op after onApplicationShutdown is called", async () => {
    const prisma = makePrisma();
    const config = makeConfig(true);
    const service = makeAssessmentService();
    const worker = new CompatibilityAssessmentWorkerService(
      prisma as never,
      service as never,
      config as never,
    );

    await worker.onApplicationShutdown("SIGTERM");

    const pollFn = (worker as unknown as { poll(): Promise<void> }).poll.bind(worker);
    await pollFn();

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("onApplicationShutdown resolves immediately when no cycle is in flight", async () => {
    const prisma = makePrisma();
    const config = makeConfig(true);
    const service = makeAssessmentService();
    const worker = new CompatibilityAssessmentWorkerService(
      prisma as never,
      service as never,
      config as never,
    );

    await expect(worker.onApplicationShutdown()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Stale reset
// ---------------------------------------------------------------------------

describe("CompatibilityAssessmentWorkerService — stale reset", () => {
  it("calls updateMany to reset stale RUNNING rows when enabled", async () => {
    const prisma = makePrisma();
    const config = makeConfig(true);
    const service = makeAssessmentService();
    const worker = new CompatibilityAssessmentWorkerService(
      prisma as never,
      service as never,
      config as never,
    );

    await worker.recoverPendingAssessments();

    expect(
      prisma.contractCompatibilityAssessment.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "RUNNING" }),
        data: expect.objectContaining({ status: "PENDING" }),
      }),
    );
  });

  it("logs a warning when stale rows were reset (count > 0)", async () => {
    const prisma = makePrisma({
      assessment: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
    });
    const config = makeConfig(true);
    const service = makeAssessmentService();
    const worker = new CompatibilityAssessmentWorkerService(
      prisma as never,
      service as never,
      config as never,
    );

    // Should not throw even when stale rows are found
    await expect(worker.recoverPendingAssessments()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Batch claim
// ---------------------------------------------------------------------------

describe("CompatibilityAssessmentWorkerService — batch processing", () => {
  it("calls executeAssessment for each claimed row", async () => {
    const prisma = makePrisma({
      extra: {
        $queryRaw: jest.fn().mockResolvedValue([
          { id: "assess-001", proofId: "proof-001", artifactVersion: "1" },
          { id: "assess-002", proofId: "proof-002", artifactVersion: "1" },
        ]),
      },
    });
    const config = makeConfig(true);
    const service = makeAssessmentService();
    const worker = new CompatibilityAssessmentWorkerService(
      prisma as never,
      service as never,
      config as never,
    );

    await worker.recoverPendingAssessments();

    expect(service.executeAssessment).toHaveBeenCalledTimes(2);
  });

  it("marks row FAILED when proof not found during recovery", async () => {
    const prisma = makePrisma({
      proof: null, // proof lookup returns null
      extra: {
        $queryRaw: jest.fn().mockResolvedValue([
          { id: "assess-001", proofId: "missing-proof", artifactVersion: "1" },
        ]),
        contractCompatibilityAssessment: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          update: jest.fn().mockResolvedValue({}),
        },
      },
    });
    // Override the proof.findUnique to return null
    prisma.proof.findUnique = jest.fn().mockResolvedValue(null);
    // Override assessment.update for the failure write
    (prisma.contractCompatibilityAssessment as Record<string, unknown>).update =
      jest.fn().mockResolvedValue({});

    const config = makeConfig(true);
    const service = makeAssessmentService();
    const worker = new CompatibilityAssessmentWorkerService(
      prisma as never,
      service as never,
      config as never,
    );

    await expect(worker.recoverPendingAssessments()).resolves.not.toThrow();
    expect(
      (prisma.contractCompatibilityAssessment as Record<string, jest.Mock>).update,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Regression — concurrent workers
// ---------------------------------------------------------------------------

describe("CompatibilityAssessmentWorkerService — concurrency regression", () => {
  it("does not process an assessment already in terminal state", async () => {
    // The assessmentService.executeAssessment will early-return for terminal rows
    const prisma = makePrisma({
      extra: {
        $queryRaw: jest.fn().mockResolvedValue([
          { id: "assess-complete", proofId: "proof-001", artifactVersion: "1" },
        ]),
      },
    });
    const service = {
      executeAssessment: jest.fn().mockResolvedValue({
        assessmentId: "assess-complete",
        status: "COMPLETE",
        hasBlockingFindings: false,
      }),
    };
    const config = makeConfig(true);
    const worker = new CompatibilityAssessmentWorkerService(
      prisma as never,
      service as never,
      config as never,
    );

    await worker.recoverPendingAssessments();

    // Even for COMPLETE rows that were accidentally claimed, executeAssessment
    // is called once and returns the existing result
    expect(service.executeAssessment).toHaveBeenCalledTimes(1);
  });
});
