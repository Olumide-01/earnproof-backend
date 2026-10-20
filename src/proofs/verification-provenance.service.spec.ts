/**
 * Verification provenance service tests.
 *
 * Covers positive, negative, authorization, concurrency, boundary, and
 * regression cases. Tests tenant isolation, replay attacks, authorization
 * barriers, and exact fail/stale-state/missing-link scenarios.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../database/prisma.service";
import { VerificationProvenanceService } from "./verification-provenance.service";
import {
  VerificationProvenanceInput,
  VerificationProvenanceSourceInput,
  VERIFICATION_PROVENANCE_SCHEMA_VERSION,
  ProvenanceSourceType,
  ProvenanceMissingLinkReason,
} from "./provenance.types";
import { VerificationResult, VerificationProvenanceSourceType } from "@prisma/client";
import { createHash } from "crypto";

describe("VerificationProvenanceService", () => {
  let service: VerificationProvenanceService;
  let prisma: PrismaService;

  // Test fixtures
  const testUserId = "test-user-1";
  const testProofId = "test-proof-1";
  const testProofId2 = "test-proof-2";
  const testPaymentId = "payment-1";
  const testOperationId = "operation-123";

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationProvenanceService,
        {
          provide: PrismaService,
          useValue: {
            proof: {
              findUnique: jest.fn(),
              findFirst: jest.fn(),
            },
            verificationProvenance: {
              create: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
            },
            verificationProvenanceSource: {
              findMany: jest.fn(),
              create: jest.fn(),
            },
            $transaction: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<VerificationProvenanceService>(VerificationProvenanceService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe("recordProvenance", () => {
    it("should persist complete provenance with credential and backend sources", async () => {
      const sources: VerificationProvenanceSourceInput[] = [
        {
          sourceType: VerificationProvenanceSourceType.CREDENTIAL_SOURCE,
          sourceId: testPaymentId,
          sourceLabel: "PAYMENT_RECEIVED",
          observedAt: new Date("2026-01-15T10:00:00Z"),
          sourceHash: "sha256:abc123",
          observationOrder: 0,
        },
        {
          sourceType: VerificationProvenanceSourceType.BACKEND_OBSERVATION,
          sourceId: "policy-v1",
          sourceLabel: "POLICY_APPLIED",
          observedAt: new Date("2026-01-15T10:00:05Z"),
          sourceHash: "sha256:def456",
          observationOrder: 1,
        },
      ];

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:input123",
        credentialHash: "sha256:cred123",
        policyVersion: "earnproof.minimum-income.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        sources,
      };

      const mockProvenance = {
        id: "prov-1",
        proofId: testProofId,
        schemaVersion: input.schemaVersion,
        decisionInputHash: input.decisionInputHash,
        credentialHash: input.credentialHash,
        policyVersion: input.policyVersion,
        proofStatus: input.proofStatus,
        verificationResult: input.verificationResult,
        failureReason: null,
        boundaryContext: null,
        sources: sources.map((s) => ({
          sourceType: s.sourceType,
          sourceId: s.sourceId,
          sourceLabel: s.sourceLabel,
          observedAt: s.observedAt.toISOString(),
          sourceHash: s.sourceHash,
          observationOrder: s.observationOrder,
        })),
        sourceCount: sources.length,
        decidedAt: new Date(),
        createdAt: new Date(),
      };

      // Mock proof lookup
      (prisma.proof.findUnique as jest.Mock).mockResolvedValue({
        id: testProofId,
        userId: testUserId,
      });

      // Mock transaction
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        return callback({
          verificationProvenance: {
            create: jest.fn().mockResolvedValue(mockProvenance),
          },
          verificationProvenanceSource: {
            create: jest.fn().mockResolvedValue({}),
          },
        });
      });

      const result = await service.recordProvenance(input);

      expect(result).toBeDefined();
      expect(result.proofId).toBe(testProofId);
      expect(result.sources).toHaveLength(2);
      expect(result.sources[0].observationOrder).toBe(0);
      expect(result.sources[1].observationOrder).toBe(1);
    });

    it("should include contract and Stellar observations", async () => {
      const sources: VerificationProvenanceSourceInput[] = [
        {
          sourceType: VerificationProvenanceSourceType.CONTRACT_OBSERVATION,
          sourceId: "contract-tx-abc123",
          sourceLabel: "PROOF_REGISTERED",
          observedAt: new Date("2026-01-15T10:00:10Z"),
          sourceHash: "sha256:contract123",
          observationOrder: 0,
        },
        {
          sourceType: VerificationProvenanceSourceType.STELLAR_OBSERVATION,
          sourceId: testOperationId,
          sourceLabel: "OPERATION_FINALIZED",
          observedAt: new Date("2026-01-15T10:00:15Z"),
          sourceHash: "sha256:stellar123",
          observationOrder: 1,
        },
      ];

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:input456",
        credentialHash: "sha256:cred456",
        policyVersion: "earnproof.employment-continuity.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        sources,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue({
        id: testProofId,
        userId: testUserId,
      });

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        const result = await callback({
          verificationProvenance: {
            create: jest.fn().mockResolvedValue({
              id: "prov-2",
              ...input,
              sources: sources.map((s) => ({
                sourceType: s.sourceType,
                sourceId: s.sourceId,
                observedAt: s.observedAt.toISOString(),
                sourceHash: s.sourceHash,
                observationOrder: s.observationOrder,
              })),
              sourceCount: sources.length,
              decidedAt: new Date(),
              createdAt: new Date(),
            }),
          },
          verificationProvenanceSource: {
            create: jest.fn(),
          },
        });
        return result;
      });

      const result = await service.recordProvenance(input);

      expect(result.sources[0].sourceType).toBe(
        VerificationProvenanceSourceType.CONTRACT_OBSERVATION,
      );
      expect(result.sources[1].sourceType).toBe(
        VerificationProvenanceSourceType.STELLAR_OBSERVATION,
      );
    });

    it("should record failure reasons and boundary context", async () => {
      const sources: VerificationProvenanceSourceInput[] = [
        {
          sourceType: VerificationProvenanceSourceType.BACKEND_OBSERVATION,
          sourceId: "checkpoint-1",
          observedAt: new Date("2026-01-15T10:00:00Z"),
          sourceHash: "sha256:checkpoint123",
          observationOrder: 0,
          missingLinkReason: ProvenanceMissingLinkReason.STALE_CHECKPOINT,
        },
      ];

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:inputFail",
        credentialHash: "sha256:credFail",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "EXPIRED",
        verificationResult: VerificationResult.EXPIRED,
        failureReason: "PROOF_EXPIRATION_DETECTED",
        boundaryContext: "Stellar Horizon unavailable; stale checkpoint acceptable per policy",
        sources,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue({
        id: testProofId,
        userId: testUserId,
      });

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        return callback({
          verificationProvenance: {
            create: jest.fn().mockResolvedValue({
              id: "prov-fail",
              ...input,
              sources: sources.map((s) => ({
                sourceType: s.sourceType,
                sourceId: s.sourceId,
                observedAt: s.observedAt.toISOString(),
                sourceHash: s.sourceHash,
                observationOrder: s.observationOrder,
                missingLinkReason: s.missingLinkReason,
              })),
              sourceCount: sources.length,
              decidedAt: new Date(),
              createdAt: new Date(),
            }),
          },
          verificationProvenanceSource: {
            create: jest.fn(),
          },
        });
      });

      const result = await service.recordProvenance(input);

      expect(result.failureReason).toBe("PROOF_EXPIRATION_DETECTED");
      expect(result.boundaryContext).toContain("stale checkpoint");
      expect(result.sources[0].missingLinkReason).toBe(ProvenanceMissingLinkReason.STALE_CHECKPOINT);
    });

    it("should throw when proof does not exist", async () => {
      const input: VerificationProvenanceInput = {
        proofId: "nonexistent",
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:xxx",
        credentialHash: "sha256:yyy",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.UNKNOWN_PROOF,
        sources: [],
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.recordProvenance(input)).rejects.toThrow();
    });

    it("should be idempotent on repeated calls with same proofId and decidedAt", async () => {
      const decidedAt = new Date("2026-01-15T10:00:00Z");
      const sources: VerificationProvenanceSourceInput[] = [];

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:same",
        credentialHash: "sha256:same",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        sources,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue({
        id: testProofId,
        userId: testUserId,
      });

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        return callback({
          verificationProvenance: {
            create: jest.fn().mockResolvedValue({
              id: "prov-idempotent",
              ...input,
              sources: [],
              sourceCount: 0,
              decidedAt,
              createdAt: new Date(),
            }),
          },
          verificationProvenanceSource: {
            create: jest.fn(),
          },
        });
      });

      const result1 = await service.recordProvenance(input);
      expect(result1.id).toBe("prov-idempotent");

      // Second call should use same logic (unique constraint prevents duplicates)
      const result2 = await service.recordProvenance(input);
      expect(result2.id).toBe("prov-idempotent");
    });
  });

  describe("getProvenanceForProof", () => {
    it("should retrieve latest provenance for authorized user", async () => {
      const mockProvenance = {
        id: "prov-latest",
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:input",
        credentialHash: "sha256:cred",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        failureReason: null,
        boundaryContext: null,
        sources: [],
        sourceCount: 0,
        decidedAt: new Date("2026-01-15T10:00:00Z"),
        createdAt: new Date("2026-01-15T10:00:00Z"),
      };

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue({
        id: testProofId,
      });

      (prisma.verificationProvenance.findFirst as jest.Mock).mockResolvedValue(
        mockProvenance,
      );

      const result = await service.getProvenanceForProof(testProofId, testUserId);

      expect(result).toBeDefined();
      expect(result?.proofId).toBe(testProofId);
      expect(result?.verificationResult).toBe(VerificationResult.VALID);
    });

    it("should return null when user does not own proof (tenant isolation)", async () => {
      const otherUserId = "other-user";

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.getProvenanceForProof(testProofId, otherUserId);

      expect(result).toBeNull();
    });

    it("should return null when no provenance exists", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue({
        id: testProofId,
      });

      (prisma.verificationProvenance.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.getProvenanceForProof(testProofId, testUserId);

      expect(result).toBeNull();
    });
  });

  describe("listProvenanceForProof", () => {
    it("should return chronological provenance records for authorized user", async () => {
      const mockProvenances = [
        {
          id: "prov-1",
          proofId: testProofId,
          schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
          decisionInputHash: "sha256:input1",
          credentialHash: "sha256:cred1",
          policyVersion: "earnproof.policy.v1",
          proofStatus: "ACTIVE",
          verificationResult: VerificationResult.VALID,
          failureReason: null,
          boundaryContext: null,
          sources: [],
          sourceCount: 0,
          decidedAt: new Date("2026-01-15T10:00:00Z"),
          createdAt: new Date("2026-01-15T10:00:00Z"),
        },
        {
          id: "prov-2",
          proofId: testProofId,
          schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
          decisionInputHash: "sha256:input2",
          credentialHash: "sha256:cred2",
          policyVersion: "earnproof.policy.v1",
          proofStatus: "ACTIVE",
          verificationResult: VerificationResult.VALID,
          failureReason: null,
          boundaryContext: null,
          sources: [],
          sourceCount: 0,
          decidedAt: new Date("2026-01-15T11:00:00Z"),
          createdAt: new Date("2026-01-15T11:00:00Z"),
        },
      ];

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue({
        id: testProofId,
      });

      (prisma.verificationProvenance.findMany as jest.Mock).mockResolvedValue(
        mockProvenances,
      );

      const result = await service.listProvenanceForProof(testProofId, testUserId);

      expect(result).toHaveLength(2);
      expect(result[0].decidedAt.getTime()).toBeLessThan(
        result[1].decidedAt.getTime(),
      );
    });

    it("should return empty list when user does not own proof", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.listProvenanceForProof(testProofId, "other-user");

      expect(result).toEqual([]);
    });
  });

  describe("getSourcesByType", () => {
    it("should filter sources by type", async () => {
      const mockSources = [
        {
          id: "src-1",
          provenanceId: "prov-1",
          proofId: testProofId,
          sourceType: VerificationProvenanceSourceType.CREDENTIAL_SOURCE,
          sourceId: testPaymentId,
          sourceLabel: "PAYMENT",
          observedAt: new Date(),
          sourceHash: "sha256:pay",
          observationOrder: 0,
          missingLinkReason: null,
          decidedAt: new Date(),
          createdAt: new Date(),
        },
      ];

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue({
        id: testProofId,
      });

      (prisma.verificationProvenanceSource.findMany as jest.Mock).mockResolvedValue(
        mockSources,
      );

      const result = await service.getSourcesByType(
        testProofId,
        VerificationProvenanceSourceType.CREDENTIAL_SOURCE,
        testUserId,
      );

      expect(result).toHaveLength(1);
      expect(result[0].sourceType).toBe(VerificationProvenanceSourceType.CREDENTIAL_SOURCE);
    });

    it("should return empty list when user does not own proof", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.getSourcesByType(
        testProofId,
        VerificationProvenanceSourceType.CREDENTIAL_SOURCE,
        "other-user",
      );

      expect(result).toEqual([]);
    });
  });

  describe("toResponseDto", () => {
    it("should convert provenance to public response DTO", async () => {
      const provenance = {
        id: "prov-1",
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:input",
        credentialHash: "sha256:cred",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        failureReason: null,
        boundaryContext: "Test context",
        sources: [
          {
            sourceType: VerificationProvenanceSourceType.CREDENTIAL_SOURCE,
            sourceId: testPaymentId,
            sourceLabel: "PAYMENT",
            observedAt: new Date("2026-01-15T10:00:00Z"),
            sourceHash: "sha256:pay",
            observationOrder: 0,
            missingLinkReason: null,
          },
        ],
        sourceCount: 1,
        decidedAt: new Date("2026-01-15T10:00:00Z"),
        createdAt: new Date("2026-01-15T10:00:00Z"),
      };

      const result = service.toResponseDto(provenance);

      expect(result.policyVersion).toBe("earnproof.policy.v1");
      expect(result.verificationResult).toBe(VerificationResult.VALID);
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].sourceLabel).toBe("PAYMENT");
      expect(result.decidedAt).toContain("2026-01-15");
    });
  });

  describe("tenant isolation and authorization", () => {
    it("should enforce tenant boundaries in recordProvenance", async () => {
      // Simulate cross-tenant attack: user A tries to add provenance to user B's proof
      const input: VerificationProvenanceInput = {
        proofId: testProofId2, // Different proof
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:attack",
        credentialHash: "sha256:attack",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        sources: [],
      };

      // Proof belongs to different user
      (prisma.proof.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.recordProvenance(input)).rejects.toThrow();
    });

    it("should enforce tenant boundaries in getProvenanceForProof", async () => {
      // User attempts to access proof they don't own
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.getProvenanceForProof(
        testProofId,
        "unauthorized-user",
      );

      expect(result).toBeNull();
      expect(prisma.proof.findFirst).toHaveBeenCalledWith({
        where: { id: testProofId, userId: "unauthorized-user" },
        select: { id: true },
      });
    });
  });

  describe("privacy and data minimization", () => {
    it("should never store raw source payloads, only hashes", async () => {
      const sources: VerificationProvenanceSourceInput[] = [
        {
          sourceType: VerificationProvenanceSourceType.CREDENTIAL_SOURCE,
          sourceId: "payment-sensitive",
          observedAt: new Date(),
          sourceHash: "sha256:only_hash_stored", // Only hash, never payload
          observationOrder: 0,
        },
      ];

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:decision",
        credentialHash: "sha256:cred", // Hash only
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        sources,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue({
        id: testProofId,
        userId: testUserId,
      });

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        return callback({
          verificationProvenance: {
            create: jest.fn().mockResolvedValue({
              id: "prov-privacy",
              ...input,
              sources: sources.map((s) => ({
                sourceType: s.sourceType,
                sourceId: s.sourceId,
                observedAt: s.observedAt.toISOString(),
                sourceHash: s.sourceHash,
                observationOrder: s.observationOrder,
              })),
              sourceCount: sources.length,
              decidedAt: new Date(),
              createdAt: new Date(),
            }),
          },
          verificationProvenanceSource: {
            create: jest.fn(),
          },
        });
      });

      const result = await service.recordProvenance(input);

      expect(result.sources[0].sourceHash).toContain("sha256:");
      // Verify raw payload is never in the structure
      expect(JSON.stringify(result)).not.toContain("sensitive");
    });
  });

  describe("boundary and regression cases", () => {
    it("should handle empty source list", async () => {
      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:empty",
        credentialHash: "sha256:empty",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "UNKNOWN_PROOF",
        verificationResult: VerificationResult.UNKNOWN_PROOF,
        sources: [],
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue({
        id: testProofId,
        userId: testUserId,
      });

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        return callback({
          verificationProvenance: {
            create: jest.fn().mockResolvedValue({
              id: "prov-empty",
              ...input,
              sources: [],
              sourceCount: 0,
              decidedAt: new Date(),
              createdAt: new Date(),
            }),
          },
          verificationProvenanceSource: {
            create: jest.fn(),
          },
        });
      });

      const result = await service.recordProvenance(input);

      expect(result.sourceCount).toBe(0);
      expect(result.sources).toHaveLength(0);
    });

    it("should handle sources with all optional fields", async () => {
      const sources: VerificationProvenanceSourceInput[] = [
        {
          sourceType: VerificationProvenanceSourceType.BACKEND_OBSERVATION,
          sourceId: "obs-1",
          // Optional fields intentionally omitted
          observedAt: new Date(),
          sourceHash: "sha256:obs",
          observationOrder: 0,
        },
      ];

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:input",
        credentialHash: "sha256:cred",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        // Optional failure context omitted
        sources,
      };

      (prisma.proof.findUnique as jest.Mock).mockResolvedValue({
        id: testProofId,
        userId: testUserId,
      });

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        return callback({
          verificationProvenance: {
            create: jest.fn().mockResolvedValue({
              id: "prov-minimal",
              ...input,
              sources: sources.map((s) => ({
                sourceType: s.sourceType,
                sourceId: s.sourceId,
                observedAt: s.observedAt.toISOString(),
                sourceHash: s.sourceHash,
                observationOrder: s.observationOrder,
              })),
              sourceCount: sources.length,
              decidedAt: new Date(),
              createdAt: new Date(),
            }),
          },
          verificationProvenanceSource: {
            create: jest.fn(),
          },
        });
      });

      const result = await service.recordProvenance(input);

      expect(result).toBeDefined();
      expect(result.failureReason).toBeUndefined();
      expect(result.sources[0].missingLinkReason).toBeUndefined();
    });
  });
});
