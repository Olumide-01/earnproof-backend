import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ProofStatus, ProofType } from "@prisma/client";
import { VerificationEventService } from "../../src/audit/verification-event.service";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { ProofsService } from "../../src/proofs/proofs.service";
import { integrationDatabase } from "./harness/database";
import { integrationModule } from "./harness/nest";
import {
  isUniqueViolation,
  seedPayment,
  seedProof,
  seedSupportedAsset,
  seedUser,
  violatedTarget,
} from "./harness/fixtures";

/**
 * Proof creation and revocation against real PostgreSQL.
 *
 * The unit suite already covers the branching in `ProofsService` with a mocked
 * Prisma client. What it cannot cover is whether the writes it issues are
 * legal: `createMinimumIncomeProof` writes a `Proof` and a nested `ProofClaim`
 * inside one interactive transaction, and a mock accepts that whether or not
 * the foreign key, the unique index on `credentialHash`, and the enum types
 * actually exist. Those are properties of the migrated schema, so they can only
 * be tested here.
 */

const db = integrationDatabase();
const injector = integrationModule([ProofsService, VerificationEventService]);

const PERIOD_START = "2025-01-01T00:00:00.000Z";
const PERIOD_END = "2025-01-31T23:59:59.000Z";

function proofs(): ProofsService {
  return injector.get(ProofsService);
}

/** A user with two eligible income payments inside the proof period. */
async function userWithIncome(seed: string) {
  const user = await seedUser(db.prisma, seed);

  // Proof issuance re-validates eligibility against the live SupportedAsset
  // registry inside the write transaction, so USDC must be an active
  // registry entry for these payments to be usable for issuance.
  await seedSupportedAsset(db.prisma, seed, { code: "USDC" });

  const first = await seedPayment(db.prisma, `${seed}-1`, user.id, {
    amount: "600.0000000",
    assetCode: "USDC",
    assetIssuer: null,
    classification: "INCOME",
    isEligible: true,
    occurredAt: new Date("2025-01-10T00:00:00.000Z"),
  });

  const second = await seedPayment(db.prisma, `${seed}-2`, user.id, {
    amount: "400.0000000",
    assetCode: "USDC",
    assetIssuer: null,
    classification: "INCOME",
    isEligible: true,
    occurredAt: new Date("2025-01-20T00:00:00.000Z"),
  });

  const authenticated: AuthenticatedUser = {
    id: user.id,
    walletAddress: user.walletAddress,
    walletHash: user.walletHash,
    role: user.role,
  };

  return { user, authenticated, paymentIds: [first.row.id, second.row.id] };
}

