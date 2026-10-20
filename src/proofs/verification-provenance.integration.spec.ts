/**
 * Verification provenance integration tests.
 *
 * Tests end-to-end flows including provenance recording during verification,
 * query and disclosure endpoints, authorization boundaries, and edge cases.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { VerificationProvenanceService } from "./verification-provenance.service";
import { ProvenanceDisclosureController } from "./provenance-disclosure.controller";
import { VerificationResult, ProofStatus } from "@prisma/client";
import {
  VerificationProvenanceInput,
  VerificationProvenanceSourceInput,
  VERIFICATION_PROVENANCE_SCHEMA_VERSION,
} from "./provenance.types";

describe("Verification Provenance Integration", () => {
  let app: INestApplication;
  let service: VerificationProvenanceService;
  let controller: ProvenanceDisclosureController;
  let prisma: PrismaService;

  const testUserId = "test-user-1";
  const testProofId = "proof-1";
  const testProofId2 = "proof-2";

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProvenanceDisclosureController],
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
    controller = module.get<ProvenanceDisclosureController>(ProvenanceDisclosureController);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe("Provenance Recording and Retrieval", () => {
    it("should record provenance with multiple source types", async () => {
      const sources: VerificationProvenanceSourceInput[] = [
        {
          sourceType: "CREDENTIAL_SOURCE" as any,
          sourceId: "payment-1",
          sourceLabel: "PAYMENT_RECEIVED",
          observedAt: new Date(),
          sourceHash: "sha256:pay",
          observationOrder: 0,
        },
        {
          sourceType: "BACKEND_OBSERVATION" as any,
          sourceId: "policy-v1",
          sourceLabel: "POLICY_APPLIED",
          observedAt: new Date(),
          sourceHash: "sha256:policy",
          observationOrder: 1,
        },
        {
          sourceType: "CONTRACT_OBSERVATION" as any,
          sourceId: "contract-tx-1",
          sourceLabel: "PROOF_VALID",
          observedAt: new Date(),
          sourceHash: "sha256:contract",
          observationOrder: 2,
        },
      ];

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:decision",
        credentialHash: "sha256:cred",
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
              id: "prov-1",
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

      expect(result.sources).toHaveLength(3);
      expect(result.sources[0].sourceType).toBe("CREDENTIAL_SOURCE");
      expect(result.sources[1].sourceType).toBe("BACKEND_OBSERVATION");
      expect(result.sources[2].sourceType).toBe("CONTRACT_OBSERVATION");
    });

    it("should retrieve provenance via controller for authorized user", async () => {
      const mockProvenance = {
        id: "prov-1",
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:decision",
        credentialHash: "sha256:cred",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        failureReason: null,
        boundaryContext: null,
        sources: [],
        sourceCount: 0,
        decidedAt: new Date(),
        createdAt: new Date(),
      };

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue({
        id: testProofId,
      });

      (prisma.verificationProvenance.findFirst as jest.Mock).mockResolvedValue(
        mockProvenance,
      );

      const result = await controller.getLatestProvenance(testProofId, {
        id: testUserId,
      } as any);

      expect(result).toBeDefined();
      expect(result.verificationResult).toBe(VerificationResult.VALID);
      expect(result.policyVersion).toBe("earnproof.policy.v1");
    });

    it("should reject provenance access for unauthorized user", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        controller.getLatestProvenance(testProofId, {
          id: "other-user",
        } as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("Provenance Listing and Filtering", () => {
    it("should list chronological provenance records", async () => {
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

      const result = await controller.listProvenance(testProofId, {
        id: testUserId,
      } as any);

      expect(result.total).toBe(2);
      expect(result.provenances[0].decidedAt).toBeLessThan(
        result.provenances[1].decidedAt,
      );
    });

    it("should filter sources by type", async () => {
      const mockSources = [
        {
          id: "src-1",
          provenanceId: "prov-1",
          proofId: testProofId,
          sourceType: "CREDENTIAL_SOURCE",
          sourceId: "payment-1",
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

      const result = await controller.getSourcesByType(
        testProofId,
        "CREDENTIAL_SOURCE",
        { id: testUserId } as any,
      );

      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].sourceType).toBe("CREDENTIAL_SOURCE");
      expect(result.total).toBe(1);
    });

    it("should return empty list when no provenance exists", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue({
        id: testProofId,
      });

      (prisma.verificationProvenance.findMany as jest.Mock).mockResolvedValue([]);

      const result = await controller.listProvenance(testProofId, {
        id: testUserId,
      } as any);

      expect(result.total).toBe(0);
      expect(result.provenances).toEqual([]);
    });
  });

  describe("Provenance Summary", () => {
    it("should return summary with provenance metadata", async () => {
      const mockProvenance = {
        id: "prov-1",
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:decision",
        credentialHash: "sha256:cred",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        failureReason: null,
        boundaryContext: null,
        sources: [],
        sourceCount: 3,
        decidedAt: new Date(),
        createdAt: new Date(),
      };

      (prisma.proof.findFirst as jest.Mock).mockResolvedValue({
        id: testProofId,
      });

      (prisma.verificationProvenance.findFirst as jest.Mock).mockResolvedValue(
        mockProvenance,
      );

      const result = await controller.getProvenanceSummary(testProofId, {
        id: testUserId,
      } as any);

      expect(result.hasProvenance).toBe(true);
      expect(result.latestSourceCount).toBe(3);
      expect(result.latestVerificationResult).toBe(VerificationResult.VALID);
    });

    it("should return summary indicating no provenance when none exists", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue({
        id: testProofId,
      });

      (prisma.verificationProvenance.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await controller.getProvenanceSummary(testProofId, {
        id: testUserId,
      } as any);

      expect(result.hasProvenance).toBe(false);
      expect(result.latestSourceCount).toBeUndefined();
    });
  });

  describe("Tenant Isolation and Authorization", () => {
    it("should prevent cross-tenant provenance access", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getProvenanceForProof(testProofId, "different-user"),
      ).resolves.toBeNull();

      expect(prisma.proof.findFirst).toHaveBeenCalledWith({
        where: { id: testProofId, userId: "different-user" },
        select: { id: true },
      });
    });

    it("should prevent listing provenance for proof user does not own", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.listProvenanceForProof(
        testProofId,
        "unauthorized-user",
      );

      expect(result).toEqual([]);
    });

    it("should prevent filtering sources for proof user does not own", async () => {
      (prisma.proof.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.getSourcesByType(
        testProofId,
        "CREDENTIAL_SOURCE",
        "unauthorized-user",
      );

      expect(result).toEqual([]);
    });
  });

  describe("Privacy and Data Minimization", () => {
    it("should never expose internal hashes in response DTO", async () => {
      const provenance = {
        id: "prov-1",
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:internal-decision-hash",
        credentialHash: "sha256:internal-cred-hash",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        failureReason: null,
        boundaryContext: null,
        sources: [],
        sourceCount: 0,
        decidedAt: new Date(),
        createdAt: new Date(),
      };

      const dto = service.toResponseDto(provenance as any);

      // DTO should not contain internal hashes
      expect(JSON.stringify(dto)).not.toContain("internal-decision-hash");
      expect(JSON.stringify(dto)).not.toContain("internal-cred-hash");
      expect(dto.verificationResult).toBe(VerificationResult.VALID);
      expect(dto.policyVersion).toBe("earnproof.policy.v1");
    });

    it("should never expose raw source payloads", async () => {
      const sources: VerificationProvenanceSourceInput[] = [
        {
          sourceType: "CREDENTIAL_SOURCE" as any,
          sourceId: "payment-sensitive-data",
          observedAt: new Date(),
          sourceHash: "sha256:hash-only", // Only hash, not raw data
          observationOrder: 0,
        },
      ];

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:decision",
        credentialHash: "sha256:cred",
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
              id: "prov-1",
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

      // Should contain only hash, not raw data
      expect(JSON.stringify(result)).toContain("sha256:hash-only");
      expect(JSON.stringify(result)).not.toContain("sensitive-data");
    });
  });

  describe("Boundary and Edge Cases", () => {
    it("should handle provenance with no sources", async () => {
      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:decision",
        credentialHash: "sha256:cred",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "UNKNOWN_PROOF" as any,
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
      expect(result.sources).toEqual([]);
    });

    it("should handle sources with missing optional fields", async () => {
      const sources: VerificationProvenanceSourceInput[] = [
        {
          sourceType: "BACKEND_OBSERVATION" as any,
          sourceId: "obs-1",
          observedAt: new Date(),
          sourceHash: "sha256:obs",
          observationOrder: 0,
          // sourceLabel and missingLinkReason intentionally omitted
        },
      ];

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:decision",
        credentialHash: "sha256:cred",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.VALID,
        sources,
        // failureReason and boundaryContext intentionally omitted
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

    it("should handle large number of sources", async () => {
      const sources: VerificationProvenanceSourceInput[] = Array.from(
        { length: 100 },
        (_, i) => ({
          sourceType: "CREDENTIAL_SOURCE" as any,
          sourceId: `source-${i}`,
          observedAt: new Date(),
          sourceHash: `sha256:hash-${i}`,
          observationOrder: i,
        }),
      );

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:decision",
        credentialHash: "sha256:cred",
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
              id: "prov-large",
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

      expect(result.sourceCount).toBe(100);
      expect(result.sources).toHaveLength(100);
    });
  });

  describe("Verification Result Mappings", () => {
    it("should capture failure reasons for expired proofs", async () => {
      const sources: VerificationProvenanceSourceInput[] = [];

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:decision",
        credentialHash: "sha256:cred",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "EXPIRED",
        verificationResult: VerificationResult.EXPIRED,
        failureReason: "PROOF_EXPIRATION_DETECTED",
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
              id: "prov-expired",
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

      expect(result.verificationResult).toBe(VerificationResult.EXPIRED);
      expect(result.failureReason).toBe("PROOF_EXPIRATION_DETECTED");
    });

    it("should capture missing link reasons for credential mismatches", async () => {
      const sources: VerificationProvenanceSourceInput[] = [
        {
          sourceType: "CREDENTIAL_SOURCE" as any,
          sourceId: "claim-1",
          observedAt: new Date(),
          sourceHash: "sha256:claim",
          observationOrder: 0,
          missingLinkReason: "CREDENTIAL_MISMATCH",
        },
      ];

      const input: VerificationProvenanceInput = {
        proofId: testProofId,
        schemaVersion: VERIFICATION_PROVENANCE_SCHEMA_VERSION,
        decisionInputHash: "sha256:decision",
        credentialHash: "sha256:cred",
        policyVersion: "earnproof.policy.v1",
        proofStatus: "ACTIVE",
        verificationResult: VerificationResult.INVALID_SIGNATURE,
        failureReason: "CREDENTIAL_MISMATCH",
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
              id: "prov-mismatch",
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

      expect(result.failureReason).toBe("CREDENTIAL_MISMATCH");
      expect(result.sources[0].missingLinkReason).toBe("CREDENTIAL_MISMATCH");
    });
  });
});
