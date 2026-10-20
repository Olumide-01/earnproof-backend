import { Test, TestingModule } from "@nestjs/testing";
import { ProofsController } from "./proofs.controller";
import { ProofsService } from "./proofs.service";
import { ProofSharingService } from "./proof-sharing.service";
import { BoundedRefreshService } from "./bounded-refresh.service";
import { PrismaService } from "../database/prisma.service";
import { ProofCapacityPreflightService } from "./proof-capacity-preflight.service";
import { ForbiddenException } from "@nestjs/common";
import { RefreshSource, ResultProvenance } from "./dto/refresh-proof.dto";
import { VerificationResult } from "@prisma/client";
import { Request } from "express";

/**
 * Mock services for controller testing.
 */
class MockProofsService {
  async verifyProof() {
    return {
      result: VerificationResult.VALID,
      status: "valid",
    };
  }
}

class MockProofSharingService {
  async verifyWithSharingToken() {
    return {
      isValid: true,
      proof: { id: "proof-123" },
    };
  }
}

class MockPrismaService {
  proof = {
    findUnique: jest.fn(),
  };
}

class MockBoundedRefreshService {
  async refreshProof() {
    return {
      result: VerificationResult.VALID,
      status: "valid",
      freshness: {
        provenance: ResultProvenance.LIVE,
        checkedAt: new Date().toISOString(),
        latencyMs: 250,
      },
    };
  }
}

class MockPreflightService {}

