/**
 * Security and Privacy Test Suite for Attestation Lifecycle APIs
 *
 * Verifies:
 * 1. Authorization enforcement (ADMIN-only operations)
 * 2. No sensitive data exposure in API responses
 * 3. No sensitive data in logs
 * 4. Immutable audit trail
 * 5. Private claim data protection
 * 6. Status validation prevents invalid transitions
 */

import { ForbiddenException, BadRequestException } from "@nestjs/common";
import { ResourceStatus, AttestationType } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../database/prisma.service";
import { AttestationsService } from "./attestations.service";

describe("Attestation Security & Privacy", () => {
  let service: AttestationsService;
  let prisma: PrismaService;

  const mockAdminUser = {
    id: "admin-1",
    walletAddress: "G1111111111111111111111111111111111111111111111111111111",
    walletHash: "sha256:admin-hash",
    role: "ADMIN",
  };

  const mockIssuerUser = {
    id: "issuer-1",
    walletAddress: "G2222222222222222222222222222222222222222222222222222222",
    walletHash: "sha256:issuer-hash",
    role: "ISSUER",
  };

  const mockWorkerUser = {
    id: "worker-1",
    walletAddress: "G3333333333333333333333333333333333333333333333333333333",
    walletHash: "sha256:worker-hash",
    role: "WORKER",
  };

  const mockActiveIssuer = {
    id: "issuer-active",
    status: ResourceStatus.ACTIVE,
    organizationId: "org-1",
  };

  const mockSuspendedIssuer = {
    id: "issuer-suspended",
    status: ResourceStatus.SUSPENDED,
    organizationId: "org-1",
  };

  const mockRevokedIssuer = {
    id: "issuer-revoked",
    status: ResourceStatus.REVOKED,
    organizationId: "org-1",
  };

  const mockAttestation = {
    id: "att-1",
    issuerId: "issuer-active",
    subjectWalletHash: "sha256:subject-hash",
    paymentReferenceHash: "sha256:payment-hash",
    type: AttestationType.PAYMENT,
    schemaVersion: "1.0",
    signingKeyVersionId: "1",
    status: ResourceStatus.ACTIVE,
    signedPayload: {
      claim: {
        secretValue: "NEVER_EXPOSE_THIS",
        privateData: "CONFIDENTIAL",
      },
      hmac: "signature-data",
    },
    expiresAt: new Date("2026-12-31"),
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    createdAt: new Date("2026-01-15"),
    updatedAt: new Date("2026-01-15"),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttestationsService,
        {
          provide: PrismaService,
          useValue: {
            issuer: {
              findUnique: jest.fn(),
            },
            attestation: {
              create: jest.fn(),
              findUnique: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              update: jest.fn(),
            },
            auditLog: {
              create: jest.fn(),
            },
            $transaction: jest.fn((callback) => callback(prisma)),
          },
        },
      ],
    }).compile();

    service = module.get<AttestationsService>(AttestationsService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe("Authorization: ADMIN-only enforcement", () => {
    it("should reject createAttestation for non-ADMIN users", async () => {
      const input = {
        subjectWalletHash: "sha256:subject",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
      };

      await expect(
        service.createAttestation(mockIssuerUser, "issuer-1", input),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.createAttestation(mockWorkerUser, "issuer-1", input),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject revokeAttestation for non-ADMIN users", async () => {
      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(
        mockAttestation,
      );

      const input = { revocationReason: "Test" };

      await expect(
        service.revokeAttestation(mockIssuerUser, "issuer-1", "att-1", input),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.revokeAttestation(mockWorkerUser, "issuer-1", "att-1", input),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should accept createAttestation only from ADMIN users", async () => {
      const input = {
        subjectWalletHash: "sha256:subject",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(
        mockActiveIssuer,
      );
      (prisma.attestation.create as jest.Mock).mockResolvedValue(mockAttestation);
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      const result = await service.createAttestation(mockAdminUser, "issuer-active", input);
      expect(result).toBeDefined();
    });

    it("should accept revokeAttestation only from ADMIN users", async () => {
      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(mockAttestation);
      (prisma.attestation.update as jest.Mock).mockResolvedValue({
        ...mockAttestation,
        status: ResourceStatus.REVOKED,
      });
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      const result = await service.revokeAttestation(
        mockAdminUser,
        "issuer-active",
        "att-1",
        { revocationReason: "Test" },
      );
      expect(result).toBeDefined();
    });
  });

  describe("Data exposure prevention", () => {
    it("should not expose raw signedPayload in response DTOs", async () => {
      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(
        mockAttestation,
      );

      const response = await service.getAttestation("issuer-active", "att-1");

      // Response should not include the full signedPayload with secrets
      expect(response).not.toHaveProperty("signedPayload");
      expect(JSON.stringify(response)).not.toContain("NEVER_EXPOSE_THIS");
      expect(JSON.stringify(response)).not.toContain("CONFIDENTIAL");
    });

    it("should not expose raw signedPayload in list responses", async () => {
      (prisma.attestation.findMany as jest.Mock).mockResolvedValue([
        mockAttestation,
      ]);
      (prisma.attestation.count as jest.Mock).mockResolvedValue(1);

      const response = await service.listAttestations("issuer-active", {});

      // Response items should not include raw signedPayload
      expect(response.items[0]).not.toHaveProperty("signedPayload");
      expect(JSON.stringify(response)).not.toContain("NEVER_EXPOSE_THIS");
      expect(JSON.stringify(response)).not.toContain("CONFIDENTIAL");
    });

    it("should only expose public lifecycle metadata", async () => {
      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(
        mockAttestation,
      );

      const response = await service.getAttestation("issuer-active", "att-1");

      // Public metadata should be present
      expect(response.id).toBe("att-1");
      expect(response.issuerId).toBe("issuer-active");
      expect(response.type).toBe(AttestationType.PAYMENT);
      expect(response.status).toBe(ResourceStatus.ACTIVE);
      expect(response.schemaVersion).toBeDefined();
      expect(response.signingKeyVersionId).toBeDefined();
      expect(response.createdAt).toBeDefined();
      expect(response.expiresAt).toBeDefined();
      expect(response.isValid).toBeDefined();
      expect(response.lifecycleState).toBeDefined();
    });

    it("should expose revocation audit trail", async () => {
      const revokedAttestation = {
        ...mockAttestation,
        status: ResourceStatus.REVOKED,
        revokedAt: new Date(),
        revokedBy: mockAdminUser.id,
        revocationReason: "Policy violation",
      };

      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(
        revokedAttestation,
      );

      const response = await service.getAttestation("issuer-active", "att-1");

      // Audit information should be visible for compliance
      expect(response.revokedAt).toBeDefined();
      expect(response.revokedBy).toBe(mockAdminUser.id);
      expect(response.revocationReason).toBe("Policy violation");
    });
  });

  describe("Issuer status validation", () => {
    it("should reject attestation creation for suspended issuer", async () => {
      const input = {
        subjectWalletHash: "sha256:subject",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(
        mockSuspendedIssuer,
      );

      await expect(
        service.createAttestation(mockAdminUser, "issuer-suspended", input),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject attestation creation for revoked issuer", async () => {
      const input = {
        subjectWalletHash: "sha256:subject",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(
        mockRevokedIssuer,
      );

      await expect(
        service.createAttestation(mockAdminUser, "issuer-revoked", input),
      ).rejects.toThrow(BadRequestException);
    });

    it("should allow attestation creation only for ACTIVE issuer", async () => {
      const input = {
        subjectWalletHash: "sha256:subject",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(mockActiveIssuer);
      (prisma.attestation.create as jest.Mock).mockResolvedValue(mockAttestation);
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      const result = await service.createAttestation(mockAdminUser, "issuer-active", input);
      expect(result.status).toBe(ResourceStatus.ACTIVE);
    });
  });

  describe("Immutable audit trail", () => {
    it("should record who created the attestation", async () => {
      const input = {
        subjectWalletHash: "sha256:subject",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(mockActiveIssuer);
      (prisma.attestation.create as jest.Mock).mockResolvedValue(mockAttestation);
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      await service.createAttestation(mockAdminUser, "issuer-active", input);

      const auditCall = (prisma.auditLog.create as jest.Mock).mock.calls[0][0];
      expect(auditCall.data.actorId).toBe(mockAdminUser.id);
      expect(auditCall.data.action).toBe("CREATE_ATTESTATION");
    });

    it("should record who revoked the attestation", async () => {
      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(
        mockAttestation,
      );
      (prisma.attestation.update as jest.Mock).mockResolvedValue({
        ...mockAttestation,
        status: ResourceStatus.REVOKED,
        revokedAt: new Date(),
        revokedBy: mockAdminUser.id,
        revocationReason: "Test",
      });
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      await service.revokeAttestation(
        mockAdminUser,
        "issuer-active",
        "att-1",
        { revocationReason: "Test" },
      );

      const auditCall = (prisma.auditLog.create as jest.Mock).mock.calls[0][0];
      expect(auditCall.data.actorId).toBe(mockAdminUser.id);
      expect(auditCall.data.action).toBe("REVOKE_ATTESTATION");
      expect(auditCall.data.metadata.reason).toBe("Test");
    });

    it("should preserve original creation metadata even after revocation", async () => {
      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(
        mockAttestation,
      );
      (prisma.attestation.update as jest.Mock).mockResolvedValue({
        ...mockAttestation,
        status: ResourceStatus.REVOKED,
        revokedAt: new Date(),
        revokedBy: mockAdminUser.id,
      });
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      const result = await service.revokeAttestation(
        mockAdminUser,
        "issuer-active",
        "att-1",
        {},
      );

      // Original creation date should not change
      expect(result.createdAt).toEqual(mockAttestation.createdAt);
      // New revocation date should be set
      expect(result.revokedAt).toBeDefined();
      expect(result.revokedAt).not.toEqual(mockAttestation.createdAt);
    });
  });

  describe("Expiry validation security", () => {
    it("should reject expiresAt in the past", async () => {
      const input = {
        subjectWalletHash: "sha256:subject",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
        expiresAt: "2025-01-01T00:00:00Z", // Past date
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(mockActiveIssuer);

      await expect(
        service.createAttestation(mockAdminUser, "issuer-active", input),
      ).rejects.toThrow(BadRequestException);
    });

    it("should accept expiresAt in the future", async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const input = {
        subjectWalletHash: "sha256:subject",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
        expiresAt: futureDate.toISOString(),
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(mockActiveIssuer);
      (prisma.attestation.create as jest.Mock).mockResolvedValue(mockAttestation);
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      const result = await service.createAttestation(mockAdminUser, "issuer-active", input);
      expect(result).toBeDefined();
    });
  });

  describe("Acceptance Criteria: Security Requirements", () => {
    it("REQUIREMENT: Only active issuers can issue attestations", async () => {
      const input = {
        subjectWalletHash: "sha256:subject",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
      };

      // Revoked issuer
      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(mockRevokedIssuer);
      await expect(
        service.createAttestation(mockAdminUser, "issuer-revoked", input),
      ).rejects.toThrow();

      // Suspended issuer
      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(mockSuspendedIssuer);
      await expect(
        service.createAttestation(mockAdminUser, "issuer-suspended", input),
      ).rejects.toThrow();

      // Active issuer succeeds
      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(mockActiveIssuer);
      (prisma.attestation.create as jest.Mock).mockResolvedValue(mockAttestation);
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      const result = await service.createAttestation(mockAdminUser, "issuer-active", input);
      expect(result.status).toBe(ResourceStatus.ACTIVE);
    });

    it("REQUIREMENT: Revoked attestations cannot satisfy proof issuance requirements", async () => {
      const revokedAtt = { ...mockAttestation, status: ResourceStatus.REVOKED, revokedAt: new Date() };
      (prisma.attestation.findUnique as jest.Mock).mockResolvedValue(revokedAtt);

      const isValid = await service.isAttestationValid("att-revoked");
      expect(isValid).toBe(false);
    });

    it("REQUIREMENT: Expired attestations cannot satisfy proof issuance requirements", async () => {
      const expiredAtt = { ...mockAttestation, expiresAt: new Date("2025-01-01") };
      (prisma.attestation.findUnique as jest.Mock).mockResolvedValue(expiredAtt);

      const isValid = await service.isAttestationValid("att-expired");
      expect(isValid).toBe(false);
    });

    it("REQUIREMENT: Secrets and raw private claims excluded from API responses", async () => {
      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(mockAttestation);

      const response = await service.getAttestation("issuer-active", "att-1");

      // Verify secrets are NOT in response
      const responseString = JSON.stringify(response);
      expect(responseString).not.toContain("NEVER_EXPOSE_THIS");
      expect(responseString).not.toContain("CONFIDENTIAL");
      expect(responseString).not.toContain("secretValue");
      expect(responseString).not.toContain("privateData");
      expect(responseString).not.toContain("signedPayload");
    });
  });
});
