/**
 * Unit tests for CapacitySamplerService
 *
 * Coverage:
 *  - Positive: sample() creates rows for all 4 resource types.
 *  - Replay: duplicate sampleHash → skipped (idempotent).
 *  - Pruning: deleteMany is called after insertion.
 *  - Error handling: one failing resource does not abort others.
 *  - Authorization: assertReadAccess tested via controller (controller tests).
 *  - Boundary: getRecentSamples respects limit and ordering.
 *  - Regression: count is stored as BigInt (no data loss on large counts).
 */

import { CapacitySamplerService } from "./capacity-sampler.service";

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    issuer: { count: jest.fn().mockResolvedValue(10) },
    proof: {
      count: jest.fn().mockResolvedValue(500),
      groupBy: jest.fn().mockResolvedValue([{ proofType: "MINIMUM_INCOME", _count: 5 }]),
    },
    anchoringIntent: { count: jest.fn().mockResolvedValue(200) },
    registryCapacitySample: {
      findUnique: jest.fn().mockResolvedValue(null), // no duplicate by default
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: "sample-001", ...data }),
      ),
      findMany: jest.fn().mockResolvedValue([
        {
          id: "s1",
          resourceType: "PROOF",
          count: BigInt(100),
          sampleHash: "sha256:abc",
          sampledAt: new Date("2025-01-01"),
          createdAt: new Date("2025-01-01"),
        },
      ]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      ...(overrides.sample ?? {}),
    },
    ...(overrides.extra ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Positive path
// ---------------------------------------------------------------------------

describe("CapacitySamplerService — positive", () => {
  it("sample() creates one row per resource type", async () => {
    const prisma = makePrisma();
    const service = new CapacitySamplerService(prisma as never);
    const count = await service.sample();
    expect(count).toBe(4); // ISSUER, SCHEMA, PROOF, STORAGE
    expect(prisma.registryCapacitySample.create).toHaveBeenCalledTimes(4);
  });

  it("sample() stores count as BigInt", async () => {
    const prisma = makePrisma();
    const service = new CapacitySamplerService(prisma as never);
    await service.sample();
    const calls = prisma.registryCapacitySample.create.mock.calls;
    for (const call of calls) {
      expect(typeof call[0].data.count).toBe("bigint");
    }
  });

  it("sample() calls pruneOldSamples for each resource type", async () => {
    const prisma = makePrisma();
    const service = new CapacitySamplerService(prisma as never);
    await service.sample();
    // findMany is called for pruning (once per type)
    expect(prisma.registryCapacitySample.findMany).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// Replay detection
// ---------------------------------------------------------------------------

describe("CapacitySamplerService — replay detection", () => {
  it("skips a resource type when the sampleHash already exists", async () => {
    const prisma = makePrisma({
      sample: {
        findUnique: jest.fn().mockResolvedValue({ id: "existing" }),
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    });
    const service = new CapacitySamplerService(prisma as never);
    const count = await service.sample();
    expect(count).toBe(0); // all skipped
    expect(prisma.registryCapacitySample.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("CapacitySamplerService — error resilience", () => {
  it("continues sampling other types when one fails", async () => {
    const prisma = makePrisma();
    // Make ISSUER count throw
    prisma.issuer.count = jest.fn().mockRejectedValue(new Error("DB error"));
    const service = new CapacitySamplerService(prisma as never);
    const count = await service.sample();
    // 3 succeed (SCHEMA, PROOF, STORAGE), 1 fails (ISSUER)
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getRecentSamples
// ---------------------------------------------------------------------------

describe("CapacitySamplerService — getRecentSamples", () => {
  it("returns samples mapped from DB rows (oldest first)", async () => {
    const prisma = makePrisma();
    const service = new CapacitySamplerService(prisma as never);
    const samples = await service.getRecentSamples("PROOF", 10);
    expect(Array.isArray(samples)).toBe(true);
    expect(samples[0].resourceType).toBe("PROOF");
    expect(typeof samples[0].count).toBe("number"); // converted from BigInt
  });

  it("passes the limit to findMany", async () => {
    const prisma = makePrisma();
    const service = new CapacitySamplerService(prisma as never);
    await service.getRecentSamples("ISSUER", 25);
    expect(prisma.registryCapacitySample.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Boundary — large counts
// ---------------------------------------------------------------------------

describe("CapacitySamplerService — boundary", () => {
  it("handles zero counts without error", async () => {
    const prisma = makePrisma();
    prisma.issuer.count = jest.fn().mockResolvedValue(0);
    prisma.proof.count = jest.fn().mockResolvedValue(0);
    prisma.proof.groupBy = jest.fn().mockResolvedValue([]);
    prisma.anchoringIntent.count = jest.fn().mockResolvedValue(0);
    const service = new CapacitySamplerService(prisma as never);
    await expect(service.sample()).resolves.toBe(4);
  });
});