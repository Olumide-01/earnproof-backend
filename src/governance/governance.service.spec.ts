import { ConflictException } from "@nestjs/common";
import { ProposalLifecycleState } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { GovernanceService } from "./governance.service";

describe("GovernanceService", () => {
  let service: GovernanceService;
  let prisma: {
    contractGovernanceProposal: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      contractGovernanceProposal: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new GovernanceService(prisma as unknown as PrismaService);
  });

  describe("projectProposal", () => {
    it("should create new proposal when not existing", async () => {
      prisma.contractGovernanceProposal.findUnique.mockResolvedValue(null);
      prisma.contractGovernanceProposal.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: "prop-1",
          ...data,
          cooldownUntil: null,
          executedAt: null,
          cancelledAt: null,
          expiresAt: null,
          observedAt: new Date(),
        }),
      );

      const result = await service.projectProposal({
        network: "testnet",
        contractId: "C123",
        proposalId: "p-1",
        proposerAddress: "GPROPOSER",
        action: "UPGRADE_CONTRACT",
        actionPayload: { version: "2.0.0" },
        rawPayloadHash: "sha256:payloadhash",
        observedLedger: 100n,
      });

      expect(result.proposalId).toBe("p-1");
      expect(result.status).toBe(ProposalLifecycleState.PROPOSED);
      expect(result.isActionable).toBe(true);
    });

    it("should not regress terminal EXECUTED state on replayed event", async () => {
      prisma.contractGovernanceProposal.findUnique.mockResolvedValue({
        id: "prop-1",
        network: "testnet",
        contractId: "C123",
        proposalId: "p-1",
        status: ProposalLifecycleState.EXECUTED,
        observedLedger: 120n,
        action: "UPGRADE_CONTRACT",
        actionPayload: {},
        rawPayloadHash: "sha256:hash",
        proposerAddress: "GPROPOSER",
        cooldownUntil: null,
        executedAt: new Date(),
        cancelledAt: null,
        expiresAt: null,
        observedAt: new Date(),
      });

      const result = await service.projectProposal({
        network: "testnet",
        contractId: "C123",
        proposalId: "p-1",
        proposerAddress: "GPROPOSER",
        action: "UPGRADE_CONTRACT",
        actionPayload: {},
        rawPayloadHash: "sha256:hash",
        status: ProposalLifecycleState.PROPOSED,
        observedLedger: 110n, // older ledger replayed
      });

      expect(result.status).toBe(ProposalLifecycleState.EXECUTED);
      expect(prisma.contractGovernanceProposal.update).not.toHaveBeenCalled();
    });

    it("should mark proposal as non-actionable if action is UNKNOWN", async () => {
      prisma.contractGovernanceProposal.findUnique.mockResolvedValue(null);
      prisma.contractGovernanceProposal.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: "prop-2",
          ...data,
          cooldownUntil: null,
          executedAt: null,
          cancelledAt: null,
          expiresAt: null,
          observedAt: new Date(),
        }),
      );

      const result = await service.projectProposal({
        network: "testnet",
        contractId: "C123",
        proposalId: "p-2",
        proposerAddress: "GPROPOSER",
        action: "UNKNOWN",
        actionPayload: { rawBytes: "0xdeadbeef" },
        rawPayloadHash: "sha256:unknownhash",
        observedLedger: 100n,
      });

      expect(result.isActionable).toBe(false);
    });
  });

  describe("markExecuted and markCancelled", () => {
    it("should reject cancelling an already executed proposal", async () => {
      prisma.contractGovernanceProposal.findUnique.mockResolvedValue({
        id: "prop-1",
        status: ProposalLifecycleState.EXECUTED,
      });

      await expect(service.markCancelled("testnet", "C123", "p-1", 150n)).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
