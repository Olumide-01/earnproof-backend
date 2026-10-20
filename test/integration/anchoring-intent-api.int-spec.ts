import { NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { AnchoringOperation, AnchoringStatus } from "@prisma/client";
import { VerificationEventService } from "../../src/audit/verification-event.service";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { ProofsService } from "../../src/proofs/proofs.service";
import { integrationDatabase } from "./harness/database";
import { integrationModule } from "./harness/nest";
import { seedProof, seedUser } from "./harness/fixtures";

/**
 * Operator-facing anchoring status and retry APIs (earnproof-backend#178)
 * against real PostgreSQL.
 *
 * The unit suite already covers the branching in `ProofsService` with a
 * mocked Prisma client. What it verifies here is the tenant scoping (an
 * owner-scoped `findFirst` really does exclude another user's proof at the
 * database level) and that the retry path's update + audit write commit
 * together.
 */

const db = integrationDatabase();
const injector = integrationModule([ProofsService, VerificationEventService]);

function proofs(): ProofsService {
  return injector.get(ProofsService);
}

async function seedIntent(
  proofId: string,
  overrides: Partial<{
    operation: AnchoringOperation;
    status: AnchoringStatus;
    attemptCount: number;
    permanentError: boolean;
    lastErrorSafe: string | null;
  }> = {},
) {
  return db.prisma.anchoringIntent.create({
    data: {
      proofId,
      operation: overrides.operation ?? AnchoringOperation.REGISTER,
      status: overrides.status ?? AnchoringStatus.QUARANTINED,
      attemptCount: overrides.attemptCount ?? 10,
      permanentError: overrides.permanentError ?? true,
      lastErrorSafe: overrides.lastErrorSafe ?? "[REDACTED_ADDRESS]: insufficient balance",
    },
  });
}

describe("proof anchoring status", () => {
  it("returns the owner's anchoring intents", async () => {
    const user = await seedUser(db.prisma, "anchoring-status-owner");
    const proof = await seedProof(db.prisma, "anchoring-status-proof", user.id);
    await seedIntent(proof.id);

    const authenticated: AuthenticatedUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    };

    const result = await proofs().getProofAnchoringStatus(authenticated, proof.id);

    expect(result.proofId).toBe(proof.id);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]).toMatchObject({
      operation: AnchoringOperation.REGISTER,
      status: AnchoringStatus.QUARANTINED,
      permanentError: true,
    });
  });

  it("refuses to reveal anchoring status for a proof owned by someone else", async () => {
    const owner = await seedUser(db.prisma, "anchoring-status-real-owner");
    const stranger = await seedUser(db.prisma, "anchoring-status-stranger");
    const proof = await seedProof(db.prisma, "anchoring-status-hidden-proof", owner.id);
    await seedIntent(proof.id);

    await expect(
      proofs().getProofAnchoringStatus(stranger, proof.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("lets an administrator view any proof's anchoring status", async () => {
    const owner = await seedUser(db.prisma, "anchoring-status-owner-2");
    const admin = await seedUser(db.prisma, "anchoring-status-admin", { role: "ADMIN" });
    const proof = await seedProof(db.prisma, "anchoring-status-admin-proof", owner.id);
    await seedIntent(proof.id);

    const result = await proofs().getProofAnchoringStatus(admin, proof.id);
    expect(result.intents).toHaveLength(1);
  });
});

describe("proof anchoring retry", () => {
  it("redrives a quarantined intent and records an audit row, committed together", async () => {
    const user = await seedUser(db.prisma, "anchoring-retry-owner");
    const proof = await seedProof(db.prisma, "anchoring-retry-proof", user.id);
    const intent = await seedIntent(proof.id);

    const authenticated: AuthenticatedUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    };

    const result = await proofs().retryProofAnchoring(authenticated, proof.id, intent.id);

    expect(result.status).toBe(AnchoringStatus.PENDING);
    expect(result.attemptCount).toBe(10); // preserved, not reset

    const stored = await db.prisma.anchoringIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(stored.status).toBe(AnchoringStatus.PENDING);
    expect(stored.permanentError).toBe(false);
    expect(stored.nextRetryAt).not.toBeNull();

    const audit = await db.prisma.auditLog.findFirst({
      where: { action: "anchoring_intent.retried", resourceId: proof.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(user.id);
  });

  it("refuses to retry an intent that is not quarantined", async () => {
    const user = await seedUser(db.prisma, "anchoring-retry-pending-owner");
    const proof = await seedProof(db.prisma, "anchoring-retry-pending-proof", user.id);
    const intent = await seedIntent(proof.id, {
      status: AnchoringStatus.PENDING,
      permanentError: false,
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
    expect(stored.status).toBe(AnchoringStatus.PENDING);
  });

  it("refuses a retry request for an intent belonging to a different proof", async () => {
    const user = await seedUser(db.prisma, "anchoring-retry-crosscheck-owner");
    const proofA = await seedProof(db.prisma, "anchoring-retry-crosscheck-a", user.id);
    const proofB = await seedProof(db.prisma, "anchoring-retry-crosscheck-b", user.id);
    const intentOnB = await seedIntent(proofB.id);

    const authenticated: AuthenticatedUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    };

    await expect(
      proofs().retryProofAnchoring(authenticated, proofA.id, intentOnB.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses a retry for a proof owned by someone else", async () => {
    const owner = await seedUser(db.prisma, "anchoring-retry-real-owner");
    const stranger = await seedUser(db.prisma, "anchoring-retry-stranger");
    const proof = await seedProof(db.prisma, "anchoring-retry-hidden-proof", owner.id);
    const intent = await seedIntent(proof.id);

    await expect(
      proofs().retryProofAnchoring(stranger, proof.id, intent.id),
    ).rejects.toBeInstanceOf(NotFoundException);

    const stored = await db.prisma.anchoringIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(stored.status).toBe(AnchoringStatus.QUARANTINED);
  });
});
