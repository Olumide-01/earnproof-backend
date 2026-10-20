import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ProofSharingService } from "./proof-sharing.service";
import { PrismaService } from "../database/prisma.service";
import { sha256 } from "../common/crypto/hash";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makePrismaMock() {
  return {
    proof: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    proofSharingEvent: {
      create: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
}

function makeConfigMock() {
  return {
    get: jest.fn().mockImplementation((key: string) => {
      const defaults: Record<string, any> = {
        "proofSharingTokenTtl": 86400, // 24 hours
        "proofSharingEventRetentionDays": 90,
      };
      return defaults[key];
    }),
    getOrThrow: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createProof(overrides: Partial<{
  id: string;
  userId: string;
  status: string;
  expiresAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "proof_123",
    userId: overrides.userId ?? "user_456",
    status: overrides.status ?? "ACTIVE",
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86400000), // +24h
    user: {
      organizationMemberships: [{
        organizationId: "org_789",
        status: "ACTIVE",
      }],
    },
  };
}

function createSharingEvent(overrides: Partial<{
  id: string;
  proofId: string;
  tokenHash: string;
  outcome: string;
  expiresAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "event_123",
    proofId: overrides.proofId ?? "proof_123",
    organizationId: "org_789",
    tokenHash: overrides.tokenHash ?? sha256("sample_token"),
    ipHash: "ip_hash",
    userAgentHash: "ua_hash",
    outcome: overrides.outcome ?? "SUCCESS",
    createdAt: new Date(),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86400000),
  };
}

// ---------------------------------------------------------------------------
// ProofSharingService.generateSharingToken
// ---------------------------------------------------------------------------

describe("ProofSharingService.generateSharingToken", () => {
  let service: ProofSharingService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let config: ReturnType<typeof makeConfigMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    config = makeConfigMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProofSharingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<ProofSharingService>(ProofSharingService);
  });

  it("generates sharing token for valid proof", async () => {
    const proof = createProof();
    prisma.proof.findFirst.mockResolvedValue(proof);
    prisma.proofSharingEvent.create.mockResolvedValue(
      createSharingEvent({ outcome: "TOKEN_GENERATED" }),
    );

    const result = await service.generateSharingToken(
      "org_789",
      "proof_123",
      {
        purpose: "Employment verification",
        requestedBy: "HR Department",
      },
      {
        ipAddress: "192.168.1.1",
        userAgent: "Mozilla/5.0",
      },
    );

    expect(result.token).toMatch(/^[a-f0-9]{64}$/); // 64-char hex
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.purpose).toBe("Employment verification");
    expect(prisma.proofSharingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org_789",
        proofId: "proof_123",
        tokenHash: expect.any(String),
        ipHash: expect.any(String),
        userAgentHash: expect.any(String),
        outcome: "TOKEN_GENERATED",
        purpose: "Employment verification",
        requestedBy: "HR Department",
      }),
    });
  });

  it("rejects token generation for non-existent proof", async () => {
    prisma.proof.findFirst.mockResolvedValue(null);

    await expect(
      service.generateSharingToken(
        "org_789",
        "nonexistent_proof",
        { purpose: "Test", requestedBy: "Tester" },
        { ipAddress: "192.168.1.1", userAgent: "Mozilla/5.0" },
      ),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.proofSharingEvent.create).not.toHaveBeenCalled();
  });

  it("rejects token generation for inactive proof", async () => {
    const proof = createProof({ status: "REVOKED" });
    prisma.proof.findFirst.mockResolvedValue(proof);

    await expect(
      service.generateSharingToken(
        "org_789",
        "proof_123",
        { purpose: "Test", requestedBy: "Tester" },
        { ipAddress: "192.168.1.1", userAgent: "Mozilla/5.0" },
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.proofSharingEvent.create).not.toHaveBeenCalled();
  });

  it("rejects token generation for expired proof", async () => {
    const proof = createProof({ 
      expiresAt: new Date(Date.now() - 3600000), // -1 hour
    });
    prisma.proof.findFirst.mockResolvedValue(proof);

    await expect(
      service.generateSharingToken(
        "org_789",
        "proof_123",
        { purpose: "Test", requestedBy: "Tester" },
        { ipAddress: "192.168.1.1", userAgent: "Mozilla/5.0" },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("sanitizes and validates input purpose", async () => {
    const proof = createProof();
    prisma.proof.findFirst.mockResolvedValue(proof);
    prisma.proofSharingEvent.create.mockResolvedValue(createSharingEvent());

    // Test with HTML injection attempt
    await service.generateSharingToken(
      "org_789",
      "proof_123",
      { 
        purpose: "<script>alert('xss')</script>Employment verification",
        requestedBy: "HR Department",
      },
      { ipAddress: "192.168.1.1", userAgent: "Mozilla/5.0" },
    );

    const createCall = prisma.proofSharingEvent.create.mock.calls[0][0];
    expect(createCall.data.purpose).not.toContain("<script>");
    expect(createCall.data.purpose).toContain("Employment verification");
  });

  it("hashes sensitive data before storage", async () => {
    const proof = createProof();
    prisma.proof.findFirst.mockResolvedValue(proof);
    prisma.proofSharingEvent.create.mockResolvedValue(createSharingEvent());

    await service.generateSharingToken(
      "org_789", 
      "proof_123",
      { purpose: "Test", requestedBy: "Tester" },
      { ipAddress: "192.168.1.100", userAgent: "TestAgent/1.0" },
    );

    const createCall = prisma.proofSharingEvent.create.mock.calls[0][0];
    
    // Should not store raw IP or user agent
    expect(JSON.stringify(createCall.data)).not.toContain("192.168.1.100");
    expect(JSON.stringify(createCall.data)).not.toContain("TestAgent/1.0");
    
    // Should store hashes
    expect(createCall.data.ipHash).toBe(sha256("192.168.1.0")); // IP subnet
    expect(createCall.data.userAgentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createCall.data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses configured TTL for token expiration", async () => {
    const proof = createProof();
    config.get.mockReturnValueOnce(7200); // 2 hours
    prisma.proof.findFirst.mockResolvedValue(proof);
    prisma.proofSharingEvent.create.mockResolvedValue(createSharingEvent());

    const beforeTime = Date.now();
    const result = await service.generateSharingToken(
      "org_789",
      "proof_123",
      { purpose: "Test", requestedBy: "Tester" },
      { ipAddress: "192.168.1.1", userAgent: "Mozilla/5.0" },
    );

    const expectedExpiry = beforeTime + (7200 * 1000);
    const actualExpiry = result.expiresAt.getTime();
    
    expect(actualExpiry).toBeGreaterThanOrEqual(expectedExpiry - 1000);
    expect(actualExpiry).toBeLessThanOrEqual(expectedExpiry + 1000);
  });
});

// ---------------------------------------------------------------------------
// ProofSharingService.verifyWithSharingToken
// ---------------------------------------------------------------------------

describe("ProofSharingService.verifyWithSharingToken", () => {
  let service: ProofSharingService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let config: ReturnType<typeof makeConfigMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    config = makeConfigMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProofSharingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<ProofSharingService>(ProofSharingService);
  });

  it("verifies proof with valid sharing token", async () => {
    const token = "a".repeat(64);
    const tokenHash = sha256(token);
    const proof = createProof();
    
    const sharingEvent = createSharingEvent({ 
      tokenHash,
      outcome: "TOKEN_GENERATED",
    });
    
    prisma.proofSharingEvent.findMany.mockResolvedValue([sharingEvent]);
    prisma.proof.findUnique.mockResolvedValue(proof);
    prisma.proofSharingEvent.create.mockResolvedValue(
      createSharingEvent({ outcome: "SUCCESS" }),
    );

    const result = await service.verifyWithSharingToken(
      token,
      { ipAddress: "192.168.1.1", userAgent: "Mozilla/5.0" },
    );

    expect(result.isValid).toBe(true);
    expect(result.proof).toEqual(proof);
    expect(prisma.proofSharingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outcome: "SUCCESS",
        tokenHash,
      }),
    });
  });

  it("rejects verification with invalid token", async () => {
    const token = "invalid_token";
    
    prisma.proofSharingEvent.findMany.mockResolvedValue([]);
    prisma.proofSharingEvent.create.mockResolvedValue(
      createSharingEvent({ outcome: "INVALID_TOKEN" }),
    );

    const result = await service.verifyWithSharingToken(
      token,
      { ipAddress: "192.168.1.1", userAgent: "Mozilla/5.0" },
    );

    expect(result.isValid).toBe(false);
    expect(result.proof).toBeNull();
    expect(result.error).toContain("Invalid or expired");
    expect(prisma.proofSharingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outcome: "INVALID_TOKEN",
      }),
    });
  });

  it("rejects verification with expired token", async () => {
    const token = "a".repeat(64);
    const tokenHash = sha256(token);
    
    const expiredEvent = createSharingEvent({
      tokenHash,
      expiresAt: new Date(Date.now() - 3600000), // -1 hour
    });
    
    prisma.proofSharingEvent.findMany.mockResolvedValue([expiredEvent]);
    prisma.proofSharingEvent.create.mockResolvedValue(
      createSharingEvent({ outcome: "EXPIRED_TOKEN" }),
    );

    const result = await service.verifyWithSharingToken(
      token,
      { ipAddress: "192.168.1.1", userAgent: "Mozilla/5.0" },
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Invalid or expired");
    expect(prisma.proofSharingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outcome: "EXPIRED_TOKEN",
      }),
    });
  });

  it("rejects verification when proof no longer exists", async () => {
    const token = "a".repeat(64);
    const tokenHash = sha256(token);
    
    const sharingEvent = createSharingEvent({ tokenHash });
    prisma.proofSharingEvent.findMany.mockResolvedValue([sharingEvent]);
    prisma.proof.findUnique.mockResolvedValue(null);
    prisma.proofSharingEvent.create.mockResolvedValue(
      createSharingEvent({ outcome: "PROOF_NOT_FOUND" }),
    );

    const result = await service.verifyWithSharingToken(
      token,
      { ipAddress: "192.168.1.1", userAgent: "Mozilla/5.0" },
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Proof no longer available");
    expect(prisma.proofSharingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outcome: "PROOF_NOT_FOUND",
      }),
    });
  });

  it("logs verification attempt with privacy-safe data", async () => {
    const token = "a".repeat(64);
    prisma.proofSharingEvent.findMany.mockResolvedValue([]);
    prisma.proofSharingEvent.create.mockResolvedValue(createSharingEvent());

    await service.verifyWithSharingToken(
      token,
      { ipAddress: "10.0.0.50", userAgent: "TestBrowser/2.0" },
    );

    const createCall = prisma.proofSharingEvent.create.mock.calls[0][0];
    
    // Should hash IP subnet, not full IP
    expect(createCall.data.ipHash).toBe(sha256("10.0.0.0"));
    expect(createCall.data.userAgentHash).toMatch(/^[a-f0-9]{64}$/);
    
    // Should not contain raw sensitive data
    expect(JSON.stringify(createCall.data)).not.toContain("10.0.0.50");
    expect(JSON.stringify(createCall.data)).not.toContain("TestBrowser/2.0");
  });
});

