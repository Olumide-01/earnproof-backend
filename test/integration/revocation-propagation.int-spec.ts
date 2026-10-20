import { AnchoringOperation, AnchoringStatus, ProofStatus, WebhookDeliveryStatus } from "@prisma/client";
import { integrationDatabase } from "./harness/database";
import { seedOrganization, seedUser, seedWebhook } from "./harness/fixtures";
import { WebhookDeadLetterService } from "../../src/webhooks/webhook-dead-letter.service";
import { RevocationPropagationReconcilerService } from "../../src/jobs/revocation-propagation-reconciler.service";

/**
 * Revocation propagation reconciliation (issue #212).
 *
 * `RevocationPropagationReconcilerService` correlates a revoked proof's two
 * independent downstream channels (an on-chain REVOKE anchoring intent, and
 * the `proof.revoked` webhook delivery to each subscribed endpoint) and only
 * persists `revocationPropagationConfirmedAt` once both are confirmed. That
 * correlation and the webhook-channel auto-redrive are properties of the real
 * schema (the AnchoringIntent compound unique, the WebhookDelivery JSON
 * payload path query, the redrive claim's conditional update), so they are
 * exercised against Postgres rather than a mocked Prisma client.
 *
 * The webhook delivery's own re-dispatch after a redrive is stubbed (not
 * exercised here — that is `WebhookDeliveryService`'s own concern, covered by
 * its unit suite); this test asserts on the persisted rows the redrive claim
 * itself produces.
 */

const db = integrationDatabase();

function makeConfig(anchoringEnabled = true) {
  return { get: jest.fn((key: string) => (key === "contractAnchoring.enabled" ? anchoringEnabled : undefined)) };
}

function makeMetrics() {
  return { increment: jest.fn(), observe: jest.fn() };
}

function makeReconciler(anchoringEnabled = true) {
  const deadLetters = new WebhookDeadLetterService(
    db.prisma as never,
    { dispatch: jest.fn() } as never,
    { get: jest.fn().mockReturnValue(undefined) } as never,
  );
  return new RevocationPropagationReconcilerService(
    db.prisma as never,
    deadLetters,
    makeMetrics() as never,
    makeConfig(anchoringEnabled) as never,
  );
}

async function seedRevokedProof(
  seed: string,
  userId: string,
  overrides: { contractTransactionHash?: string | null; supersedesId?: string } = {},
) {
  return db.prisma.proof.create({
    data: {
      id: `synthetic_proof_${seed}`,
      userId,
      proofType: "MINIMUM_INCOME",
      schemaVersion: "earnproof.minimum-income.v1",
      status: ProofStatus.REVOKED,
      network: "testnet",
      assetCode: "USDC",
      expiresAt: new Date(Date.now() + 86_400_000),
      credentialHash: `sha256:synthetic_${seed}`,
      revokedAt: new Date(Date.now() - 10 * 60_000),
      contractTransactionHash: overrides.contractTransactionHash ?? null,
      supersedesId: overrides.supersedesId,
    },
  });
}

async function seedRevokeIntent(proofId: string, status: AnchoringStatus) {
  return db.prisma.anchoringIntent.create({
    data: { proofId, operation: AnchoringOperation.REVOKE, status },
  });
}

async function seedRevokedDelivery(
  webhookId: string,
  proofId: string,
  overrides: Partial<{ status: WebhookDeliveryStatus; deadLetteredAt: Date | null; redrivenAt: Date | null }> = {},
) {
  return db.prisma.webhookDelivery.create({
    data: {
      webhookId,
      eventType: "proof.revoked",
      eventId: `evt_${proofId}`,
      payload: { specVersion: "1", id: `evt_${proofId}`, event: "proof.revoked", createdAt: new Date().toISOString(), data: { proofId, status: "REVOKED", revokedAt: new Date().toISOString() } },
      status: overrides.status ?? WebhookDeliveryStatus.FAILED,
      deadLetteredAt: overrides.deadLetteredAt ?? null,
      redrivenAt: overrides.redrivenAt ?? null,
    },
  });
}

