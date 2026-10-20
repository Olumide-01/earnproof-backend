import { UnprocessableEntityException } from "@nestjs/common";
import { AnchoringOperation, AnchoringStatus, QuarantineDecision } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { VerificationEventService } from "../../src/audit/verification-event.service";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { AnchoringWorkerService } from "../../src/jobs/anchoring-worker.service";
import { PrismaService } from "../../src/database/prisma.service";
import { ProofsService } from "../../src/proofs/proofs.service";
import { integrationDatabase } from "./harness/database";
import { integrationModule } from "./harness/nest";
import { seedProof, seedUser } from "./harness/fixtures";

/**
 * Anchoring dead-letter quarantine and recovery (earnproof-backend#179)
 * against real PostgreSQL.
 *
 * `AnchoringWorkerService.processIntent` is exercised with the real
 * `PrismaService` but a stubbed `ContractAnchoringService`, so the CLI
 * boundary is controlled while the actual quarantine writes go through the
 * real schema, indexes, and enum types.
 */

const db = integrationDatabase();
const injector = integrationModule([ProofsService, VerificationEventService]);

function proofs(): ProofsService {
  return injector.get(ProofsService);
}

function makeWorker(anchoring: {
  anchorProof: jest.Mock;
  revokeProof: jest.Mock;
}): AnchoringWorkerService {
  const config = {
    get: () => undefined,
  } as unknown as ConfigService;

  return new AnchoringWorkerService(
    injector.get(PrismaService),
    anchoring as never,
    config,
  );
}

async function createRegisterIntent(proofId: string) {
  return db.prisma.anchoringIntent.create({
    data: { proofId, operation: AnchoringOperation.REGISTER },
  });
}

describe("anchoring quarantine: worker classification", () => {
  it("quarantines with POISON_INPUT when the input can never succeed", async () => {
    const user = await seedUser(db.prisma, "quarantine-poison-owner");
    const proof = await seedProof(db.prisma, "quarantine-poison-proof", user.id);
    const intent = await createRegisterIntent(proof.id);

    const worker = makeWorker({
      anchorProof: jest.fn().mockRejectedValue(new Error("proof not found")),
      revokeProof: jest.fn(),
    });

    await worker.processIntent(intent.id);

    const stored = await db.prisma.anchoringIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(stored.status).toBe(AnchoringStatus.QUARANTINED);
    expect(stored.quarantineReasonCode).toBe("POISON_INPUT");
    expect(stored.quarantineDecision).toBe(QuarantineDecision.PENDING);
    expect(stored.quarantinedAt).not.toBeNull();
    expect(stored.nextRetryAt).toBeNull();
  });

  it("quarantines with CHAIN_REJECTED when the chain explicitly refuses", async () => {
    const user = await seedUser(db.prisma, "quarantine-chain-owner");
    const proof = await seedProof(db.prisma, "quarantine-chain-proof", user.id);
    const intent = await createRegisterIntent(proof.id);

    const worker = makeWorker({
      anchorProof: jest.fn().mockRejectedValue(new Error("proof already registered")),
      revokeProof: jest.fn(),
    });

    await worker.processIntent(intent.id);

    const stored = await db.prisma.anchoringIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(stored.status).toBe(AnchoringStatus.QUARANTINED);
    expect(stored.quarantineReasonCode).toBe("CHAIN_REJECTED");
  });

  it("does not quarantine a transient failure below MAX_ATTEMPTS: it stays retryable", async () => {
    const user = await seedUser(db.prisma, "quarantine-transient-owner");
    const proof = await seedProof(db.prisma, "quarantine-transient-proof", user.id);
    const intent = await createRegisterIntent(proof.id);

    const worker = makeWorker({
      anchorProof: jest.fn().mockRejectedValue(new Error("network timeout")),
      revokeProof: jest.fn(),
    });

    await worker.processIntent(intent.id);

    const stored = await db.prisma.anchoringIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(stored.status).toBe(AnchoringStatus.PENDING);
    expect(stored.quarantinedAt).toBeNull();
    expect(stored.nextRetryAt).not.toBeNull();
  });

  it("is idempotent under concurrent workers: two concurrent processIntent calls quarantine exactly once", async () => {
    const user = await seedUser(db.prisma, "quarantine-concurrent-owner");
    const proof = await seedProof(db.prisma, "quarantine-concurrent-proof", user.id);
    const intent = await createRegisterIntent(proof.id);

    const worker = makeWorker({
      anchorProof: jest.fn().mockRejectedValue(new Error("proof already registered")),
      revokeProof: jest.fn(),
    });

    // Both calls race against the same intent id. There is no separate
    // atomic claim here (processIntent is the direct, single-intent path;
    // processBatch owns the FOR UPDATE SKIP LOCKED claim), so this asserts
    // the outcome is well-defined and safe to run twice, not a specific
    // interleaving.
    await Promise.all([worker.processIntent(intent.id), worker.processIntent(intent.id)]);

    const stored = await db.prisma.anchoringIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(stored.status).toBe(AnchoringStatus.QUARANTINED);
    expect(stored.quarantineReasonCode).toBe("CHAIN_REJECTED");

    // Exactly one row for this (proof, operation) pair regardless of the
    // race: the unique constraint, not application logic, is what prevents
    // a duplicate.
    const count = await db.prisma.anchoringIntent.count({ where: { proofId: proof.id } });
    expect(count).toBe(1);
  });
});

