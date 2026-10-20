import { AnchoringStatus } from "@prisma/client";
import { RevocationPropagationReconcilerService } from "./revocation-propagation-reconciler.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(anchoringEnabled = true) {
  return {
    get: jest.fn((key: string) => {
      if (key === "contractAnchoring.enabled") return anchoringEnabled;
      return undefined;
    }),
  };
}

function makeMetrics() {
  return {
    increment: jest.fn(),
    observe: jest.fn(),
  };
}

function makeDeadLetters(redriveOutcome: "redriven" | "already_redriven" = "redriven") {
  return {
    redrive: jest.fn().mockResolvedValue({
      deliveryId: "delivery_1",
      outcome: redriveOutcome,
      redriveDeliveryId: "delivery_2",
    }),
  };
}

function makePrisma() {
  return {
    proof: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    anchoringIntent: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    webhookDelivery: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

const PROOF = {
  id: "proof_1",
  userId: "user_1",
  revokedAt: new Date(Date.now() - 10 * 60_000),
  contractTransactionHash: "tx_1",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RevocationPropagationReconcilerService", () => {
  describe("anchoring channel", () => {
    it("treats a proof that was never anchored as confirmed on the anchoring channel", async () => {
      const prisma = makePrisma();
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        makeDeadLetters() as never,
        makeMetrics() as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof({ ...PROOF, contractTransactionHash: null });

      expect(prisma.anchoringIntent.findUnique).not.toHaveBeenCalled();
    });

    it("treats anchoring as confirmed when the REVOKE intent is CONFIRMED", async () => {
      const prisma = makePrisma();
      prisma.anchoringIntent.findUnique.mockResolvedValue({
        status: AnchoringStatus.CONFIRMED,
      });
      const metrics = makeMetrics();
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        makeDeadLetters() as never,
        metrics as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof(PROOF);

      expect(metrics.increment).toHaveBeenCalledWith(
        expect.any(String),
        { channel: "anchoring", propagation_state: "confirmed" },
      );
    });

    it("reports pending (partial failure) without taking action when the REVOKE intent is still PENDING", async () => {
      const prisma = makePrisma();
      prisma.anchoringIntent.findUnique.mockResolvedValue({
        status: AnchoringStatus.PENDING,
      });
      const metrics = makeMetrics();
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        makeDeadLetters() as never,
        metrics as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof(PROOF);

      expect(metrics.increment).toHaveBeenCalledWith(
        expect.any(String),
        { channel: "anchoring", propagation_state: "pending" },
      );
      expect(prisma.proof.update).not.toHaveBeenCalled();
    });

    it("does not evaluate the anchoring channel at all when anchoring is disabled", async () => {
      const prisma = makePrisma();
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        makeDeadLetters() as never,
        makeMetrics() as never,
        makeConfig(false) as never,
      );

      await reconciler.reconcileProof(PROOF);

      expect(prisma.anchoringIntent.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("webhook channel", () => {
    it("treats a proof with no subscribed webhook deliveries as confirmed (not applicable)", async () => {
      const prisma = makePrisma();
      const deadLetters = makeDeadLetters();
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        deadLetters as never,
        makeMetrics() as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof(PROOF);

      expect(deadLetters.redrive).not.toHaveBeenCalled();
    });

    it("treats the webhook channel as confirmed when the latest delivery succeeded", async () => {
      const prisma = makePrisma();
      prisma.webhookDelivery.findMany.mockResolvedValue([
        { id: "d1", webhookId: "wh_1", status: "SUCCESS", deadLetteredAt: null, redrivenAt: null, createdAt: new Date(), webhook: { organizationId: "org_1" } },
      ]);
      const metrics = makeMetrics();
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        makeDeadLetters() as never,
        metrics as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof(PROOF);

      expect(metrics.increment).toHaveBeenCalledWith(
        expect.any(String),
        { channel: "webhook", propagation_state: "confirmed" },
      );
    });

    it("auto-redrives a dead-lettered proof.revoked delivery that has not yet been redriven (recovery path)", async () => {
      const prisma = makePrisma();
      prisma.webhookDelivery.findMany.mockResolvedValue([
        {
          id: "d1",
          webhookId: "wh_1",
          status: "FAILED",
          deadLetteredAt: new Date(),
          redrivenAt: null,
          createdAt: new Date(),
          webhook: { organizationId: "org_1" },
        },
      ]);
      const deadLetters = makeDeadLetters("redriven");
      const metrics = makeMetrics();
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        deadLetters as never,
        metrics as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof(PROOF);

      expect(deadLetters.redrive).toHaveBeenCalledWith(
        "org_1",
        "d1",
        expect.stringContaining("system"),
        expect.any(String),
      );
      expect(metrics.increment).toHaveBeenCalledWith(
        expect.any(String),
        { channel: "webhook", propagation_state: "remediated" },
      );
    });

    it("does not re-redrive a dead letter that was already redriven (replay safety)", async () => {
      const prisma = makePrisma();
      prisma.webhookDelivery.findMany.mockResolvedValue([
        {
          id: "d1",
          webhookId: "wh_1",
          status: "FAILED",
          deadLetteredAt: new Date(),
          redrivenAt: new Date(),
          createdAt: new Date(Date.now() - 1000),
          webhook: { organizationId: "org_1" },
        },
      ]);
      const deadLetters = makeDeadLetters();
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        deadLetters as never,
        makeMetrics() as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof(PROOF);

      expect(deadLetters.redrive).not.toHaveBeenCalled();
    });

    it("takes the latest delivery per webhook when a chain has multiple rows (replay/retry history)", async () => {
      const prisma = makePrisma();
      prisma.webhookDelivery.findMany.mockResolvedValue([
        { id: "d1", webhookId: "wh_1", status: "FAILED", deadLetteredAt: null, redrivenAt: null, createdAt: new Date(Date.now() - 5000), webhook: { organizationId: "org_1" } },
        { id: "d2", webhookId: "wh_1", status: "SUCCESS", deadLetteredAt: null, redrivenAt: null, createdAt: new Date(), webhook: { organizationId: "org_1" } },
      ]);
      const metrics = makeMetrics();
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        makeDeadLetters() as never,
        metrics as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof(PROOF);

      expect(metrics.increment).toHaveBeenCalledWith(
        expect.any(String),
        { channel: "webhook", propagation_state: "confirmed" },
      );
    });
  });

  describe("overall confirmation", () => {
    it("marks revocationPropagationConfirmedAt once both channels are confirmed", async () => {
      const prisma = makePrisma();
      prisma.anchoringIntent.findUnique.mockResolvedValue({
        status: AnchoringStatus.CONFIRMED,
      });
      prisma.webhookDelivery.findMany.mockResolvedValue([
        { id: "d1", webhookId: "wh_1", status: "SUCCESS", deadLetteredAt: null, redrivenAt: null, createdAt: new Date(), webhook: { organizationId: "org_1" } },
      ]);
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        makeDeadLetters() as never,
        makeMetrics() as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof(PROOF);

      expect(prisma.proof.update).toHaveBeenCalledWith({
        where: { id: PROOF.id },
        data: { revocationPropagationConfirmedAt: expect.any(Date) },
      });
    });

    it("does not mark confirmed while the anchoring channel is still pending", async () => {
      const prisma = makePrisma();
      prisma.anchoringIntent.findUnique.mockResolvedValue({
        status: AnchoringStatus.PENDING,
      });
      prisma.webhookDelivery.findMany.mockResolvedValue([
        { id: "d1", webhookId: "wh_1", status: "SUCCESS", deadLetteredAt: null, redrivenAt: null, createdAt: new Date(), webhook: { organizationId: "org_1" } },
      ]);
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        makeDeadLetters() as never,
        makeMetrics() as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof(PROOF);

      expect(prisma.proof.update).not.toHaveBeenCalled();
    });

    it("does not mark confirmed in the same cycle a webhook redrive was just issued (remediation is not completion)", async () => {
      const prisma = makePrisma();
      prisma.anchoringIntent.findUnique.mockResolvedValue({
        status: AnchoringStatus.CONFIRMED,
      });
      prisma.webhookDelivery.findMany.mockResolvedValue([
        {
          id: "d1",
          webhookId: "wh_1",
          status: "FAILED",
          deadLetteredAt: new Date(),
          redrivenAt: null,
          createdAt: new Date(),
          webhook: { organizationId: "org_1" },
        },
      ]);
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        makeDeadLetters("redriven") as never,
        makeMetrics() as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof(PROOF);

      expect(prisma.proof.update).not.toHaveBeenCalled();
    });
  });

  describe("batch reconciliation (partial failure across a backlog)", () => {
    it("reconciles each candidate proof returned by the batch query independently", async () => {
      const prisma = makePrisma();
      prisma.proof.findMany.mockResolvedValue([
        { ...PROOF, id: "proof_a", contractTransactionHash: null },
        { ...PROOF, id: "proof_b", contractTransactionHash: null },
      ]);
      const reconciler = new RevocationPropagationReconcilerService(
        prisma as never,
        makeDeadLetters() as never,
        makeMetrics() as never,
        makeConfig() as never,
      );
      const spy = jest.spyOn(reconciler, "reconcileProof");

      await (reconciler as unknown as { reconcile: () => Promise<void> }).reconcile();

      expect(spy).toHaveBeenCalledTimes(2);
      expect(prisma.proof.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: "REVOKED", revocationPropagationConfirmedAt: null },
        }),
      );
    });
  });
});
