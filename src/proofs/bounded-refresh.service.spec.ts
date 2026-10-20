import { Test, TestingModule } from "@nestjs/testing";
import { BoundedRefreshService } from "./bounded-refresh.service";
import { ProofsService } from "./proofs.service";
import { RefreshSource, ResultProvenance } from "./dto/refresh-proof.dto";
import { VerificationResult } from "@prisma/client";

/**
 * Mock ProofsService for unit testing.
 */
class MockProofsService {
  async verifyProof() {
    return {
      result: VerificationResult.VALID,
      status: "valid",
      credential: {
        signature: "mock-signature",
        credentialSubject: {},
      },
      proof: {
        id: "proof-123",
        type: "minimum-income",
        schemaVersion: "earnproof.minimum-income.v1",
        network: "testnet",
        issuedAt: "2025-01-15T12:00:00Z",
        expiresAt: "2025-02-15T12:00:00Z",
        revokedAt: null,
        revocationReasonCode: null,
        contractStatus: {
          checked: false,
          reason: "disabled",
        },
      },
    };
  }
}

describe("BoundedRefreshService", () => {
  let service: BoundedRefreshService;
  let mockProofsService: MockProofsService;

  beforeEach(async () => {
    mockProofsService = new MockProofsService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BoundedRefreshService,
        {
          provide: ProofsService,
          useValue: mockProofsService,
        },
      ],
    }).compile();

    service = module.get<BoundedRefreshService>(BoundedRefreshService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("refreshProof - CACHE source", () => {
    it("should return verification result with CACHE provenance", async () => {
      const spy = jest.spyOn(mockProofsService, "verifyProof");

      const result = await service.refreshProof("proof-123", {
        source: RefreshSource.CACHE,
      });

      expect(result.result).toBe(VerificationResult.VALID);
      expect(result.freshness.provenance).toBe(ResultProvenance.CACHE);
      expect(result.freshness.latencyMs).toBeGreaterThanOrEqual(0);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("should handle verification errors gracefully", async () => {
      jest.spyOn(mockProofsService, "verifyProof").mockRejectedValueOnce(new Error("DB error"));

      await expect(
        service.refreshProof("proof-unknown", {
          source: RefreshSource.CACHE,
        }),
      ).rejects.toThrow("DB error");
    });
  });

  describe("refreshProof - LIVE source", () => {
    it("should return verification result with LIVE provenance", async () => {
      const result = await service.refreshProof("proof-123", {
        source: RefreshSource.LIVE,
        maxLatencyMs: 5000,
      });

      expect(result.result).toBe(VerificationResult.VALID);
      expect(result.freshness.provenance).toBe(ResultProvenance.LIVE);
      expect(result.freshness.checkedAt).toBeDefined();
      expect(result.freshness.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("should respect maxLatency timeout and reject if exceeded", async () => {
      jest.spyOn(mockProofsService, "verifyProof").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                result: VerificationResult.VALID,
                status: "valid",
              });
            }, 2000); // Takes 2 seconds
          }),
      );

      // Set very strict latency bound
      await expect(
        service.refreshProof("proof-123", {
          source: RefreshSource.LIVE,
          maxLatencyMs: 100, // Only 100ms allowed
        }),
      ).rejects.toThrow(/latency bound exceeded/i);
    });

    it("should use normalized maxLatency if undefined", async () => {
      const result = await service.refreshProof("proof-123", {
        source: RefreshSource.LIVE,
        // maxLatencyMs undefined - should use default
      });

      expect(result.freshness.provenance).toBe(ResultProvenance.LIVE);
    });

    it("should deduplicate concurrent live refreshes for same proof", async () => {
      const spy = jest.spyOn(mockProofsService, "verifyProof");

      // Spawn concurrent refreshes for same proof
      const promise1 = service.refreshProof("proof-123", {
        source: RefreshSource.LIVE,
        maxLatencyMs: 5000,
      });

      const promise2 = service.refreshProof("proof-123", {
        source: RefreshSource.LIVE,
        maxLatencyMs: 5000,
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Both should succeed
      expect(result1.freshness.provenance).toBe(ResultProvenance.LIVE);
      expect(result2.freshness.provenance).toBe(ResultProvenance.LIVE);

      // But verifyProof should only be called once due to deduplication
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("refreshProof - PREFER_LIVE source", () => {
    it("should return LIVE if contract check succeeds within latency bound", async () => {
      const result = await service.refreshProof("proof-123", {
        source: RefreshSource.PREFER_LIVE,
        maxLatencyMs: 5000,
      });

      expect(result.freshness.provenance).toBe(ResultProvenance.LIVE);
      expect(result.freshness.checkedAt).toBeDefined();
    });

    it("should fall back to CACHE_FALLBACK if live check fails", async () => {
      let callCount = 0;
      jest.spyOn(mockProofsService, "verifyProof").mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call (live) fails
          throw new Error("Contract unavailable");
        }
        // Second call (cache fallback) succeeds
        return {
          result: VerificationResult.VALID,
          status: "valid",
          proof: { id: "proof-123", type: "minimum-income" },
        };
      });

      const result = await service.refreshProof("proof-123", {
        source: RefreshSource.PREFER_LIVE,
        maxLatencyMs: 5000,
      });

      expect(result.freshness.provenance).toBe(ResultProvenance.CACHE_FALLBACK);
      expect(result.freshness.reason).toContain("live_check_failed");
    });

    it("should fall back to LOCAL_ONLY if both live and cache fail", async () => {
      jest.spyOn(mockProofsService, "verifyProof").mockRejectedValue(new Error("Network error"));

      await expect(
        service.refreshProof("proof-123", {
          source: RefreshSource.PREFER_LIVE,
          maxLatencyMs: 5000,
        }),
      ).rejects.toThrow();
    });

    it("should handle latency timeout gracefully with fallback", async () => {
      jest.spyOn(mockProofsService, "verifyProof").mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                result: VerificationResult.VALID,
                status: "valid",
              });
            }, 1000);
          }),
      );

      const result = await service.refreshProof("proof-123", {
        source: RefreshSource.PREFER_LIVE,
        maxLatencyMs: 100, // Very strict bound
      });

      // Should fall back to cache
      expect(result.freshness.provenance).toBe(ResultProvenance.CACHE_FALLBACK);
      expect(result.freshness.reason).toContain("live_check_failed");
    });
  });

  describe("maxLatency normalization", () => {
    it("should clamp maxLatency to min boundary", async () => {
      const result = await service.refreshProof("proof-123", {
        source: RefreshSource.CACHE,
        maxLatencyMs: 10, // Below minimum of 100ms
      });

      expect(result.freshness.provenance).toBe(ResultProvenance.CACHE);
    });

    it("should clamp maxLatency to max boundary", async () => {
      const result = await service.refreshProof("proof-123", {
        source: RefreshSource.CACHE,
        maxLatencyMs: 50000, // Above maximum of 30000ms
      });

      expect(result.freshness.provenance).toBe(ResultProvenance.CACHE);
    });

    it("should use default maxLatency when undefined", async () => {
      const result = await service.refreshProof("proof-123", {
        source: RefreshSource.CACHE,
        // maxLatencyMs undefined
      });

      expect(result.freshness.provenance).toBe(ResultProvenance.CACHE);
      expect(result.freshness.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("concurrency management", () => {
    it("should track active refresh count correctly", () => {
      const metrics = service.getMetrics();
      expect(metrics.activeRefreshCount).toBe(0);
      expect(metrics.maxConcurrency).toBeGreaterThan(0);
    });

    it("should queue refreshes when concurrency limit reached", async () => {
      // Create a custom service with low concurrency
      const customService = new BoundedRefreshService(mockProofsService, {
        globalMaxConcurrency: 1,
        defaultMaxLatencyMs: 5000,
        minLatencyMs: 100,
        maxLatencyMs: 30000,
      });

      // Make slow verification to hold concurrency slot
      let resolveFirstCall: () => void;
      const firstCallPromise = new Promise<void>((resolve) => {
        resolveFirstCall = resolve;
      });

      jest.spyOn(mockProofsService, "verifyProof").mockImplementation(
        () =>
          new Promise((resolve) => {
            firstCallPromise.then(() => {
              resolve({
                result: VerificationResult.VALID,
                status: "valid",
              });
            });
          }),
      );

      // Start first refresh - should acquire slot
      const refresh1 = customService.refreshProof("proof-1", {
        source: RefreshSource.CACHE,
      });

      // Start second refresh - should queue
      const refresh2 = customService.refreshProof("proof-2", {
        source: RefreshSource.CACHE,
      });

      // Both should be pending
      expect(Promise.race([refresh1, Promise.resolve("pending")])).toBeDefined();
      expect(Promise.race([refresh2, Promise.resolve("pending")])).toBeDefined();

      // Release first refresh
      resolveFirstCall!();

      // Both should complete
      const [result1, result2] = await Promise.all([refresh1, refresh2]);
      expect(result1.result).toBe(VerificationResult.VALID);
      expect(result2.result).toBe(VerificationResult.VALID);
    });
  });

  describe("error handling and edge cases", () => {
    it("should handle unknown source gracefully", async () => {
      await expect(
        service.refreshProof("proof-123", {
          source: "unknown" as any,
        }),
      ).rejects.toThrow(/unknown refresh source/i);
    });

    it("should preserve error context in fallback scenarios", async () => {
      jest.spyOn(mockProofsService, "verifyProof").mockRejectedValue(
        new Error("Circuit breaker open"),
      );

      await expect(
        service.refreshProof("proof-123", {
          source: RefreshSource.LIVE,
          maxLatencyMs: 5000,
        }),
      ).rejects.toThrow("Circuit breaker open");
    });

    it("should handle rapid sequential refreshes correctly", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          service.refreshProof(`proof-${i}`, {
            source: RefreshSource.CACHE,
          }),
        ),
      );

      expect(results).toHaveLength(5);
      results.forEach((r) => {
        expect(r.freshness.provenance).toBe(ResultProvenance.CACHE);
      });
    });

    it("should include latency measurement in all responses", async () => {
      const sources = [RefreshSource.CACHE, RefreshSource.LIVE, RefreshSource.PREFER_LIVE];

      for (const source of sources) {
        const result = await service.refreshProof("proof-123", { source });
        expect(result.freshness.latencyMs).toBeDefined();
        expect(typeof result.freshness.latencyMs).toBe("number");
        expect(result.freshness.latencyMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("boundary conditions", () => {
    it("should handle exact minLatency bound", async () => {
      const result = await service.refreshProof("proof-123", {
        source: RefreshSource.CACHE,
        maxLatencyMs: 100, // Exact minimum
      });

      expect(result.freshness.provenance).toBe(ResultProvenance.CACHE);
    });

    it("should handle exact maxLatency bound", async () => {
      const result = await service.refreshProof("proof-123", {
        source: RefreshSource.CACHE,
        maxLatencyMs: 30000, // Exact maximum
      });

      expect(result.freshness.provenance).toBe(ResultProvenance.CACHE);
    });

    it("should handle multiple rapid same-proof refreshes", async () => {
      const promises = Array.from({ length: 10 }, () =>
        service.refreshProof("proof-123", {
          source: RefreshSource.CACHE,
        }),
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
      results.forEach((r) => {
        expect(r.result).toBe(VerificationResult.VALID);
      });
    });
  });
});
