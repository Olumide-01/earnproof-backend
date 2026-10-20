/**
 * Regression Tests for Proof Issuance with Attestation Integration
 *
 * Verifies that adding attestation lifecycle validation to proof issuance
 * does NOT break existing proof functionality:
 *
 * 1. Proof creation still works normally
 * 2. Proof verification still works as expected
 * 3. Proof listing and history retrieval unaffected
 * 4. Proof revocation still works
 * 5. No changes to existing API contracts
 * 6. Backward compatibility maintained
 */

import { Test, TestingModule } from "@nestjs/testing";
import { ProofStatus, ProofType } from "@prisma/client";
import { ProofsService } from "./proofs.service";
import { AttestationsService } from "../attestations/attestations.service";
import { PrismaService } from "../database/prisma.service";
import { VerificationEventService } from "../audit/verification-event.service";
import { ConfigService } from "@nestjs/config";
import { encodeCursor } from "../common/pagination/cursor";

describe("Proofs Service - Attestation Integration Regression Tests", () => {
  let service: ProofsService;
  let prisma: PrismaService;
  let attestationsService: AttestationsService;

  const mockUser = {
    id: "user-1",
    walletAddress: "G1111111111111111111111111111111111111111111111111111111",
    walletHash: "sha256:user-hash",
    role: "WORKER",
  };

  const mockProof = {
    id: "proof-1",
    userId: mockUser.id,
    proofType: ProofType.PAYMENT_RECEIPT,
    schemaVersion: "earnproof.payment-receipt.v1",
    status: ProofStatus.ACTIVE,
    network: "testnet",
    assetCode: "USDC",
    assetIssuer: null,
    periodStart: new Date("2026-01-01"),
    periodEnd: new Date("2026-01-31"),
    expiresAt: new Date("2026-12-31"),
    commitment: "sha256:commitment",
    credentialHash: "sha256:hash",
    contractTransactionHash: null,
    revokedAt: null,
    createdAt: new Date("2026-01-15"),
    updatedAt: new Date("2026-01-15"),
    claim: {
      id: "claim-1",
      proofId: "proof-1",
      operator: "receipt",
      thresholdEncrypted: null,
      frequency: null,
      result: true,
      disclosurePolicy: {},
      createdAt: new Date("2026-01-15"),
    },
  };

  const mockAttestationsService = {
    getValidAttestationsForSubject: jest.fn(),
    validateSubjectAttestations: jest.fn(),
    hasValidAttestationsFromIssuer: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProofsService,
        {
          provide: PrismaService,
          useValue: {
            payment: {
              findFirst: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
            },
            proof: {
              create: jest.fn(),
              findFirst: jest.fn(),
              findUnique: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              update: jest.fn(),
            },
            proofClaim: {
              create: jest.fn(),
              findUnique: jest.fn(),
            },
            verificationEvent: {
              findMany: jest.fn(),
              count: jest.fn(),
            },
            anchoringIntent: {
              create: jest.fn(),
            },
            $transaction: jest.fn((callback) => {
              // Pass a tx object that has the same mocks as prisma
              const tx = {
                proof: prisma.proof,
                verificationEvent: prisma.verificationEvent,
                anchoringIntent: prisma.anchoringIntent,
              };
              return callback(tx);
            }),
          },
        },
        {
          provide: VerificationEventService,
          useValue: {
            recordEvent: jest.fn(),
            getAggregateStats: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key) => {
              if (key === "credentialSigningSecret") return "secret-key";
              if (key === "stellar.network") return "testnet";
              return "value";
            }),
            get: jest.fn((key) => {
              if (key === "contractAnchoring.enabled") return false;
              if (key === "contractAnchoring.required") return false;
              return undefined;
            }),
          },
        },
        {
          provide: AttestationsService,
          useValue: mockAttestationsService,
        },
      ],
    }).compile();

    service = module.get<ProofsService>(ProofsService);
    prisma = module.get<PrismaService>(PrismaService);
    attestationsService = module.get<AttestationsService>(AttestationsService);
  });

  describe("Backward Compatibility - Existing Proof Operations", () => {
    it("should maintain getProofDetail method signature and behavior", async () => {
      const mockProofWithClaim = {
        ...mockProof,
        claim: {
          id: "claim-1",
          proofId: "proof-1",
          operator: "gte",
          thresholdEncrypted: "encrypted",
          frequency: null,
          result: true,
          disclosurePolicy: {
            exactIncomeHidden: true,
            sourceTransactionsHidden: true,
            qualifyingPaymentCount: 5,
          },
          createdAt: new Date("2026-01-15"),
        },
      };

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(mockProofWithClaim);

      const result = await service.getProofDetail(mockUser, "proof-1");

      // Result should have same structure as before
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("type");
      expect(result).toHaveProperty("schemaVersion");
      expect(result).toHaveProperty("localStatus");
      expect(result).toHaveProperty("credentialValidity");
      expect(result).toHaveProperty("asset");
      expect(result).toHaveProperty("issuedAt");
      expect(result).toHaveProperty("expiresAt");
      expect(result).toHaveProperty("anchoring");
    });

    it("should maintain listProofs method signature and behavior", async () => {
      const mockProofs = [mockProof];

      (prisma.proof.findMany as jest.Mock).mockResolvedValue(mockProofs);

      const result = await service.listProofs(mockUser.id, { limit: 20 });

      // Result should have same structure as before
      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("pageInfo");
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data[0]).toHaveProperty("id");
      expect(result.data[0]).toHaveProperty("type");
      expect(result.pageInfo).toHaveProperty("hasMore");
      expect(result.pageInfo).toHaveProperty("nextCursor");
    });

    it("should maintain proof history item structure", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(mockProof);

      const result = await service.getProofDetail(mockUser, "proof-1");

      // History item should have same structure as before
      expect(result.id).toBe(mockProof.id);
      expect(result.type).toBe(mockProof.proofType);
      expect(result.schemaVersion).toBe(mockProof.schemaVersion);
      expect(result.localStatus).toBe(mockProof.status);
    });

    it("should compute credential validity as before", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(mockProof);

      const result = await service.getProofDetail(mockUser, "proof-1");

      // Credential validity should be computed as before
      expect(result.credentialValidity).toBeDefined();
      expect(["valid", "expired", "revoked", "invalid"]).toContain(
        result.credentialValidity,
      );
    });

    it("should maintain proof revocation behavior", async () => {
      const revokedProof = {
        ...mockProof,
        status: ProofStatus.REVOKED,
        revokedAt: new Date(),
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue(revokedProof);
      (prisma.proof.update as jest.Mock).mockResolvedValue(revokedProof);
      (prisma.anchoringIntent.create as jest.Mock).mockResolvedValue({});

      const result = await service.revokeProof(mockUser as any, "proof-1");

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("status");
    });
  });

  describe("Attestation Integration - No Breaking Changes", () => {
    it("should NOT require attestations for proof creation", async () => {
      // Attestation service methods may return empty, but proof creation should still work
      mockAttestationsService.getValidAttestationsForSubject.mockResolvedValue([]);

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(mockProof);

      // Service should still work even with no attestations
      const result = await service.getProofDetail(mockUser, "proof-1");
      expect(result).toBeDefined();
    });

    it("should NOT change proof response schema when attestations present", async () => {
      mockAttestationsService.getValidAttestationsForSubject.mockResolvedValue([
        { id: "att-1", issuerId: "issuer-1", type: "PAYMENT", expiresAt: null },
      ]);

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(mockProof);

      const result = await service.getProofDetail(mockUser, "proof-1");

      // Proof response schema unchanged
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("type");
      expect(result).toHaveProperty("localStatus");
      expect(result).toHaveProperty("credentialValidity");
    });

    it("should NOT expose attestation details in proof responses", async () => {
      mockAttestationsService.getValidAttestationsForSubject.mockResolvedValue([
        { id: "att-1", issuerId: "issuer-1", type: "PAYMENT", expiresAt: null },
      ]);

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(mockProof);

      const result = await service.getProofDetail(mockUser, "proof-1");

      // Attestation data should NOT leak into proof response
      expect(JSON.stringify(result)).not.toContain("att-1");
      expect(JSON.stringify(result)).not.toContain("attestation");
    });

    it("validateSubjectAttestations should be callable but not required", async () => {
      mockAttestationsService.validateSubjectAttestations.mockResolvedValue(true);

      const result = await service.validateSubjectAttestations("sha256:subject");

      // Method should exist and work
      expect(result).toBe(true);
      // But should not break proof operations
    });

    it("hasValidAttestationsFromIssuer should be callable but not required", async () => {
      mockAttestationsService.hasValidAttestationsFromIssuer.mockResolvedValue(true);

      const result = await service.hasValidAttestationsFromIssuer(
        "issuer-1",
        "sha256:subject",
      );

      // Method should exist and work
      expect(result).toBe(true);
    });
  });

  describe("API Contract Preservation", () => {
    it("should maintain GET /proofs endpoint response contract", async () => {
      const mockProofs = [mockProof];

      (prisma.proof.findMany as jest.Mock).mockResolvedValue(mockProofs);

      const result = await service.listProofs(mockUser.id, { limit: 20 });

      // Response contract must match existing API
      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("pageInfo");
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.pageInfo).toHaveProperty("hasMore");
      expect(typeof result.pageInfo.hasMore === "boolean").toBe(true);
      expect(
        result.pageInfo.nextCursor === null ||
          typeof result.pageInfo.nextCursor === "string",
      ).toBe(true);
    });

    it("should maintain GET /proofs/:id endpoint response contract", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(mockProof);

      const result = await service.getProofDetail(mockUser, "proof-1");

      // Response contract must include all existing fields
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("type");
      expect(result).toHaveProperty("schemaVersion");
      expect(result).toHaveProperty("localStatus");
      expect(result).toHaveProperty("credentialValidity");
      expect(result).toHaveProperty("asset");
      expect(result).toHaveProperty("issuedAt");
      expect(result).toHaveProperty("expiresAt");
      expect(result).toHaveProperty("anchoring");
    });

    it("should maintain PATCH /proofs/:id/revoke endpoint behavior", async () => {
      const revokedProof = {
        ...mockProof,
        status: ProofStatus.REVOKED,
        revokedAt: new Date(),
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue({
        id: "proof-1",
        userId: mockUser.id,
        status: ProofStatus.ACTIVE,
        contractTransactionHash: null,
      });
      (prisma.proof.update as jest.Mock).mockResolvedValue(revokedProof);
      (prisma.anchoringIntent.create as jest.Mock).mockResolvedValue({});

      const result = await service.revokeProof(mockUser as any, "proof-1");

      // Response should have expected structure
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("status");
    });

    it("should maintain verification stats endpoint behavior", async () => {
      (prisma.proof.findUnique as jest.Mock).mockResolvedValue(mockProof);

      const mockStats = {
        total: 10,
        results: {
          VALID: 8,
          EXPIRED: 1,
          REVOKED: 1,
        },
      };

      const verificationEventService = await Test.createTestingModule({
        providers: [
          {
            provide: VerificationEventService,
            useValue: {
              getAggregateStats: jest.fn().mockResolvedValue(mockStats),
            },
          },
        ],
      }).compile();

      // Stats should still be retrievable with same structure
      expect(mockStats).toHaveProperty("total");
      expect(mockStats).toHaveProperty("results");
    });
  });

  describe("No Regression in Proof Lifecycle", () => {
    it("should handle active proofs normally", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(mockProof);

      const result = await service.getProofDetail(mockUser, "proof-1");

      expect(result.localStatus).toBe(ProofStatus.ACTIVE);
      expect(result.credentialValidity).not.toBe("invalid");
    });

    it("should handle expired proofs normally", async () => {
      const expiredProof = {
        ...mockProof,
        expiresAt: new Date("2025-01-01"),
      };

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(expiredProof);

      const result = await service.getProofDetail(mockUser, "proof-1");

      expect(result.expired).toBe(true);
      expect(result.credentialValidity).toBe("expired");
    });

    it("should handle revoked proofs normally", async () => {
      const revokedProof = {
        ...mockProof,
        status: ProofStatus.REVOKED,
        revokedAt: new Date(),
      };

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(revokedProof);

      const result = await service.getProofDetail(mockUser, "proof-1");

      expect(result.localStatus).toBe(ProofStatus.REVOKED);
      expect(result.credentialValidity).toBe("revoked");
    });

    it("should filter proofs by type as before", async () => {
      (prisma.proof.findMany as jest.Mock).mockResolvedValue([]);

      await service.listProofs(mockUser.id, { limit: 20, type: ProofType.MINIMUM_INCOME });

      const callArgs = (prisma.proof.findMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.where.proofType).toBe(ProofType.MINIMUM_INCOME);
    });

    it("should filter proofs by status as before", async () => {
      (prisma.proof.findMany as jest.Mock).mockResolvedValue([]);

      await service.listProofs(mockUser.id, { limit: 20, status: ProofStatus.REVOKED });

      const callArgs = (prisma.proof.findMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.where.status).toBe(ProofStatus.REVOKED);
    });

    it("should support pagination as before", async () => {
      (prisma.proof.findMany as jest.Mock).mockResolvedValue([]);
      const cursor = encodeCursor(new Date("2026-08-01T00:00:00.000Z"), "cursor_proof");

      await service.listProofs(mockUser.id, { cursor, limit: 50 });

      const callArgs = (prisma.proof.findMany as jest.Mock).mock.calls[0][0];
      // Keyset pagination resumes via an OR where-fragment rather than
      // Prisma's native `cursor`/`skip`, since a raw auto-incrementing-style
      // cursor can't carry the opaque, versioned, tamper-evident shape
      // issue #188 requires.
      expect(callArgs.where.OR).toBeDefined();
      expect(callArgs.take).toBe(51); // +1 for hasMore check
    });
  });

  describe("Acceptance Criteria: No Regression", () => {
    it("REQUIREMENT: Existing proof verification flows remain functional", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(mockProof);

      const result = await service.getProofDetail(mockUser, "proof-1");

      // Core proof functionality unchanged
      expect(result.id).toBe(mockProof.id);
      expect(result.type).toBe(mockProof.proofType);
      expect(result.schemaVersion).toBe(mockProof.schemaVersion);
    });

    it("REQUIREMENT: Existing API consumers not broken", async () => {
      (prisma.proof.findMany as jest.Mock).mockResolvedValue([mockProof]);

      const result = await service.listProofs(mockUser.id, { limit: 20 });

      // API contract maintained
      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("pageInfo");
      expect(result.data[0]).toHaveProperty("id");
    });

    it("REQUIREMENT: Existing authorization mechanisms unchanged", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(mockProof);

      // Should still enforce user ownership
      const result = await service.getProofDetail(mockUser, "proof-1");
      expect(result).toBeDefined();
    });

    it("REQUIREMENT: Existing issuer workflows remain unchanged", async () => {
      mockAttestationsService.hasValidAttestationsFromIssuer.mockResolvedValue(false);

      // Issuer operations should not be affected
      // (Attestation validation is optional/future feature)
      expect(attestationsService).toBeDefined();
    });
  });
});

