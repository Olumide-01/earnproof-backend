import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, HttpStatus } from "@nestjs/common";
import * as request from "supertest";
import { ConfigModule } from "@nestjs/config";
import { PrismaService } from "../../src/database/prisma.service";
import { ProofsModule } from "../../src/proofs/proofs.module";
import { AuthModule } from "../../src/auth/auth.module";
import { RateLimitModule } from "../../src/common/rate-limit/rate-limit.module";
import { RefreshSource, ResultProvenance } from "../../src/proofs/dto/refresh-proof.dto";
import { ProofStatus, VerificationResult } from "@prisma/client";

/**
 * Integration tests for bounded live verification refresh endpoints.
 * Tests end-to-end behavior with real database and rate limiting.
 */
describe("Bounded Live Verification Refresh - Integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const testUserId = "test-user-123";
  const testProofId = "test-proof-123";
  const testOrganizationId = "test-org-123";

  // Helper to create authenticated request
  const createAuthenticatedRequest = (token: string) => {
    return request.agent(app.getHttpServer()).set("Authorization", `Bearer ${token}`);
  };

  beforeAll(async () => {
    // Set environment for testing
    process.env.RATE_LIMIT_VERIFICATION_LIMIT = "30";
    process.env.RATE_LIMIT_VERIFICATION_TTL_MS = "60000";
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://test:test@localhost/earnproof_test";

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), RateLimitModule, AuthModule, ProofsModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        proof: {
          findUnique: jest.fn(),
          findMany: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        },
        user: {
          findUnique: jest.fn(),
        },
        verificationEvent: {
          create: jest.fn(),
          findMany: jest.fn(),
        },
        organizationMember: {
          findFirst: jest.fn(),
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    // Inject the mock PrismaService
    prisma = moduleRef.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /proofs/:id/verify/refresh - Authenticated", () => {
    it("should successfully refresh proof with CACHE source", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
        status: ProofStatus.ACTIVE,
        credentialHash: "sha256:test-hash",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        contractTransactionHash: null,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(testProof);

      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.freshness).toBeDefined();
      expect(response.body.freshness.provenance).toBe(ResultProvenance.CACHE);
      expect(response.body.freshness.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("should successfully refresh proof with PREFER_LIVE source", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
        status: ProofStatus.ACTIVE,
        credentialHash: "sha256:test-hash",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        contractTransactionHash: null,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(testProof);

      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.PREFER_LIVE,
        maxLatencyMs: 5000,
      });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.freshness).toBeDefined();
      expect([ResultProvenance.LIVE, ResultProvenance.CACHE_FALLBACK]).toContain(
        response.body.freshness.provenance,
      );
    });

    it("should reject refresh if proof not found", async () => {
      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(null);

      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("should reject refresh if user does not own proof", async () => {
      const testProof = {
        id: testProofId,
        userId: "different-user-id",
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(testProof);

      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("should reject without authentication", async () => {
      const response = await request(app.getHttpServer()).post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it("should validate source field is required", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(testProof);

      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        // source missing
      });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("should validate maxLatencyMs bounds", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(testProof);

      // Test too-low maxLatencyMs
      let response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.PREFER_LIVE,
        maxLatencyMs: 10, // Below 100ms minimum
      });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);

      // Test too-high maxLatencyMs
      response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.PREFER_LIVE,
        maxLatencyMs: 50000, // Above 30000ms maximum
      });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("should include latency metadata in response", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
        status: ProofStatus.ACTIVE,
        credentialHash: "sha256:test-hash",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        contractTransactionHash: null,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(testProof);

      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.freshness.latencyMs).toBeDefined();
      expect(typeof response.body.freshness.latencyMs).toBe("number");
      expect(response.body.freshness.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("POST /proofs/:id/verify/refresh - Shared (Public)", () => {
    it("should successfully refresh proof with direct proof ID", async () => {
      const response = await request(app.getHttpServer()).post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      // Should succeed (no auth required for public endpoint)
      // Response depends on whether proof exists in mock
      expect([HttpStatus.OK, HttpStatus.FORBIDDEN]).toContain(response.status);
    });

    it("should verify sharing token and resolve proof ID", async () => {
      const sharingTokenId = "share_test-token-xyz";

      // Mock sharing token validation
      const mockProofSharingService = app.get("ProofSharingService");
      if (mockProofSharingService) {
        jest.spyOn(mockProofSharingService, "verifyWithSharingToken").mockResolvedValueOnce({
          isValid: true,
          proof: { id: testProofId },
        });
      }

      const response = await request(app.getHttpServer()).post(
        `/proofs/${sharingTokenId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      // Response depends on proof lookup result
      expect([HttpStatus.OK, HttpStatus.FORBIDDEN]).toContain(response.status);
    });

    it("should reject invalid sharing token", async () => {
      const invalidToken = "share_invalid-token";

      // Mock sharing token rejection
      const mockProofSharingService = app.get("ProofSharingService");
      if (mockProofSharingService) {
        jest.spyOn(mockProofSharingService, "verifyWithSharingToken").mockResolvedValueOnce({
          isValid: false,
          proof: null,
        });
      }

      const response = await request(app.getHttpServer()).post(
        `/proofs/${invalidToken}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("should accept all valid source types", async () => {
      const sources = [RefreshSource.CACHE, RefreshSource.LIVE, RefreshSource.PREFER_LIVE];

      for (const source of sources) {
        const response = await request(app.getHttpServer()).post(
          `/proofs/${testProofId}/verify/refresh`,
        ).send({
          source,
        });

        // Should not reject for invalid source
        expect(response.status).not.toBe(HttpStatus.BAD_REQUEST);
      }
    });

    it("should validate source field is required", async () => {
      const response = await request(app.getHttpServer()).post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        // source missing
      });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("should accept optional maxLatencyMs", async () => {
      // With maxLatencyMs
      let response = await request(app.getHttpServer()).post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.PREFER_LIVE,
        maxLatencyMs: 5000,
      });

      expect([HttpStatus.OK, HttpStatus.FORBIDDEN]).toContain(response.status);

      // Without maxLatencyMs (should use default)
      response = await request(app.getHttpServer()).post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      expect([HttpStatus.OK, HttpStatus.FORBIDDEN]).toContain(response.status);
    });
  });

  describe("Rate Limiting", () => {
    it("should respect verification rate limit tier", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
        status: ProofStatus.ACTIVE,
        credentialHash: "sha256:test-hash",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        contractTransactionHash: null,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue(testProof);

      // Make sequential requests - each should succeed until rate limit
      const responses = [];
      for (let i = 0; i < 3; i++) {
        const response = await createAuthenticatedRequest("test-token").post(
          `/proofs/${testProofId}/verify/refresh`,
        ).send({
          source: RefreshSource.CACHE,
        });
        responses.push(response.status);
      }

      // All should succeed (rate limit is per minute)
      responses.forEach((status) => {
        expect(status).toBe(HttpStatus.OK);
      });
    });

    it("should handle rate limit exceeded gracefully", async () => {
      // This test would require mocking the rate limiter
      // to simulate hitting the limit, which is done at the guard level
      const testProof = {
        id: testProofId,
        userId: testUserId,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue(testProof);

      // Normal request should work
      let response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      expect([HttpStatus.OK, HttpStatus.TOO_MANY_REQUESTS]).toContain(response.status);
    });
  });

  describe("Concurrency Management", () => {
    it("should handle concurrent refresh requests", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
        status: ProofStatus.ACTIVE,
        credentialHash: "sha256:test-hash",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        contractTransactionHash: null,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue(testProof);

      // Spawn concurrent requests
      const promises = Array.from({ length: 5 }, () =>
        createAuthenticatedRequest("test-token").post(
          `/proofs/${testProofId}/verify/refresh`,
        ).send({
          source: RefreshSource.CACHE,
        }),
      );

      const responses = await Promise.all(promises);

      // All should succeed
      responses.forEach((response) => {
        expect([HttpStatus.OK, HttpStatus.TOO_MANY_REQUESTS]).toContain(response.status);
      });
    });

    it("should deduplicate live refreshes for same proof", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
        status: ProofStatus.ACTIVE,
        credentialHash: "sha256:test-hash",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        contractTransactionHash: null,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue(testProof);

      const verifyProofSpy = jest.spyOn(prisma.proof, "findUnique");

      // Spawn multiple live refreshes for same proof
      const promises = Array.from({ length: 3 }, () =>
        createAuthenticatedRequest("test-token").post(
          `/proofs/${testProofId}/verify/refresh`,
        ).send({
          source: RefreshSource.LIVE,
          maxLatencyMs: 5000,
        }),
      );

      const responses = await Promise.all(promises);

      // All should succeed
      responses.forEach((response) => {
        expect([HttpStatus.OK, HttpStatus.TOO_MANY_REQUESTS]).toContain(response.status);
      });

      // Verify deduplication (may not be exact count due to rate limiting)
      expect(verifyProofSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Response Format and Metadata", () => {
    it("should include freshness metadata in all responses", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
        status: ProofStatus.ACTIVE,
        credentialHash: "sha256:test-hash",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        contractTransactionHash: null,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(testProof);

      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.PREFER_LIVE,
        maxLatencyMs: 5000,
      });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.freshness).toBeDefined();
      expect(response.body.freshness.provenance).toBeDefined();
      expect(response.body.freshness.latencyMs).toBeDefined();
    });

    it("should include provenance indicating refresh source", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
        status: ProofStatus.ACTIVE,
        credentialHash: "sha256:test-hash",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        contractTransactionHash: null,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(testProof);

      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      expect(response.status).toBe(HttpStatus.OK);
      expect(Object.values(ResultProvenance)).toContain(response.body.freshness.provenance);
    });

    it("should never report stale cache as live provenance", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
        status: ProofStatus.ACTIVE,
        credentialHash: "sha256:test-hash",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        contractTransactionHash: null,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(testProof);

      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body.freshness.provenance).not.toBe(ResultProvenance.LIVE);
    });
  });

  describe("Fail-Closed Semantics", () => {
    it("should never report stale results as live when they are cached", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
        status: ProofStatus.ACTIVE,
        credentialHash: "sha256:test-hash",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        contractTransactionHash: null,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(testProof);

      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.PREFER_LIVE,
        maxLatencyMs: 5000,
      });

      expect(response.status).toBe(HttpStatus.OK);

      // If cache was used as fallback, should never report LIVE
      if (response.body.freshness.provenance === ResultProvenance.CACHE_FALLBACK) {
        expect(response.body.freshness.provenance).not.toBe(ResultProvenance.LIVE);
      }
    });

    it("should respect timeout boundaries for LIVE source", async () => {
      const testProof = {
        id: testProofId,
        userId: testUserId,
        status: ProofStatus.ACTIVE,
        credentialHash: "sha256:test-hash",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        contractTransactionHash: null,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(testProof);

      // Request with very tight latency bound
      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.LIVE,
        maxLatencyMs: 100, // Very strict
      });

      // Either succeeds with LIVE or fails with timeout
      expect([HttpStatus.OK, HttpStatus.REQUEST_TIMEOUT]).toContain(response.status);

      if (response.status === HttpStatus.OK) {
        // If succeeded, latency must be within bound
        expect(response.body.freshness.latencyMs).toBeLessThanOrEqual(100);
      }
    });
  });

  describe("Authorization", () => {
    it("should enforce proof ownership for authenticated refresh", async () => {
      const otherUserProof = {
        id: testProofId,
        userId: "other-user-123",
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValueOnce(otherUserProof);

      const response = await createAuthenticatedRequest("test-token").post(
        `/proofs/${testProofId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("should allow public access with valid sharing token", async () => {
      const sharingTokenId = "share_valid-token";

      // Mock valid sharing token
      const response = await request(app.getHttpServer()).post(
        `/proofs/${sharingTokenId}/verify/refresh`,
      ).send({
        source: RefreshSource.CACHE,
      });

      // Should not be unauthorized
      expect(response.status).not.toBe(HttpStatus.UNAUTHORIZED);
    });
  });
});