// ---------------------------------------------------------------------------
// ProofSharingService.getSharingEvents
// ---------------------------------------------------------------------------

describe("ProofSharingService.getSharingEvents", () => {
  let service: ProofSharingService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let config: ReturnType<typeof makeConfigMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    config = makeConfigMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProofSharingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<ProofSharingService>(ProofSharingService);
  });

  it("returns sharing events for organization", async () => {
    const events = [
      createSharingEvent({ outcome: "SUCCESS" }),
      createSharingEvent({ outcome: "INVALID_TOKEN" }),
    ];
    prisma.proofSharingEvent.findMany.mockResolvedValue(events);

    const result = await service.getSharingEvents("org_789", {});

    expect(result).toHaveLength(2);
    expect(result[0].outcome).toBe("SUCCESS");
    expect(result[1].outcome).toBe("INVALID_TOKEN");
    expect(prisma.proofSharingEvent.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org_789" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });

  it("filters events by proof ID", async () => {
    const events = [createSharingEvent()];
    prisma.proofSharingEvent.findMany.mockResolvedValue(events);

    await service.getSharingEvents("org_789", { proofId: "proof_123" });

    expect(prisma.proofSharingEvent.findMany).toHaveBeenCalledWith({
      where: { 
        organizationId: "org_789",
        proofId: "proof_123",
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });

  it("applies limit parameter", async () => {
    prisma.proofSharingEvent.findMany.mockResolvedValue([]);

    await service.getSharingEvents("org_789", { limit: 25 });

    expect(prisma.proofSharingEvent.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org_789" },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
  });

  it("enforces maximum limit", async () => {
    prisma.proofSharingEvent.findMany.mockResolvedValue([]);

    await service.getSharingEvents("org_789", { limit: 999 });

    expect(prisma.proofSharingEvent.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org_789" },
      orderBy: { createdAt: "desc" },
      take: 100, // Capped at max
    });
  });
});

// ---------------------------------------------------------------------------
// ProofSharingService.cleanupExpiredEvents
// ---------------------------------------------------------------------------

describe("ProofSharingService.cleanupExpiredEvents", () => {
  let service: ProofSharingService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let config: ReturnType<typeof makeConfigMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    config = makeConfigMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProofSharingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<ProofSharingService>(ProofSharingService);
  });

  it("deletes events older than retention period", async () => {
    config.get.mockReturnValueOnce(30); // 30 days retention
    prisma.proofSharingEvent.deleteMany.mockResolvedValue({ count: 15 });

    const result = await service.cleanupExpiredEvents();

    expect(result.deletedCount).toBe(15);
    
    const deleteCall = prisma.proofSharingEvent.deleteMany.mock.calls[0][0];
    const cutoffDate = deleteCall.where.createdAt.lte;
    const expectedCutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    expect(cutoffDate.getTime()).toBeCloseTo(expectedCutoff, -3); // Within 1 second
  });

  it("uses default retention period when not configured", async () => {
    config.get.mockReturnValueOnce(undefined);
    prisma.proofSharingEvent.deleteMany.mockResolvedValue({ count: 0 });

    await service.cleanupExpiredEvents();

    const deleteCall = prisma.proofSharingEvent.deleteMany.mock.calls[0][0];
    const cutoffDate = deleteCall.where.createdAt.lte;
    const expectedCutoff = Date.now() - (90 * 24 * 60 * 60 * 1000); // Default 90 days
    
    expect(cutoffDate.getTime()).toBeCloseTo(expectedCutoff, -3);
  });

  it("handles cleanup errors gracefully", async () => {
    config.get.mockReturnValueOnce(30);
    prisma.proofSharingEvent.deleteMany.mockRejectedValue(
      new Error("Database connection lost"),
    );

    await expect(service.cleanupExpiredEvents()).rejects.toThrow(
      "Database connection lost",
    );
  });
});

// ---------------------------------------------------------------------------
// Privacy and security tests
// ---------------------------------------------------------------------------

describe("ProofSharingService privacy and security", () => {
  let service: ProofSharingService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let config: ReturnType<typeof makeConfigMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    config = makeConfigMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProofSharingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<ProofSharingService>(ProofSharingService);
  });

  it("generates cryptographically secure tokens", async () => {
    const proof = createProof();
    prisma.proof.findFirst.mockResolvedValue(proof);
    prisma.proofSharingEvent.create.mockResolvedValue(createSharingEvent());

    const tokens = [];
    for (let i = 0; i < 10; i++) {
      const result = await service.generateSharingToken(
        "org_789",
        "proof_123",
        { purpose: "Test", requestedBy: "Tester" },
        { ipAddress: "192.168.1.1", userAgent: "Mozilla/5.0" },
      );
      tokens.push(result.token);
    }

    // All tokens should be unique
    const uniqueTokens = new Set(tokens);
    expect(uniqueTokens.size).toBe(tokens.length);

    // All tokens should match expected format (64-char hex)
    tokens.forEach(token => {
      expect(token).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("anonymizes IP addresses by using subnets", () => {
    const testCases = [
      { input: "192.168.1.50", expected: "192.168.1.0" },
      { input: "10.0.5.100", expected: "10.0.5.0" },
      { input: "172.16.10.25", expected: "172.16.10.0" },
      { input: "::1", expected: "::1" }, // IPv6 loopback preserved
      { input: "2001:db8::1", expected: "2001:db8::" },
    ];

    testCases.forEach(({ input, expected }) => {
      // Access private method for testing
      const result = (service as any).anonymizeIpAddress(input);
      expect(result).toBe(expected);
    });
  });

  it("never stores raw tokens, IPs, or user agents", async () => {
    const proof = createProof();
    prisma.proof.findFirst.mockResolvedValue(proof);
    prisma.proofSharingEvent.create.mockResolvedValue(createSharingEvent());

    const sensitiveData = {
      ipAddress: "203.0.113.42",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    };

    await service.generateSharingToken(
      "org_789",
      "proof_123",
      { purpose: "Test", requestedBy: "Tester" },
      sensitiveData,
    );

    const createCall = prisma.proofSharingEvent.create.mock.calls[0][0];
    const serializedData = JSON.stringify(createCall.data);

    // Raw sensitive data should never appear in stored data
    expect(serializedData).not.toContain(sensitiveData.ipAddress);
    expect(serializedData).not.toContain(sensitiveData.userAgent);
    expect(serializedData).not.toContain("Mozilla");
    expect(serializedData).not.toContain("Windows NT");
  });
});