describe("proof creation", () => {
  it("persists the proof and its claim in one transaction", async () => {
    const { authenticated, paymentIds } = await userWithIncome("proof-create");

    const result = await proofs().createMinimumIncomeProof(authenticated, {
      selectedPaymentIds: paymentIds,
      thresholdAmount: "1000.0000000",
      assetCode: "USDC",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const stored = await db.prisma.proof.findUniqueOrThrow({
      where: { id: result.proofId },
      include: { claim: true },
    });

    expect(stored.status).toBe(ProofStatus.ACTIVE);
    expect(stored.proofType).toBe(ProofType.MINIMUM_INCOME);
    expect(stored.userId).toBe(authenticated.id);
    expect(stored.claim).not.toBeNull();
    expect(stored.claim?.operator).toBe("gte");
    expect(stored.claim?.result).toBe(true);
  });

  it("does not disclose the exact income in the stored disclosure policy", async () => {
    const { authenticated, paymentIds } = await userWithIncome("proof-privacy");

    const result = await proofs().createMinimumIncomeProof(authenticated, {
      selectedPaymentIds: paymentIds,
      thresholdAmount: "1000.0000000",
      assetCode: "USDC",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const claim = await db.prisma.proofClaim.findUniqueOrThrow({
      where: { proofId: result.proofId },
    });

    // The policy is stored as JSONB, so this asserts on what PostgreSQL
    // actually round-tripped, not on what the service built in memory.
    expect(claim.disclosurePolicy).toEqual({
      exactIncomeHidden: true,
      sourceTransactionsHidden: true,
      qualifyingPaymentCount: 2,
    });
    // The sum of the selected payments is 1000; it must appear nowhere.
    expect(JSON.stringify(claim.disclosurePolicy)).not.toContain("1000");
  });

  it("rolls back the whole proof when the credential hash collides", async () => {
    const { user } = await userWithIncome("proof-collision");
    const existing = await seedProof(db.prisma, "proof-collision-a", user.id);

    const duplicate = db.prisma.proof.create({
      data: {
        userId: user.id,
        proofType: ProofType.MINIMUM_INCOME,
        schemaVersion: "earnproof.minimum-income.v1",
        network: "testnet",
        assetCode: "USDC",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        credentialHash: existing.credentialHash,
        claim: {
          create: {
            operator: "gte",
            result: true,
            disclosurePolicy: { exactIncomeHidden: true },
          },
        },
      },
    });

    const error = await duplicate.catch((thrown: unknown) => thrown);

    expect(isUniqueViolation(error)).toBe(true);
    expect(violatedTarget(error)).toContain("credentialHash");

    // The nested claim is written in the same implicit transaction as the
    // proof, so a rejected proof must leave no orphaned claim behind.
    expect(await db.prisma.proof.count()).toBe(1);
    expect(await db.prisma.proofClaim.count()).toBe(0);
  });

  it("refuses a proof for a payment belonging to another user", async () => {
    const owner = await userWithIncome("proof-owner");
    const stranger = await seedUser(db.prisma, "proof-stranger");

    await expect(
      proofs().createMinimumIncomeProof(
        {
          id: stranger.id,
          walletAddress: stranger.walletAddress,
          walletHash: stranger.walletHash,
          role: stranger.role,
        },
        {
          selectedPaymentIds: owner.paymentIds,
          thresholdAmount: "1000.0000000",
          assetCode: "USDC",
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
        },
      ),
    ).rejects.toThrow();

    expect(await db.prisma.proof.count()).toBe(0);
  });
});

describe("income-range proof creation", () => {
  // Structurally validated against the same integration harness used above,
  // but — like the rest of this file — requires a live PostgreSQL instance
  // (see docs/integration-testing.md) and could not be executed in this
  // sandbox, which has no reachable database.
  it("persists the proof and claim, and never discloses the exact sum", async () => {
    const { authenticated, paymentIds } = await userWithIncome("income-range-create");

    const result = await proofs().createIncomeRangeProof(authenticated, {
      selectedPaymentIds: paymentIds,
      lowerBound: "500.0000000",
      upperBound: "1500.0000000",
      assetCode: "USDC",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const stored = await db.prisma.proof.findUniqueOrThrow({
      where: { id: result.proofId },
      include: { claim: true },
    });

    expect(stored.status).toBe(ProofStatus.ACTIVE);
    expect(stored.proofType).toBe(ProofType.INCOME_RANGE);
    expect(stored.userId).toBe(authenticated.id);
    expect(stored.claim?.operator).toBe("range");
    expect(stored.claim?.result).toBe(true);
    expect(stored.claim?.disclosurePolicy).toEqual({
      exactIncomeHidden: true,
      sourceTransactionsHidden: true,
      qualifyingPaymentCount: 2,
      lowerBound: "500.0000000",
      upperBound: "1500.0000000",
    });
    // The sum of the selected payments is 1000; it must appear nowhere.
    expect(JSON.stringify(stored.claim?.disclosurePolicy)).not.toContain(
      "1000",
    );
    expect(JSON.stringify(result.credential)).not.toContain("1000.0000000");
  });

  it("rejects an inverted range end-to-end", async () => {
    const { authenticated, paymentIds } = await userWithIncome(
      "income-range-inverted",
    );

    await expect(
      proofs().createIncomeRangeProof(authenticated, {
        selectedPaymentIds: paymentIds,
        lowerBound: "1500.0000000",
        upperBound: "500.0000000",
        assetCode: "USDC",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    ).rejects.toThrow("lowerBound must be strictly less than upperBound");
  });

  it("rejects a payment sum outside the requested range end-to-end", async () => {
    const { authenticated, paymentIds } = await userWithIncome(
      "income-range-outside",
    );

    await expect(
      proofs().createIncomeRangeProof(authenticated, {
        selectedPaymentIds: paymentIds,
        lowerBound: "1100.0000000",
        upperBound: "2000.0000000",
        assetCode: "USDC",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    ).rejects.toThrow("do not fall within the requested income range");
  });

  it("refuses a range proof for a payment belonging to another user", async () => {
    const owner = await userWithIncome("income-range-owner");
    const stranger = await seedUser(db.prisma, "income-range-stranger");

    await expect(
      proofs().createIncomeRangeProof(
        {
          id: stranger.id,
          walletAddress: stranger.walletAddress,
          walletHash: stranger.walletHash,
          role: stranger.role,
        },
        {
          selectedPaymentIds: owner.paymentIds,
          lowerBound: "500.0000000",
          upperBound: "1500.0000000",
          assetCode: "USDC",
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
        },
      ),
    ).rejects.toThrow();

    expect(await db.prisma.proof.count()).toBe(0);
  });
});

describe("proof revocation", () => {
  it("marks the proof revoked and stamps the time", async () => {
    const { user, authenticated, paymentIds } = await userWithIncome("proof-revoke");

    const created = await proofs().createMinimumIncomeProof(authenticated, {
      selectedPaymentIds: paymentIds,
      thresholdAmount: "1000.0000000",
      assetCode: "USDC",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });

    const revoked = await proofs().revokeProof(authenticated, created.proofId);
    expect(revoked.status).toBe(ProofStatus.REVOKED);
    expect(revoked.revokedByType).toBe("OWNER");
    expect(revoked.revocationReasonCode).toBe("OWNER_REQUESTED");

    const stored = await db.prisma.proof.findUniqueOrThrow({
      where: { id: created.proofId },
    });
    expect(stored.status).toBe(ProofStatus.REVOKED);
    expect(stored.revokedAt).toBeInstanceOf(Date);
    expect(stored.revokedById).toBe(user.id);
  });

  it("refuses to revoke a proof owned by someone else", async () => {
    const owner = await seedUser(db.prisma, "revoke-owner");
    const stranger = await seedUser(db.prisma, "revoke-stranger");
    const proof = await seedProof(db.prisma, "revoke-target", owner.id);

    await expect(proofs().revokeProof(stranger, proof.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const stored = await db.prisma.proof.findUniqueOrThrow({ where: { id: proof.id } });
    expect(stored.status).toBe(ProofStatus.ACTIVE);
    expect(stored.revokedAt).toBeNull();
  });

  it("allows an administrator to revoke a proof they do not own", async () => {
    const owner = await seedUser(db.prisma, "revoke-admin-owner");
    const admin = await seedUser(db.prisma, "revoke-admin-actor", { role: "ADMIN" });
    const proof = await seedProof(db.prisma, "revoke-admin-target", owner.id);

    const revoked = await proofs().revokeProof(admin, proof.id, {
      reasonCode: "COMPLIANCE_HOLD",
    });

    expect(revoked.status).toBe(ProofStatus.REVOKED);
    expect(revoked.revokedByType).toBe("ADMIN");
    expect(revoked.revocationReasonCode).toBe("COMPLIANCE_HOLD");

    const stored = await db.prisma.proof.findUniqueOrThrow({ where: { id: proof.id } });
    expect(stored.revokedById).toBe(admin.id);
  });

  it("reports a missing proof rather than silently succeeding", async () => {
    const user = await seedUser(db.prisma, "revoke-missing");

    await expect(
      proofs().revokeProof(user, "proof_that_was_never_created"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("is idempotent enough to survive a repeated revocation", async () => {
    const user = await seedUser(db.prisma, "revoke-twice");
    const proof = await seedProof(db.prisma, "revoke-twice-target", user.id);

    const first = await proofs().revokeProof(user, proof.id, {
      reasonCode: "DUPLICATE_PROOF",
      reasonPrivate: "first call",
    });
    const second = await proofs().revokeProof(user, proof.id, {
      reasonCode: "FRAUD_SUSPECTED",
      reasonPrivate: "second call should not overwrite",
    });

    expect(first.status).toBe(ProofStatus.REVOKED);
    expect(second.status).toBe(ProofStatus.REVOKED);
    // The second call must not overwrite the original revocation metadata.
    expect(second.revocationReasonCode).toBe("DUPLICATE_PROOF");
    expect(second.revocationReasonPrivate).toBe("first call");
    expect(await db.prisma.proof.count()).toBe(1);

    const stored = await db.prisma.proof.findUniqueOrThrow({ where: { id: proof.id } });
    expect(stored.revocationReasonCode).toBe("DUPLICATE_PROOF");
    expect(stored.revocationReasonPrivate).toBe("first call");
  });
});

describe("proof foreign keys", () => {
  it("refuses a proof whose owner does not exist", async () => {
    const orphan = db.prisma.proof.create({
      data: {
        userId: "user_that_does_not_exist",
        proofType: ProofType.MINIMUM_INCOME,
        schemaVersion: "earnproof.minimum-income.v1",
        network: "testnet",
        assetCode: "USDC",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        credentialHash: "sha256:syntheticorphan",
      },
    });

    await expect(orphan).rejects.toMatchObject({ code: "P2003" });
    expect(await db.prisma.proof.count()).toBe(0);
  });
});