describe("revocation propagation reconciliation", () => {
  it("partial failure: anchoring confirmed but webhook still pending leaves the proof unconfirmed", async () => {
    const user = await seedUser(db.prisma, "prop-partial");
    const proof = await seedRevokedProof("partial", user.id, { contractTransactionHash: "tx_partial" });
    await seedRevokeIntent(proof.id, AnchoringStatus.CONFIRMED);

    const organization = await seedOrganization(db.prisma, "prop-partial", user.id);
    const webhook = await seedWebhook(db.prisma, "prop-partial", organization.id);
    await seedRevokedDelivery(webhook.id, proof.id, { status: WebhookDeliveryStatus.PENDING });

    const reconciler = makeReconciler();
    await reconciler.reconcileProof({
      id: proof.id,
      userId: user.id,
      revokedAt: proof.revokedAt,
      contractTransactionHash: proof.contractTransactionHash,
    });

    const after = await db.prisma.proof.findUnique({ where: { id: proof.id } });
    expect(after?.revocationPropagationConfirmedAt).toBeNull();
  });

  it("replay: redriving a dead letter twice in a row only creates one redrive (idempotent)", async () => {
    const user = await seedUser(db.prisma, "prop-replay");
    const proof = await seedRevokedProof("replay", user.id);

    const organization = await seedOrganization(db.prisma, "prop-replay", user.id);
    const webhook = await seedWebhook(db.prisma, "prop-replay", organization.id);
    await seedRevokedDelivery(webhook.id, proof.id, { deadLetteredAt: new Date() });

    const reconciler = makeReconciler();
    const input = {
      id: proof.id,
      userId: user.id,
      revokedAt: proof.revokedAt,
      contractTransactionHash: proof.contractTransactionHash,
    };

    await reconciler.reconcileProof(input);
    await reconciler.reconcileProof(input);

    const redriveRows = await db.prisma.webhookDelivery.findMany({
      where: { webhookId: webhook.id, replayOf: { not: null } },
    });
    expect(redriveRows).toHaveLength(1);
  });

  it("recovery: once the redriven delivery succeeds, the next cycle marks propagation confirmed", async () => {
    const user = await seedUser(db.prisma, "prop-recover");
    const proof = await seedRevokedProof("recover", user.id, { contractTransactionHash: "tx_recover" });
    await seedRevokeIntent(proof.id, AnchoringStatus.CONFIRMED);

    const organization = await seedOrganization(db.prisma, "prop-recover", user.id);
    const webhook = await seedWebhook(db.prisma, "prop-recover", organization.id);
    const original = await seedRevokedDelivery(webhook.id, proof.id, { deadLetteredAt: new Date() });

    const reconciler = makeReconciler();
    const input = {
      id: proof.id,
      userId: user.id,
      revokedAt: proof.revokedAt,
      contractTransactionHash: proof.contractTransactionHash,
    };

    // First cycle: redrives the dead letter.
    await reconciler.reconcileProof(input);
    const redriven = await db.prisma.webhookDelivery.findFirst({
      where: { replayOf: original.id },
    });
    expect(redriven).not.toBeNull();

    // Simulate the redriven attempt succeeding.
    await db.prisma.webhookDelivery.update({
      where: { id: redriven!.id },
      data: { status: WebhookDeliveryStatus.SUCCESS },
    });

    // Second cycle: both channels now confirmed.
    await reconciler.reconcileProof(input);

    const after = await db.prisma.proof.findUnique({ where: { id: proof.id } });
    expect(after?.revocationPropagationConfirmedAt).not.toBeNull();
  });

  it("superseded proofs: a revoked proof's own propagation reconciles independently of its supersession chain", async () => {
    const user = await seedUser(db.prisma, "prop-superseded");
    const predecessor = await seedRevokedProof("superseded-pred", user.id);
    const successor = await seedRevokedProof("superseded-succ", user.id, {
      supersedesId: predecessor.id,
    });

    const reconciler = makeReconciler();

    await reconciler.reconcileProof({
      id: predecessor.id,
      userId: user.id,
      revokedAt: predecessor.revokedAt,
      contractTransactionHash: predecessor.contractTransactionHash,
    });
    await reconciler.reconcileProof({
      id: successor.id,
      userId: user.id,
      revokedAt: successor.revokedAt,
      contractTransactionHash: successor.contractTransactionHash,
    });

    const [predAfter, succAfter] = await Promise.all([
      db.prisma.proof.findUnique({ where: { id: predecessor.id } }),
      db.prisma.proof.findUnique({ where: { id: successor.id } }),
    ]);

    // Neither was anchored and neither has a subscribed webhook, so both
    // channels are trivially confirmed for each proof independently.
    expect(predAfter?.revocationPropagationConfirmedAt).not.toBeNull();
    expect(succAfter?.revocationPropagationConfirmedAt).not.toBeNull();
    expect(succAfter?.supersedesId).toBe(predecessor.id);
  });

  it("batch query only selects proofs not yet confirmed, oldest revoked first", async () => {
    const user = await seedUser(db.prisma, "prop-batch");
    const older = await seedRevokedProof("batch-older", user.id);
    await db.prisma.proof.update({
      where: { id: older.id },
      data: { revokedAt: new Date(Date.now() - 60 * 60_000) },
    });
    const newer = await seedRevokedProof("batch-newer", user.id);
    const alreadyConfirmed = await seedRevokedProof("batch-confirmed", user.id);
    await db.prisma.proof.update({
      where: { id: alreadyConfirmed.id },
      data: { revocationPropagationConfirmedAt: new Date() },
    });

    const candidates = await db.prisma.proof.findMany({
      where: { status: ProofStatus.REVOKED, revocationPropagationConfirmedAt: null, id: { in: [older.id, newer.id, alreadyConfirmed.id] } },
      orderBy: { revokedAt: "asc" },
      select: { id: true },
    });

    expect(candidates.map((p) => p.id)).toEqual([older.id, newer.id]);
  });
});