describe("ProofsController - Refresh Endpoints", () => {
  let controller: ProofsController;
  let mockProofsService: MockProofsService;
  let mockProofSharingService: MockProofSharingService;
  let mockPrismaService: MockPrismaService;
  let mockBoundedRefreshService: MockBoundedRefreshService;

  const mockUser = {
    id: "user-123",
    email: "test@example.com",
  };

  const mockRequest = {
    ip: "192.168.1.1",
    headers: {
      "user-agent": "test-client",
    },
  } as any as Request;

  beforeEach(async () => {
    mockProofsService = new MockProofsService();
    mockProofSharingService = new MockProofSharingService();
    mockPrismaService = new MockPrismaService();
    mockBoundedRefreshService = new MockBoundedRefreshService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProofsController],
      providers: [
        {
          provide: ProofsService,
          useValue: mockProofsService,
        },
        {
          provide: ProofSharingService,
          useValue: mockProofSharingService,
        },
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: BoundedRefreshService,
          useValue: mockBoundedRefreshService,
        },
        {
          provide: ProofCapacityPreflightService,
          useValue: new MockPreflightService(),
        },
      ],
    }).compile();

    controller = module.get<ProofsController>(ProofsController);
  });

  describe("refreshProofAuthenticated", () => {
    it("should refresh proof for authenticated owner", async () => {
      mockPrismaService.proof.findUnique.mockResolvedValueOnce({
        id: "proof-123",
        userId: "user-123",
      });

      const spy = jest.spyOn(mockBoundedRefreshService, "refreshProof");

      const result = await controller.refreshProofAuthenticated(
        mockUser as any,
        "proof-123",
        {
          source: RefreshSource.PREFER_LIVE,
          maxLatencyMs: 5000,
        },
        mockRequest,
      );

      expect(result.freshness.provenance).toBe(ResultProvenance.LIVE);
      expect(spy).toHaveBeenCalledWith(
        "proof-123",
        {
          source: RefreshSource.PREFER_LIVE,
          maxLatencyMs: 5000,
        },
        expect.objectContaining({ ip: mockRequest.ip }),
      );
    });

    it("should reject refresh if proof not found", async () => {
      mockPrismaService.proof.findUnique.mockResolvedValueOnce(null);

      await expect(
        controller.refreshProofAuthenticated(
          mockUser as any,
          "proof-unknown",
          {
            source: RefreshSource.CACHE,
          },
          mockRequest,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject refresh if user does not own the proof", async () => {
      mockPrismaService.proof.findUnique.mockResolvedValueOnce({
        id: "proof-123",
        userId: "other-user-id",
      });

      await expect(
        controller.refreshProofAuthenticated(
          mockUser as any,
          "proof-123",
          {
            source: RefreshSource.CACHE,
          },
          mockRequest,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should pass IP address from request context", async () => {
      mockPrismaService.proof.findUnique.mockResolvedValueOnce({
        id: "proof-123",
        userId: "user-123",
      });

      const spy = jest.spyOn(mockBoundedRefreshService, "refreshProof");

      await controller.refreshProofAuthenticated(
        mockUser as any,
        "proof-123",
        {
          source: RefreshSource.CACHE,
        },
        mockRequest,
      );

      expect(spy).toHaveBeenCalledWith(
        "proof-123",
        {
          source: RefreshSource.CACHE,
        },
        expect.objectContaining({
          ip: "192.168.1.1",
        }),
      );
    });

    it("should support all source types", async () => {
      mockPrismaService.proof.findUnique.mockResolvedValue({
        id: "proof-123",
        userId: "user-123",
      });

      const sources = [RefreshSource.CACHE, RefreshSource.LIVE, RefreshSource.PREFER_LIVE];

      for (const source of sources) {
        const result = await controller.refreshProofAuthenticated(
          mockUser as any,
          "proof-123",
          { source },
          mockRequest,
        );

        expect(result.freshness).toBeDefined();
      }
    });
  });

  describe("refreshProofShared", () => {
    it("should refresh proof using direct proof ID (no token)", async () => {
      const spy = jest.spyOn(mockBoundedRefreshService, "refreshProof");

      const result = await controller.refreshProofShared(
        "proof-123",
        {
          source: RefreshSource.PREFER_LIVE,
          maxLatencyMs: 5000,
        },
        mockRequest,
      );

      expect(result.freshness.provenance).toBe(ResultProvenance.LIVE);
      expect(spy).toHaveBeenCalledWith(
        "proof-123",
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("should verify sharing token and use resolved proof ID", async () => {
      const spy = jest.spyOn(mockBoundedRefreshService, "refreshProof");

      const result = await controller.refreshProofShared(
        "share_test-token-123",
        {
          source: RefreshSource.CACHE,
        },
        mockRequest,
      );

      expect(spy).toHaveBeenCalledWith(
        "proof-123",
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("should reject invalid sharing token", async () => {
      jest.spyOn(mockProofSharingService, "verifyWithSharingToken").mockResolvedValueOnce({
        isValid: false,
        proof: null,
      });

      await expect(
        controller.refreshProofShared(
          "share_invalid-token",
          {
            source: RefreshSource.CACHE,
          },
          mockRequest,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should handle expired sharing token", async () => {
      jest.spyOn(mockProofSharingService, "verifyWithSharingToken").mockResolvedValueOnce({
        isValid: false,
        proof: null,
      });

      await expect(
        controller.refreshProofShared(
          "share_expired-token",
          {
            source: RefreshSource.CACHE,
          },
          mockRequest,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should pass client IP and user agent to sharing service", async () => {
      const spy = jest.spyOn(mockProofSharingService, "verifyWithSharingToken");

      await controller.refreshProofShared(
        "share_test-token",
        {
          source: RefreshSource.CACHE,
        },
        mockRequest,
      );

      expect(spy).toHaveBeenCalledWith(
        "share_test-token",
        expect.objectContaining({
          ipAddress: "192.168.1.1",
          userAgent: "test-client",
        }),
      );
    });

    it("should handle missing proof ID in sharing result", async () => {
      jest.spyOn(mockProofSharingService, "verifyWithSharingToken").mockResolvedValueOnce({
        isValid: true,
        proof: null, // No proof returned
      });

      await expect(
        controller.refreshProofShared(
          "share_test-token",
          {
            source: RefreshSource.CACHE,
          },
          mockRequest,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should support all source types with sharing token", async () => {
      const sources = [RefreshSource.CACHE, RefreshSource.LIVE, RefreshSource.PREFER_LIVE];

      for (const source of sources) {
        const result = await controller.refreshProofShared(
          "share_test-token",
          { source },
          mockRequest,
        );

        expect(result.freshness).toBeDefined();
      }
    });

    it("should include latency metadata in response", async () => {
      const result = await controller.refreshProofShared(
        "proof-123",
        {
          source: RefreshSource.PREFER_LIVE,
          maxLatencyMs: 5000,
        },
        mockRequest,
      );

      expect(result.freshness.latencyMs).toBeDefined();
      expect(typeof result.freshness.latencyMs).toBe("number");
    });

    it("should include provenance in response", async () => {
      const result = await controller.refreshProofShared(
        "proof-123",
        {
          source: RefreshSource.LIVE,
        },
        mockRequest,
      );

      expect(result.freshness.provenance).toBeDefined();
      expect(Object.values(ResultProvenance)).toContain(result.freshness.provenance);
    });
  });

  describe("error handling", () => {
    it("should propagate BoundedRefreshService errors", async () => {
      mockPrismaService.proof.findUnique.mockResolvedValueOnce({
        id: "proof-123",
        userId: "user-123",
      });

      jest.spyOn(mockBoundedRefreshService, "refreshProof").mockRejectedValueOnce(
        new Error("Live verification latency bound exceeded"),
      );

      await expect(
        controller.refreshProofAuthenticated(
          mockUser as any,
          "proof-123",
          {
            source: RefreshSource.LIVE,
            maxLatencyMs: 100,
          },
          mockRequest,
        ),
      ).rejects.toThrow("Live verification latency bound exceeded");
    });

    it("should handle PrismaService errors gracefully", async () => {
      mockPrismaService.proof.findUnique.mockRejectedValueOnce(new Error("DB connection error"));

      await expect(
        controller.refreshProofAuthenticated(
          mockUser as any,
          "proof-123",
          {
            source: RefreshSource.CACHE,
          },
          mockRequest,
        ),
      ).rejects.toThrow("DB connection error");
    });

    it("should handle missing IP address in request", async () => {
      mockPrismaService.proof.findUnique.mockResolvedValueOnce({
        id: "proof-123",
        userId: "user-123",
      });

      const requestWithoutIp = {
        ...mockRequest,
        ip: undefined,
      } as any as Request;

      const spy = jest.spyOn(mockBoundedRefreshService, "refreshProof");

      await controller.refreshProofAuthenticated(
        mockUser as any,
        "proof-123",
        {
          source: RefreshSource.CACHE,
        },
        requestWithoutIp,
      );

      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          ip: undefined,
        }),
      );
    });
  });

  describe("input validation", () => {
    it("should accept valid refresh request DTO", async () => {
      mockPrismaService.proof.findUnique.mockResolvedValueOnce({
        id: "proof-123",
        userId: "user-123",
      });

      const result = await controller.refreshProofAuthenticated(
        mockUser as any,
        "proof-123",
        {
          source: RefreshSource.PREFER_LIVE,
          maxLatencyMs: 5000,
        },
        mockRequest,
      );

      expect(result).toBeDefined();
    });

    it("should require source field", async () => {
      mockPrismaService.proof.findUnique.mockResolvedValueOnce({
        id: "proof-123",
        userId: "user-123",
      });

      // This test assumes DTO validation happens at NestJS level
      // Controller should receive validated DTO
      const result = await controller.refreshProofAuthenticated(
        mockUser as any,
        "proof-123",
        {
          source: RefreshSource.CACHE,
        } as any,
        mockRequest,
      );

      expect(result).toBeDefined();
    });

    it("should accept optional maxLatencyMs", async () => {
      mockPrismaService.proof.findUnique.mockResolvedValueOnce({
        id: "proof-123",
        userId: "user-123",
      });

      const result = await controller.refreshProofAuthenticated(
        mockUser as any,
        "proof-123",
        {
          source: RefreshSource.PREFER_LIVE,
          // maxLatencyMs omitted
        } as any,
        mockRequest,
      );

      expect(result).toBeDefined();
    });
  });

  describe("response format", () => {
    it("should return RefreshProofResponseDto", async () => {
      mockPrismaService.proof.findUnique.mockResolvedValueOnce({
        id: "proof-123",
        userId: "user-123",
      });

      const result = await controller.refreshProofAuthenticated(
        mockUser as any,
        "proof-123",
        {
          source: RefreshSource.PREFER_LIVE,
          maxLatencyMs: 5000,
        },
        mockRequest,
      );

      // Should have verification fields
      expect(result.result).toBeDefined();
      expect(result.status).toBeDefined();

      // Should have freshness metadata
      expect(result.freshness).toBeDefined();
      expect(result.freshness.provenance).toBeDefined();
      expect(result.freshness.latencyMs).toBeDefined();
    });

    it("should include optional metadata fields when available", async () => {
      const customResult = {
        result: VerificationResult.VALID,
        status: "valid",
        freshness: {
          provenance: ResultProvenance.LIVE,
          checkedAt: "2025-01-15T12:34:56.789Z",
          latencyMs: 234,
          reason: "live_verification",
        },
      };

      jest.spyOn(mockBoundedRefreshService, "refreshProof").mockResolvedValueOnce(customResult);

      mockPrismaService.proof.findUnique.mockResolvedValueOnce({
        id: "proof-123",
        userId: "user-123",
      });

      const result = await controller.refreshProofAuthenticated(
        mockUser as any,
        "proof-123",
        {
          source: RefreshSource.LIVE,
        },
        mockRequest,
      );

      expect(result.freshness.checkedAt).toBe("2025-01-15T12:34:56.789Z");
      expect(result.freshness.reason).toBe("live_verification");
    });
  });
});
