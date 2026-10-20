import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConsentService } from "./consent.service";
import { PrismaService } from "../../database/prisma.service";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makePrismaMock() {
  return {
    policyVersion: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    consentRecord: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createPolicyVersion(overrides: Partial<{
  id: string;
  organizationId: string;
  policyType: string;
  version: string;
  status: string;
  content: any;
}> = {}) {
  return {
    id: overrides.id ?? "policy_123",
    organizationId: overrides.organizationId ?? "org_789",
    policyType: overrides.policyType ?? "PRIVACY_POLICY",
    version: overrides.version ?? "v1.0",
    status: overrides.status ?? "ACTIVE",
    content: overrides.content ?? { terms: "Sample policy content" },
    createdAt: new Date("2024-01-01T10:00:00Z"),
    effectiveAt: new Date("2024-01-01T10:00:00Z"),
  };
}

function createConsentRecord(overrides: Partial<{
  id: string;
  userId: string;
  policyVersionId: string;
  action: string;
}> = {}) {
  return {
    id: overrides.id ?? "consent_123",
    organizationId: "org_789",
    userId: overrides.userId ?? "user_456",
    policyVersionId: overrides.policyVersionId ?? "policy_123",
    action: overrides.action ?? "GRANTED",
    consentData: { source: "web_ui", ipHash: "ip_hash" },
    createdAt: new Date("2024-01-01T10:00:00Z"),
  };
}

// ---------------------------------------------------------------------------
// ConsentService.createPolicyVersion
// ---------------------------------------------------------------------------

describe("ConsentService.createPolicyVersion", () => {
  let service: ConsentService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsentService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ConsentService>(ConsentService);
  });

  it("creates new policy version successfully", async () => {
    const policyData = {
      policyType: "PRIVACY_POLICY" as const,
      version: "v2.0",
      content: { 
        sections: ["data collection", "usage", "sharing"],
        lastUpdated: "2024-01-01",
      },
      effectiveAt: new Date("2024-02-01T00:00:00Z"),
    };

    const createdPolicy = createPolicyVersion(policyData);
    prisma.policyVersion.create.mockResolvedValue(createdPolicy);

    const result = await service.createPolicyVersion("org_789", policyData);

    expect(result.policyType).toBe(policyData.policyType);
    expect(result.version).toBe(policyData.version);
    expect(result.content).toEqual(policyData.content);
    expect(prisma.policyVersion.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org_789",
        ...policyData,
      },
    });
  });

  it("validates policy type enum", async () => {
    const invalidPolicyData = {
      policyType: "INVALID_TYPE" as any,
      version: "v1.0",
      content: {},
      effectiveAt: new Date(),
    };

    // This would be caught by TypeScript, but test runtime validation
    await expect(
      service.createPolicyVersion("org_789", invalidPolicyData),
    ).rejects.toThrow();
  });

  it("validates version format", async () => {
    const policyData = {
      policyType: "PRIVACY_POLICY" as const,
      version: "", // Empty version
      content: {},
      effectiveAt: new Date(),
    };

    await expect(
      service.createPolicyVersion("org_789", policyData),
    ).rejects.toThrow(BadRequestException);
  });

  it("validates effective date is in future", async () => {
    const policyData = {
      policyType: "PRIVACY_POLICY" as const,
      version: "v1.0",
      content: {},
      effectiveAt: new Date(Date.now() - 86400000), // Yesterday
    };

    await expect(
      service.createPolicyVersion("org_789", policyData),
    ).rejects.toThrow(BadRequestException);
  });

  it("sets status to DRAFT by default", async () => {
    const policyData = {
      policyType: "PRIVACY_POLICY" as const,
      version: "v1.0", 
      content: {},
      effectiveAt: new Date(Date.now() + 86400000),
    };

    prisma.policyVersion.create.mockResolvedValue(createPolicyVersion());

    await service.createPolicyVersion("org_789", policyData);

    expect(prisma.policyVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "DRAFT",
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// ConsentService.activatePolicyVersion
// ---------------------------------------------------------------------------

describe("ConsentService.activatePolicyVersion", () => {
  let service: ConsentService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsentService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ConsentService>(ConsentService);
  });

  it("activates policy version and deactivates others", async () => {
    const draftPolicy = createPolicyVersion({ 
      id: "policy_123",
      status: "DRAFT",
    });
    
    prisma.policyVersion.findUnique.mockResolvedValue(draftPolicy);
    prisma.policyVersion.update.mockResolvedValue({
      ...draftPolicy,
      status: "ACTIVE",
    });

    const result = await service.activatePolicyVersion("org_789", "policy_123");

    expect(result.status).toBe("ACTIVE");
    
    // Should deactivate other policies of same type
    expect(prisma.policyVersion.update).toHaveBeenCalledWith({
      where: {
        organizationId: "org_789",
        policyType: draftPolicy.policyType,
        status: "ACTIVE",
      },
      data: { status: "SUPERSEDED" },
    });

    // Should activate the target policy
    expect(prisma.policyVersion.update).toHaveBeenCalledWith({
      where: { 
        id: "policy_123",
        organizationId: "org_789",
      },
      data: { status: "ACTIVE" },
    });
  });

  it("rejects activation of non-existent policy", async () => {
    prisma.policyVersion.findUnique.mockResolvedValue(null);

    await expect(
      service.activatePolicyVersion("org_789", "nonexistent_policy"),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects activation of already active policy", async () => {
    const activePolicy = createPolicyVersion({ status: "ACTIVE" });
    prisma.policyVersion.findUnique.mockResolvedValue(activePolicy);

    await expect(
      service.activatePolicyVersion("org_789", "policy_123"),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects activation of superseded policy", async () => {
    const supersededPolicy = createPolicyVersion({ status: "SUPERSEDED" });
    prisma.policyVersion.findUnique.mockResolvedValue(supersededPolicy);

    await expect(
      service.activatePolicyVersion("org_789", "policy_123"),
    ).rejects.toThrow(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// ConsentService.recordConsent
// ---------------------------------------------------------------------------

describe("ConsentService.recordConsent", () => {
  let service: ConsentService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsentService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ConsentService>(ConsentService);
  });

  it("records user consent successfully", async () => {
    const activePolicy = createPolicyVersion({ status: "ACTIVE" });
    const consentData = {
      policyVersionId: "policy_123",
      action: "GRANTED" as const,
      consentData: {
        source: "web_ui",
        timestamp: new Date().toISOString(),
      },
    };

    prisma.policyVersion.findUnique.mockResolvedValue(activePolicy);
    prisma.consentRecord.create.mockResolvedValue(
      createConsentRecord(consentData),
    );

    const result = await service.recordConsent(
      "org_789",
      "user_456", 
      consentData,
    );

    expect(result.action).toBe("GRANTED");
    expect(result.userId).toBe("user_456");
    expect(prisma.consentRecord.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org_789",
        userId: "user_456",
        ...consentData,
      },
    });
  });

  it("rejects consent for non-existent policy version", async () => {
    prisma.policyVersion.findUnique.mockResolvedValue(null);

    await expect(
      service.recordConsent("org_789", "user_456", {
        policyVersionId: "nonexistent_policy",
        action: "GRANTED",
        consentData: {},
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects consent for inactive policy version", async () => {
    const inactivePolicy = createPolicyVersion({ status: "DRAFT" });
    prisma.policyVersion.findUnique.mockResolvedValue(inactivePolicy);

    await expect(
      service.recordConsent("org_789", "user_456", {
        policyVersionId: "policy_123",
        action: "GRANTED",
        consentData: {},
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows multiple consent records for same user/policy", async () => {
    // Users can grant, then revoke, then grant again
    const activePolicy = createPolicyVersion({ status: "ACTIVE" });
    prisma.policyVersion.findUnique.mockResolvedValue(activePolicy);

    const firstConsent = createConsentRecord({ action: "GRANTED" });
    const secondConsent = createConsentRecord({ action: "REVOKED" });

    prisma.consentRecord.create
      .mockResolvedValueOnce(firstConsent)
      .mockResolvedValueOnce(secondConsent);

    const result1 = await service.recordConsent("org_789", "user_456", {
      policyVersionId: "policy_123",
      action: "GRANTED",
      consentData: {},
    });

    const result2 = await service.recordConsent("org_789", "user_456", {
      policyVersionId: "policy_123", 
      action: "REVOKED",
      consentData: {},
    });

    expect(result1.action).toBe("GRANTED");
    expect(result2.action).toBe("REVOKED");
    expect(prisma.consentRecord.create).toHaveBeenCalledTimes(2);
  });

  it("preserves audit trail with immutable records", async () => {
    const activePolicy = createPolicyVersion({ status: "ACTIVE" });
    prisma.policyVersion.findUnique.mockResolvedValue(activePolicy);
    prisma.consentRecord.create.mockResolvedValue(createConsentRecord());

    await service.recordConsent("org_789", "user_456", {
      policyVersionId: "policy_123",
      action: "GRANTED",
      consentData: { source: "api", metadata: { version: "2.0" } },
    });

    // Verify that consent data is stored as-is for audit trail
    expect(prisma.consentRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        consentData: { source: "api", metadata: { version: "2.0" } },
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// ConsentService.checkUserConsent
// ---------------------------------------------------------------------------

describe("ConsentService.checkUserConsent", () => {
  let service: ConsentService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsentService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ConsentService>(ConsentService);
  });

  it("returns true when user has active consent", async () => {
    const activePolicy = createPolicyVersion({ status: "ACTIVE" });
    const grantedConsent = createConsentRecord({ action: "GRANTED" });

    prisma.policyVersion.findFirst.mockResolvedValue(activePolicy);
    prisma.consentRecord.findFirst.mockResolvedValue(grantedConsent);

    const result = await service.checkUserConsent(
      "org_789",
      "user_456",
      "PRIVACY_POLICY",
    );

    expect(result.hasConsent).toBe(true);
    expect(result.policyVersion).toEqual(activePolicy);
    expect(result.latestConsent).toEqual(grantedConsent);
  });

  it("returns false when user has revoked consent", async () => {
    const activePolicy = createPolicyVersion({ status: "ACTIVE" });
    const revokedConsent = createConsentRecord({ action: "REVOKED" });

    prisma.policyVersion.findFirst.mockResolvedValue(activePolicy);
    prisma.consentRecord.findFirst.mockResolvedValue(revokedConsent);

    const result = await service.checkUserConsent(
      "org_789", 
      "user_456",
      "PRIVACY_POLICY",
    );

    expect(result.hasConsent).toBe(false);
    expect(result.latestConsent.action).toBe("REVOKED");
  });

  it("returns false when no policy exists", async () => {
    prisma.policyVersion.findFirst.mockResolvedValue(null);

    const result = await service.checkUserConsent(
      "org_789",
      "user_456", 
      "PRIVACY_POLICY",
    );

    expect(result.hasConsent).toBe(false);
    expect(result.policyVersion).toBeNull();
    expect(result.latestConsent).toBeNull();
  });

  it("returns false when user has never given consent", async () => {
    const activePolicy = createPolicyVersion({ status: "ACTIVE" });
    prisma.policyVersion.findFirst.mockResolvedValue(activePolicy);
    prisma.consentRecord.findFirst.mockResolvedValue(null);

    const result = await service.checkUserConsent(
      "org_789",
      "user_456",
      "PRIVACY_POLICY", 
    );

    expect(result.hasConsent).toBe(false);
    expect(result.policyVersion).toEqual(activePolicy);
    expect(result.latestConsent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ConsentService.getUserConsentHistory
// ---------------------------------------------------------------------------

describe("ConsentService.getUserConsentHistory", () => {
  let service: ConsentService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsentService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ConsentService>(ConsentService);
  });

  it("returns chronological consent history", async () => {
    const consentHistory = [
      createConsentRecord({ 
        action: "GRANTED",
        createdAt: new Date("2024-01-01T10:00:00Z"),
      }),
      createConsentRecord({
        action: "REVOKED", 
        createdAt: new Date("2024-01-15T10:00:00Z"),
      }),
      createConsentRecord({
        action: "GRANTED",
        createdAt: new Date("2024-02-01T10:00:00Z"),
      }),
    ];

    prisma.consentRecord.findMany.mockResolvedValue(consentHistory);

    const result = await service.getUserConsentHistory(
      "org_789",
      "user_456",
      { policyType: "PRIVACY_POLICY" },
    );

    expect(result).toHaveLength(3);
    expect(result[0].action).toBe("GRANTED");  // Most recent first
    expect(result[1].action).toBe("REVOKED");
    expect(result[2].action).toBe("GRANTED");

    expect(prisma.consentRecord.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org_789",
        userId: "user_456",
        policyVersion: {
          policyType: "PRIVACY_POLICY",
        },
      },
      include: { policyVersion: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("filters by policy version when specified", async () => {
    prisma.consentRecord.findMany.mockResolvedValue([]);

    await service.getUserConsentHistory("org_789", "user_456", {
      policyVersionId: "policy_123",
    });

    expect(prisma.consentRecord.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org_789", 
        userId: "user_456",
        policyVersionId: "policy_123",
      },
      include: { policyVersion: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("returns empty array when user has no consent history", async () => {
    prisma.consentRecord.findMany.mockResolvedValue([]);

    const result = await service.getUserConsentHistory(
      "org_789",
      "user_456", 
      {},
    );

    expect(result).toEqual([]);
  });
});