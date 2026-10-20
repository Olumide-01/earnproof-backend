import { PrismaService } from "../database/prisma.service";
import { ProtocolPauseService } from "./protocol-pause.service";

describe("ProtocolPauseService", () => {
  let service: ProtocolPauseService;
  let prisma: {
    protocolPauseState: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      upsert: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      protocolPauseState: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
      },
    };
    service = new ProtocolPauseService(prisma as unknown as PrismaService);
  });

  describe("updatePauseState", () => {
    it("should upsert new pause state when not existing", async () => {
      prisma.protocolPauseState.findUnique.mockResolvedValue(null);
      prisma.protocolPauseState.upsert.mockImplementation(({ create }) =>
        Promise.resolve({
          id: "ps-1",
          ...create,
          lastCheckedAt: new Date(),
        }),
      );

      const result = await service.updatePauseState({
        network: "testnet",
        contractId: "CPAUSE123",
        isPaused: true,
        scopes: ["ISSUANCE", "ANCHORING"],
        incidentCommitment: "sha256:incident",
        observedLedger: 500n,
      });

      expect(result.isPaused).toBe(true);
      expect(result.scopes).toEqual(["ISSUANCE", "ANCHORING"]);
      expect(result.incidentCommitment).toBe("sha256:incident");
      expect(result.isFresh).toBe(true);
    });

    it("should ignore out-of-order replayed ledger updates", async () => {
      prisma.protocolPauseState.findUnique.mockResolvedValue({
        id: "ps-1",
        network: "testnet",
        contractId: "CPAUSE123",
        isPaused: true,
        scopes: ["ALL"],
        incidentCommitment: "sha256:incident",
        observedLedger: 600n,
        lastCheckedAt: new Date(),
      });

      const result = await service.updatePauseState({
        network: "testnet",
        contractId: "CPAUSE123",
        isPaused: false, // attempts to unpause with an older ledger
        observedLedger: 550n,
      });

      expect(result.isPaused).toBe(true);
      expect(prisma.protocolPauseState.upsert).not.toHaveBeenCalled();
    });
  });

  describe("getPauseState", () => {
    it("should fail closed and report paused if unknown contract", async () => {
      prisma.protocolPauseState.findUnique.mockResolvedValue(null);

      const result = await service.getPauseState("testnet", "UNKNOWN_CONTRACT");
      expect(result.isPaused).toBe(true);
      expect(result.isFresh).toBe(false);
      expect(result.scopes).toContain("UNKNOWN_CONTRACT");
    });

    it("should fail closed and report paused if projection is stale (> 5 minutes)", async () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      prisma.protocolPauseState.findUnique.mockResolvedValue({
        id: "ps-1",
        network: "testnet",
        contractId: "CPAUSE123",
        isPaused: false, // on-chain says false, but projection is stale!
        scopes: [],
        incidentCommitment: null,
        observedLedger: 500n,
        lastCheckedAt: tenMinutesAgo,
      });

      const result = await service.getPauseState("testnet", "CPAUSE123");
      expect(result.isFresh).toBe(false);
      expect(result.isPaused).toBe(true); // Fails closed!
    });
  });
});
