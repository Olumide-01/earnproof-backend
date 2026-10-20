import { ProofType, ResourceStatus } from "@prisma/client";
import { ProofCapacityPreflightService } from "./proof-capacity-preflight.service";

describe("ProofCapacityPreflightService", () => {
  let service: ProofCapacityPreflightService;
  let prisma: any;
  let configService: any;
  let quotaService: any;
  let pauseService: any;

  beforeEach(() => {
    prisma = {
      organization: {
        findFirst: jest.fn(),
      },
      organizationMember: {
        findUnique: jest.fn(),
      },
      organizationQuotaUsage: {
        findUnique: jest.fn(),
      },
      supportedAsset: {
        findFirst: jest.fn(),
      },
    };

    configService = {
      get: jest.fn((key: string) => {
        if (key === "stellar.networkPassphrase") return "Test SDF Network ; September 2015";
        if (key === "stellar.contractId") return "contract_1";
        return undefined;
      }),
    };

    quotaService = {
      limitFor: jest.fn(() => 100),
    };

    pauseService = {
      getPauseState: jest.fn().mockResolvedValue({
        network: "Test SDF Network ; September 2015",
        contractId: "contract_1",
        isPaused: false,
        scopes: [],
        incidentCommitment: null,
        observedLedger: "1000",
        lastCheckedAt: new Date(),
        isFresh: true,
      }),
    };

    service = new ProofCapacityPreflightService(
      prisma,
      configService,
      quotaService,
      pauseService,
    );
  });

  it("returns allowed: true with capacity estimate when quota and contract are healthy", async () => {
    prisma.organization.findFirst.mockResolvedValue({
      id: "org_1",
      archivedAt: null,
      status: ResourceStatus.ACTIVE,
    });
    prisma.organizationQuotaUsage.findUnique.mockResolvedValue({
      count: 20,
    });
    prisma.supportedAsset.findFirst.mockResolvedValue({
      id: "asset_1",
      code: "USDC",
      status: ResourceStatus.ACTIVE,
    });

    const result = await service.evaluatePreflight("user_1", {
      proofType: ProofType.MINIMUM_INCOME,
      assetCode: "USDC",
    });

    expect(result.allowed).toBe(true);
    expect(result.capacityRemaining).toBe(80);
    expect(result.advisoryOnly).toBe(true);
    expect(result.quota).toMatchObject({
      source: "organization",
      usage: 20,
      limit: 100,
      remaining: 80,
    });
    expect(result.contractCapacity).toMatchObject({
      status: "HEALTHY",
      scopes: [],
    });
    expect(result.denialReasons).toHaveLength(0);
  });

  it("denies preflight and lists ORGANIZATION_QUOTA_EXCEEDED when daily limit is reached", async () => {
    prisma.organization.findFirst.mockResolvedValue({
      id: "org_1",
      archivedAt: null,
      status: ResourceStatus.ACTIVE,
    });
    prisma.organizationQuotaUsage.findUnique.mockResolvedValue({
      count: 100,
    });

    const result = await service.evaluatePreflight("user_1", {
      proofType: ProofType.MINIMUM_INCOME,
    });

    expect(result.allowed).toBe(false);
    expect(result.capacityRemaining).toBe(0);
    expect(result.quota.remaining).toBe(0);
    expect(result.denialReasons).toContain("ORGANIZATION_QUOTA_EXCEEDED");
  });

  it("denies preflight when protocol contract is paused", async () => {
    prisma.organization.findFirst.mockResolvedValue(null);
    pauseService.getPauseState.mockResolvedValue({
      network: "Test SDF Network ; September 2015",
      contractId: "contract_1",
      isPaused: true,
      scopes: ["ISSUANCE_PAUSED"],
      observedLedger: "1005",
      lastCheckedAt: new Date(),
      isFresh: true,
    });

    const result = await service.evaluatePreflight("user_1", {
      proofType: ProofType.MINIMUM_INCOME,
    });

    expect(result.allowed).toBe(false);
    expect(result.contractCapacity.status).toBe("PAUSED");
    expect(result.contractCapacity.scopes).toContain("ISSUANCE_PAUSED");
    expect(result.denialReasons).toContain("CONTRACT_PAUSED");
  });

  it("denies preflight when contract state projection is stale", async () => {
    prisma.organization.findFirst.mockResolvedValue(null);
    pauseService.getPauseState.mockResolvedValue({
      network: "Test SDF Network ; September 2015",
      contractId: "contract_1",
      isPaused: false,
      scopes: [],
      observedLedger: "900",
      lastCheckedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago (> 5m threshold)
      isFresh: false,
    });

    const result = await service.evaluatePreflight("user_1", {
      proofType: ProofType.MINIMUM_INCOME,
    });

    expect(result.allowed).toBe(false);
    expect(result.contractCapacity.status).toBe("DEGRADED");
    expect(result.denialReasons).toContain("CONTRACT_STATE_STALE");
  });

  it("denies preflight when requested asset is inactive or not found", async () => {
    prisma.organization.findFirst.mockResolvedValue(null);
    prisma.supportedAsset.findFirst.mockResolvedValue(null);

    const result = await service.evaluatePreflight("user_1", {
      proofType: ProofType.MINIMUM_INCOME,
      assetCode: "INACTIVE_TOKEN",
    });

    expect(result.allowed).toBe(false);
    expect(result.denialReasons).toContain("ASSET_NOT_SUPPORTED_OR_INACTIVE");
  });

  it("enforces tenant isolation: rejects requested org when user is not a member", async () => {
    prisma.organizationMember.findUnique.mockResolvedValue(null);

    const result = await service.evaluatePreflight("user_1", {
      proofType: ProofType.MINIMUM_INCOME,
      organizationId: "org_unauthorized",
    });

    expect(result.denialReasons).toContain("ORGANIZATION_INACTIVE_OR_UNAUTHORIZED");
  });
});
