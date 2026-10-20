import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ApiKeyQuotaService } from "./api-key-quota.service";
import { PrismaService } from "../database/prisma.service";
import { RedisService } from "../common/redis/redis.service";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makePrismaMock() {
  return {
    apiKeyQuota: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    apiKey: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function makeRedisMock() {
  return {
    get: jest.fn(),
    set: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    del: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createQuotaConfig(overrides: Partial<{
  id: string;
  apiKeyId: string;
  scope: string;
  quotaLimit: number;
  quotaWindow: number;
  organizationId: string;
}> = {}) {
  return {
    id: overrides.id ?? "quota_123",
    apiKeyId: overrides.apiKeyId ?? "api_key_456",
    scope: overrides.scope ?? "proofs:create",
    quotaLimit: overrides.quotaLimit ?? 100,
    quotaWindow: overrides.quotaWindow ?? 3600,
    organizationId: overrides.organizationId ?? "org_789",
    createdAt: new Date("2024-01-01T10:00:00Z"),
    updatedAt: new Date("2024-01-01T10:00:00Z"),
  };
}

function createApiKey(overrides: Partial<{
  id: string;
  organizationId: string;
  scopes: string[];
  status: string;
}> = {}) {
  return {
    id: overrides.id ?? "api_key_456",
    organizationId: overrides.organizationId ?? "org_789",
    scopes: overrides.scopes ?? ["proofs:create", "proofs:read"],
    status: overrides.status ?? "ACTIVE",
  };
}

// ---------------------------------------------------------------------------
// ApiKeyQuotaService.createQuota
// ---------------------------------------------------------------------------

describe("ApiKeyQuotaService.createQuota", () => {
  let service: ApiKeyQuotaService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    redis = makeRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyQuotaService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get<ApiKeyQuotaService>(ApiKeyQuotaService);
  });

  it("creates a quota configuration for valid API key", async () => {
    const apiKey = createApiKey();
    const quotaData = {
      scope: "proofs:create",
      quotaLimit: 50,
      quotaWindow: 3600,
    };

    prisma.apiKey.findUnique.mockResolvedValue(apiKey);
    prisma.apiKeyQuota.create.mockResolvedValue(
      createQuotaConfig({ ...quotaData, apiKeyId: apiKey.id }),
    );

    const result = await service.createQuota(
      apiKey.organizationId,
      apiKey.id,
      quotaData,
    );

    expect(result.scope).toBe(quotaData.scope);
    expect(result.quotaLimit).toBe(quotaData.quotaLimit);
    expect(result.quotaWindow).toBe(quotaData.quotaWindow);
    expect(prisma.apiKeyQuota.create).toHaveBeenCalledWith({
      data: {
        apiKeyId: apiKey.id,
        organizationId: apiKey.organizationId,
        scope: quotaData.scope,
        quotaLimit: quotaData.quotaLimit,
        quotaWindow: quotaData.quotaWindow,
      },
    });
  });

  it("rejects quota creation for non-existent API key", async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null);

    await expect(
      service.createQuota("org_789", "nonexistent_key", {
        scope: "proofs:create",
        quotaLimit: 50,
        quotaWindow: 3600,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects quota creation for inactive API key", async () => {
    const apiKey = createApiKey({ status: "REVOKED" });
    prisma.apiKey.findUnique.mockResolvedValue(apiKey);

    await expect(
      service.createQuota("org_789", apiKey.id, {
        scope: "proofs:create",
        quotaLimit: 50,
        quotaWindow: 3600,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects quota for scope not granted to API key", async () => {
    const apiKey = createApiKey({ scopes: ["proofs:read"] });
    prisma.apiKey.findUnique.mockResolvedValue(apiKey);

    await expect(
      service.createQuota("org_789", apiKey.id, {
        scope: "proofs:create", // Not in API key scopes
        quotaLimit: 50,
        quotaWindow: 3600,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("validates quota limit bounds", async () => {
    const apiKey = createApiKey();
    prisma.apiKey.findUnique.mockResolvedValue(apiKey);

    // Test minimum limit
    await expect(
      service.createQuota("org_789", apiKey.id, {
        scope: "proofs:create",
        quotaLimit: 0,
        quotaWindow: 3600,
      }),
    ).rejects.toThrow(BadRequestException);

    // Test maximum limit  
    await expect(
      service.createQuota("org_789", apiKey.id, {
        scope: "proofs:create",
        quotaLimit: 1_000_001,
        quotaWindow: 3600,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("validates quota window bounds", async () => {
    const apiKey = createApiKey();
    prisma.apiKey.findUnique.mockResolvedValue(apiKey);

    // Test minimum window
    await expect(
      service.createQuota("org_789", apiKey.id, {
        scope: "proofs:create",
        quotaLimit: 50,
        quotaWindow: 59, // Less than 60 seconds
      }),
    ).rejects.toThrow(BadRequestException);

    // Test maximum window
    await expect(
      service.createQuota("org_789", apiKey.id, {
        scope: "proofs:create",
        quotaLimit: 50,
        quotaWindow: 86401, // More than 24 hours
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// ApiKeyQuotaService.checkQuota
// ---------------------------------------------------------------------------

describe("ApiKeyQuotaService.checkQuota", () => {
  let service: ApiKeyQuotaService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    redis = makeRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyQuotaService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get<ApiKeyQuotaService>(ApiKeyQuotaService);
  });

  it("returns available quota when under limit", async () => {
    const quota = createQuotaConfig({ quotaLimit: 100 });
    prisma.apiKeyQuota.findUnique.mockResolvedValue(quota);
    redis.get.mockResolvedValue("25"); // Current usage

    const result = await service.checkQuota("api_key_456", "proofs:create");

    expect(result.isAllowed).toBe(true);
    expect(result.currentUsage).toBe(25);
    expect(result.quotaLimit).toBe(100);
    expect(result.remainingQuota).toBe(75);
    expect(result.quotaWindow).toBe(3600);
  });

  it("blocks request when quota limit is reached", async () => {
    const quota = createQuotaConfig({ quotaLimit: 100 });
    prisma.apiKeyQuota.findUnique.mockResolvedValue(quota);
    redis.get.mockResolvedValue("100"); // At limit

    const result = await service.checkQuota("api_key_456", "proofs:create");

    expect(result.isAllowed).toBe(false);
    expect(result.currentUsage).toBe(100);
    expect(result.remainingQuota).toBe(0);
  });

  it("blocks request when quota limit is exceeded", async () => {
    const quota = createQuotaConfig({ quotaLimit: 100 });
    prisma.apiKeyQuota.findUnique.mockResolvedValue(quota);
    redis.get.mockResolvedValue("105"); // Over limit

    const result = await service.checkQuota("api_key_456", "proofs:create");

    expect(result.isAllowed).toBe(false);
    expect(result.currentUsage).toBe(105);
    expect(result.remainingQuota).toBe(-5);
  });

  it("allows request when no quota configuration exists", async () => {
    prisma.apiKeyQuota.findUnique.mockResolvedValue(null);

    const result = await service.checkQuota("api_key_456", "proofs:create");

    expect(result.isAllowed).toBe(true);
    expect(result.currentUsage).toBe(0);
    expect(result.quotaLimit).toBeNull();
    expect(result.remainingQuota).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("treats missing Redis counter as zero usage", async () => {
    const quota = createQuotaConfig({ quotaLimit: 100 });
    prisma.apiKeyQuota.findUnique.mockResolvedValue(quota);
    redis.get.mockResolvedValue(null); // No counter yet

    const result = await service.checkQuota("api_key_456", "proofs:create");

    expect(result.isAllowed).toBe(true);
    expect(result.currentUsage).toBe(0);
    expect(result.remainingQuota).toBe(100);
  });

  it("handles Redis connection errors gracefully", async () => {
    const quota = createQuotaConfig({ quotaLimit: 100 });
    prisma.apiKeyQuota.findUnique.mockResolvedValue(quota);
    redis.get.mockRejectedValue(new Error("Redis unavailable"));

    const result = await service.checkQuota("api_key_456", "proofs:create");

    // Should allow request when Redis is unavailable (fail open for availability)
    expect(result.isAllowed).toBe(true);
    expect(result.currentUsage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ApiKeyQuotaService.incrementUsage
// ---------------------------------------------------------------------------

describe("ApiKeyQuotaService.incrementUsage", () => {
  let service: ApiKeyQuotaService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    redis = makeRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyQuotaService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get<ApiKeyQuotaService>(ApiKeyQuotaService);
  });

  it("increments counter and sets expiration for new window", async () => {
    const quota = createQuotaConfig({ quotaLimit: 100, quotaWindow: 3600 });
    prisma.apiKeyQuota.findUnique.mockResolvedValue(quota);
    redis.incr.mockResolvedValue(1); // First increment

    const result = await service.incrementUsage("api_key_456", "proofs:create");

    expect(result.newUsage).toBe(1);
    expect(redis.incr).toHaveBeenCalledWith("quota:api_key_456:proofs:create");
    expect(redis.expire).toHaveBeenCalledWith("quota:api_key_456:proofs:create", 3600);
  });

  it("increments existing counter without changing expiration", async () => {
    const quota = createQuotaConfig({ quotaLimit: 100, quotaWindow: 3600 });
    prisma.apiKeyQuota.findUnique.mockResolvedValue(quota);
    redis.incr.mockResolvedValue(5); // Existing counter

    const result = await service.incrementUsage("api_key_456", "proofs:create");

    expect(result.newUsage).toBe(5);
    expect(redis.incr).toHaveBeenCalledWith("quota:api_key_456:proofs:create");
    // Expiration only set for first increment (newUsage === 1)
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it("does nothing when no quota configuration exists", async () => {
    prisma.apiKeyQuota.findUnique.mockResolvedValue(null);

    const result = await service.incrementUsage("api_key_456", "proofs:create");

    expect(result.newUsage).toBe(0);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it("handles Redis connection errors gracefully", async () => {
    const quota = createQuotaConfig({ quotaLimit: 100, quotaWindow: 3600 });
    prisma.apiKeyQuota.findUnique.mockResolvedValue(quota);
    redis.incr.mockRejectedValue(new Error("Redis unavailable"));

    const result = await service.incrementUsage("api_key_456", "proofs:create");

    // Should not throw - graceful degradation
    expect(result.newUsage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ApiKeyQuotaService.getQuotas
// ---------------------------------------------------------------------------

describe("ApiKeyQuotaService.getQuotas", () => {
  let service: ApiKeyQuotaService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    redis = makeRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyQuotaService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get<ApiKeyQuotaService>(ApiKeyQuotaService);
  });

  it("returns quota configurations for API key", async () => {
    const quotas = [
      createQuotaConfig({ scope: "proofs:create", quotaLimit: 100 }),
      createQuotaConfig({ scope: "proofs:read", quotaLimit: 1000 }),
    ];
    prisma.apiKeyQuota.findMany.mockResolvedValue(quotas);

    const result = await service.getQuotas("org_789", "api_key_456");

    expect(result).toHaveLength(2);
    expect(result[0].scope).toBe("proofs:create");
    expect(result[1].scope).toBe("proofs:read");
    expect(prisma.apiKeyQuota.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org_789",
        apiKeyId: "api_key_456",
      },
    });
  });

  it("returns empty array when no quotas exist", async () => {
    prisma.apiKeyQuota.findMany.mockResolvedValue([]);

    const result = await service.getQuotas("org_789", "api_key_456");

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ApiKeyQuotaService.updateQuota
// ---------------------------------------------------------------------------

describe("ApiKeyQuotaService.updateQuota", () => {
  let service: ApiKeyQuotaService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    redis = makeRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyQuotaService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get<ApiKeyQuotaService>(ApiKeyQuotaService);
  });

  it("updates quota configuration and clears Redis counter", async () => {
    const existingQuota = createQuotaConfig();
    const updateData = {
      quotaLimit: 200,
      quotaWindow: 7200,
    };

    prisma.apiKeyQuota.findUnique.mockResolvedValue(existingQuota);
    prisma.apiKeyQuota.update.mockResolvedValue({
      ...existingQuota,
      ...updateData,
    });

    const result = await service.updateQuota(
      "org_789",
      existingQuota.id,
      updateData,
    );

    expect(result.quotaLimit).toBe(200);
    expect(result.quotaWindow).toBe(7200);
    expect(prisma.apiKeyQuota.update).toHaveBeenCalledWith({
      where: { id: existingQuota.id, organizationId: "org_789" },
      data: updateData,
    });
    expect(redis.del).toHaveBeenCalledWith(
      "quota:api_key_456:proofs:create",
    );
  });

  it("throws NotFoundException for non-existent quota", async () => {
    prisma.apiKeyQuota.findUnique.mockResolvedValue(null);

    await expect(
      service.updateQuota("org_789", "nonexistent_id", {
        quotaLimit: 200,
      }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.apiKeyQuota.update).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ApiKeyQuotaService.deleteQuota
// ---------------------------------------------------------------------------

describe("ApiKeyQuotaService.deleteQuota", () => {
  let service: ApiKeyQuotaService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    redis = makeRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyQuotaService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get<ApiKeyQuotaService>(ApiKeyQuotaService);
  });

  it("deletes quota configuration and clears Redis counter", async () => {
    const existingQuota = createQuotaConfig();

    prisma.apiKeyQuota.findUnique.mockResolvedValue(existingQuota);
    prisma.apiKeyQuota.delete.mockResolvedValue(existingQuota);

    await service.deleteQuota("org_789", existingQuota.id);

    expect(prisma.apiKeyQuota.delete).toHaveBeenCalledWith({
      where: { id: existingQuota.id, organizationId: "org_789" },
    });
    expect(redis.del).toHaveBeenCalledWith(
      "quota:api_key_456:proofs:create",
    );
  });

  it("throws NotFoundException for non-existent quota", async () => {
    prisma.apiKeyQuota.findUnique.mockResolvedValue(null);

    await expect(
      service.deleteQuota("org_789", "nonexistent_id"),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.apiKeyQuota.delete).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });
});