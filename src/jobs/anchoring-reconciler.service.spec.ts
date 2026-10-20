import { AnchoringOperation, AnchoringStatus, ProofStatus } from "@prisma/client";
import { AnchoringReconcilerService } from "./anchoring-reconciler.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(enabled = true) {
  return {
    get: jest.fn((key: string) => {
      if (key === "contractAnchoring.enabled") return enabled;
      return undefined;
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
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnchoringReconcilerService", () => {
  describe("reconcileProof — on-chain/local agreement", () => {
    it("takes no action when ACTIVE proof is valid and not revoked on-chain", async () => {
      const prisma = makePrisma();
      const anchoring = {
        getProofStatus: jest.fn().mockResolvedValue({
          checked: true,
          revoked: false,
          valid: true,
        }),
      };
      const reconciler = new AnchoringReconcilerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof({
        id: "proof_1",
        status: ProofStatus.ACTIVE,
        contractTransactionHash: "tx_1",
      });

      expect(prisma.proof.update).not.toHaveBeenCalled();
      expect(prisma.anchoringIntent.create).not.toHaveBeenCalled();
    });

    it("takes no action when REVOKED proof is also revoked on-chain", async () => {
      const prisma = makePrisma();
      const anchoring = {
        getProofStatus: jest.fn().mockResolvedValue({
          checked: true,
          revoked: true,
          valid: false,
        }),
      };
      const reconciler = new AnchoringReconcilerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof({
        id: "proof_1",
        status: ProofStatus.REVOKED,
        contractTransactionHash: "tx_1",
      });

      expect(prisma.proof.update).not.toHaveBeenCalled();
      expect(prisma.anchoringIntent.create).not.toHaveBeenCalled();
    });
  });

  describe("reconcileProof — auto-repair cases", () => {
    it("auto-repairs: marks ACTIVE proof REVOKED when on-chain state is revoked=true", async () => {
      const prisma = makePrisma();
      const anchoring = {
        getProofStatus: jest.fn().mockResolvedValue({
          checked: true,
          revoked: true,
          valid: false,
        }),
      };
      const reconciler = new AnchoringReconcilerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof({
        id: "proof_1",
        status: ProofStatus.ACTIVE,
        contractTransactionHash: "tx_1",
      });

      expect(prisma.proof.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "proof_1" },
          data: expect.objectContaining({ status: ProofStatus.REVOKED }),
        }),
      );
    });

    it("auto-repairs: re-enqueues REVOKE when REVOKED proof is not revoked on-chain", async () => {
      const prisma = makePrisma();
      const anchoring = {
        getProofStatus: jest.fn().mockResolvedValue({
          checked: true,
          revoked: false,
          valid: true,
        }),
      };
      const reconciler = new AnchoringReconcilerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof({
        id: "proof_1",
        status: ProofStatus.REVOKED,
        contractTransactionHash: "tx_1",
      });

      expect(prisma.anchoringIntent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            proofId: "proof_1",
            operation: AnchoringOperation.REVOKE,
            status: AnchoringStatus.PENDING,
          }),
        }),
      );
    });

    it("does NOT create duplicate REVOKE intents when one is already pending", async () => {
      const prisma = makePrisma();
      // Simulate an existing pending REVOKE intent.
      prisma.anchoringIntent.findFirst = jest.fn().mockResolvedValue({
        id: "existing_intent",
        operation: AnchoringOperation.REVOKE,
        status: AnchoringStatus.PENDING,
      });
      const anchoring = {
        getProofStatus: jest.fn().mockResolvedValue({
          checked: true,
          revoked: false,
          valid: true,
        }),
      };
      const reconciler = new AnchoringReconcilerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof({
        id: "proof_1",
        status: ProofStatus.REVOKED,
        contractTransactionHash: "tx_1",
      });

      expect(prisma.anchoringIntent.create).not.toHaveBeenCalled();
    });
  });

  describe("reconcileProof — manual attention cases", () => {
    it("flags for manual review when ACTIVE proof is on-chain invalid (valid=false, revoked=false)", async () => {
      const prisma = makePrisma();
      const anchoring = {
        getProofStatus: jest.fn().mockResolvedValue({
          checked: true,
          revoked: false,
          valid: false,
        }),
      };
      const reconciler = new AnchoringReconcilerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof({
        id: "proof_1",
        status: ProofStatus.ACTIVE,
        contractTransactionHash: "tx_1",
      });

      // Should NOT auto-repair (no status update).
      expect(prisma.proof.update).not.toHaveBeenCalled();
      // Should create a QUARANTINED intent for operator visibility.
      expect(prisma.anchoringIntent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            proofId: "proof_1",
            status: AnchoringStatus.QUARANTINED,
            permanentError: true,
            quarantineReasonCode: "MANUAL_REVIEW",
            quarantineDecision: "PENDING",
          }),
        }),
      );
    });

    it("does NOT create duplicate manual-review intents when one already exists", async () => {
      const prisma = makePrisma();
      prisma.anchoringIntent.findFirst = jest.fn().mockResolvedValue({
        id: "existing_flag",
      });
      const anchoring = {
        getProofStatus: jest.fn().mockResolvedValue({
          checked: true,
          revoked: false,
          valid: false,
        }),
      };
      const reconciler = new AnchoringReconcilerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof({
        id: "proof_1",
        status: ProofStatus.ACTIVE,
        contractTransactionHash: "tx_1",
      });

      expect(prisma.anchoringIntent.create).not.toHaveBeenCalled();
    });
  });

  describe("reconcileProof — unreachable contract", () => {
    it("skips silently when getProofStatus cannot check (network error)", async () => {
      const prisma = makePrisma();
      const anchoring = {
        getProofStatus: jest.fn().mockResolvedValue({
          checked: false,
          reason: "failed",
          error: "timeout",
        }),
      };
      const reconciler = new AnchoringReconcilerService(
        prisma as never,
        anchoring as never,
        makeConfig() as never,
      );

      await reconciler.reconcileProof({
        id: "proof_1",
        status: ProofStatus.ACTIVE,
        contractTransactionHash: "tx_1",
      });

      expect(prisma.proof.update).not.toHaveBeenCalled();
      expect(prisma.anchoringIntent.create).not.toHaveBeenCalled();
    });
  });

  describe("reconcile — disabled", () => {
    it("does not query proofs when anchoring is disabled", async () => {
      const prisma = makePrisma();
      const anchoring = { getProofStatus: jest.fn() };
      const reconciler = new AnchoringReconcilerService(
        prisma as never,
        anchoring as never,
        makeConfig(false) as never,
      );

      await reconciler.reconcile();

      expect(prisma.proof.findMany).not.toHaveBeenCalled();
    });
  });
});