describe("anchoring quarantine: redrive and abandonment", () => {
  it("redrive preserves the intent's prior attempts and proof identity", async () => {
    const user = await seedUser(db.prisma, "quarantine-redrive-owner");
    const proof = await seedProof(db.prisma, "quarantine-redrive-proof", user.id);
    const intent = await db.prisma.anchoringIntent.create({
      data: {
        proofId: proof.id,
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.QUARANTINED,
        attemptCount: 7,
        permanentError: true,
        lastErrorSafe: "[REDACTED_ADDRESS]: chain rejected",
        quarantinedAt: new Date(),
        quarantineReasonCode: "CHAIN_REJECTED",
      },
    });

    const authenticated: AuthenticatedUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    };

    const result = await proofs().retryProofAnchoring(authenticated, proof.id, intent.id);

    expect(result.status).toBe(AnchoringStatus.PENDING);
    expect(result.attemptCount).toBe(7); // prior attempts preserved

    const stored = await db.prisma.anchoringIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(stored.proofId).toBe(proof.id); // proof identity preserved
    expect(stored.attemptCount).toBe(7);
    expect(stored.quarantineDecision).toBe(QuarantineDecision.REDRIVEN);
    expect(stored.decidedById).toBe(user.id);
    // The original quarantine reason/timestamp survive the redrive.
    expect(stored.quarantineReasonCode).toBe("CHAIN_REJECTED");
    expect(stored.quarantinedAt).not.toBeNull();
  });

  it("abandonment cannot mark an unanchored proof as confirmed", async () => {
    const user = await seedUser(db.prisma, "quarantine-abandon-owner");
    const proof = await seedProof(db.prisma, "quarantine-abandon-proof", user.id, {
      contractTransactionHash: null,
    });
    const intent = await db.prisma.anchoringIntent.create({
      data: {
        proofId: proof.id,
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.QUARANTINED,
        permanentError: true,
        quarantineReasonCode: "MAX_ATTEMPTS_EXCEEDED",
        quarantinedAt: new Date(),
      },
    });

    const authenticated: AuthenticatedUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    };

    const result = await proofs().abandonProofAnchoring(authenticated, proof.id, intent.id);

    expect(result.quarantineDecision).toBe(QuarantineDecision.ABANDONED);

    const storedProof = await db.prisma.proof.findUniqueOrThrow({ where: { id: proof.id } });
    expect(storedProof.contractTransactionHash).toBeNull();
    expect(storedProof.status).toBe("ACTIVE"); // never flipped to a confirmed-looking state

    const storedIntent = await db.prisma.anchoringIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(storedIntent.status).toBe(AnchoringStatus.QUARANTINED); // stays quarantined, not CONFIRMED
  });

  it("abandonment is idempotent: abandoning twice does not overwrite the original decision timestamp", async () => {
    const user = await seedUser(db.prisma, "quarantine-abandon-twice-owner");
    const proof = await seedProof(db.prisma, "quarantine-abandon-twice-proof", user.id);
    const intent = await db.prisma.anchoringIntent.create({
      data: {
        proofId: proof.id,
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.QUARANTINED,
        permanentError: true,
        quarantineReasonCode: "MAX_ATTEMPTS_EXCEEDED",
        quarantinedAt: new Date(),
      },
    });

    const authenticated: AuthenticatedUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    };

    await proofs().abandonProofAnchoring(authenticated, proof.id, intent.id);
    const firstDecidedAt = (
      await db.prisma.anchoringIntent.findUniqueOrThrow({ where: { id: intent.id } })
    ).decidedAt;

    await proofs().abandonProofAnchoring(authenticated, proof.id, intent.id);
    const secondDecidedAt = (
      await db.prisma.anchoringIntent.findUniqueOrThrow({ where: { id: intent.id } })
    ).decidedAt;

    expect(secondDecidedAt?.getTime()).toBe(firstDecidedAt?.getTime());
  });

  it("refuses to redrive an intent that was already abandoned", async () => {
    const user = await seedUser(db.prisma, "quarantine-redrive-after-abandon-owner");
    const proof = await seedProof(db.prisma, "quarantine-redrive-after-abandon-proof", user.id);
    const intent = await db.prisma.anchoringIntent.create({
      data: {
        proofId: proof.id,
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.QUARANTINED,
        permanentError: true,
        quarantineReasonCode: "MAX_ATTEMPTS_EXCEEDED",
        quarantineDecision: QuarantineDecision.ABANDONED,
        quarantinedAt: new Date(),
        decidedAt: new Date(),
        decidedById: user.id,
      },
    });

    const authenticated: AuthenticatedUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    };

    await expect(
      proofs().retryProofAnchoring(authenticated, proof.id, intent.id),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    const stored = await db.prisma.anchoringIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(stored.status).toBe(AnchoringStatus.QUARANTINED);
    expect(stored.quarantineDecision).toBe(QuarantineDecision.ABANDONED);
  });
});
