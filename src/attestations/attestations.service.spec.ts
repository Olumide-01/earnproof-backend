import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ResourceStatus, AttestationType } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../database/prisma.service";
import { AttestationsService } from "./attestations.service";

describe("AttestationsService", () => {
  let service: AttestationsService;
  let prisma: PrismaService;

  const mockUser = {
    id: "user-1",
    walletAddress: "G1111111111111111111111111111111111111111111111111111111",
    walletHash: "sha256:hash1",
    role: "ADMIN",
  };

  const mockNonAdminUser = {
    id: "user-2",
    walletAddress: "G2222222222222222222222222222222222222222222222222222222",
    walletHash: "sha256:hash2",
    role: "ISSUER",
  };

  const mockIssuer = {
    id: "issuer-1",
    status: ResourceStatus.ACTIVE,
    organizationId: "org-1",
  };

  const mockInactiveIssuer = {
    id: "issuer-inactive",
    status: ResourceStatus.SUSPENDED,
    organizationId: "org-1",
  };

  const mockAttestation = {
    id: "att-1",
    issuerId: "issuer-1",
    subjectWalletHash: "sha256:subject1",
    paymentReferenceHash: null,
    type: AttestationType.PAYMENT,
    schemaVersion: "1.0",
    signingKeyVersionId: "1",
    status: ResourceStatus.ACTIVE,
    signedPayload: { claim: "data" },
    expiresAt: new Date("2026-12-31"),
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    createdAt: new Date("2026-01-15"),
    updatedAt: new Date("2026-01-15"),
  };

  const mockRevokedAttestation = {
    ...mockAttestation,
    id: "att-revoked",
    status: ResourceStatus.REVOKED,
    revokedAt: new Date("2026-02-01"),
    revokedBy: mockUser.id,
    revocationReason: "Policy violation",
  };

  const mockExpiredAttestation = {
    ...mockAttestation,
    id: "att-expired",
    expiresAt: new Date("2025-01-01"), // Past date
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

  describe("createAttestation", () => {
    it("should create attestation when issuer is ACTIVE", async () => {
      const input = {
        subjectWalletHash: "sha256:subject1",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
        expiresAt: "2026-12-31T23:59:59Z",
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(mockIssuer);
      (prisma.attestation.create as jest.Mock).mockResolvedValue(mockAttestation);
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      const result = await service.createAttestation(mockUser, "issuer-1", input);

      expect(result).toMatchObject({
        id: "att-1",
        issuerId: "issuer-1",
        status: ResourceStatus.ACTIVE,
        isValid: true,
        lifecycleState: "active",
      });
      expect(prisma.issuer.findUnique).toHaveBeenCalledWith({
        where: { id: "issuer-1" },
        select: expect.any(Object),
      });
      expect(prisma.attestation.create).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it("should reject when user is not ADMIN", async () => {
      const input = {
        subjectWalletHash: "sha256:subject1",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
      };

      await expect(
        service.createAttestation(mockNonAdminUser, "issuer-1", input),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject when issuer does not exist", async () => {
      const input = {
        subjectWalletHash: "sha256:subject1",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createAttestation(mockUser, "issuer-unknown", input),
      ).rejects.toThrow(NotFoundException);
    });

    it("should reject when issuer is not ACTIVE", async () => {
      const input = {
        subjectWalletHash: "sha256:subject1",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(mockInactiveIssuer);

      await expect(
        service.createAttestation(mockUser, "issuer-inactive", input),
      ).rejects.toThrow(BadRequestException);
      expect((await (service.createAttestation(mockUser, "issuer-inactive", input)).catch(e => e.message)).includes("ACTIVE")).toBeTruthy();
    });

    it("should reject when expiresAt is in the past", async () => {
      const input = {
        subjectWalletHash: "sha256:subject1",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
        expiresAt: "2025-01-01T00:00:00Z", // Past date
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(mockIssuer);

      await expect(
        service.createAttestation(mockUser, "issuer-1", input),
      ).rejects.toThrow(BadRequestException);
    });

    it("should use default schema version when not provided", async () => {
      const input = {
        subjectWalletHash: "sha256:subject1",
        type: AttestationType.PAYMENT,
        signedPayload: { claim: "data" },
      };

      (prisma.issuer.findUnique as jest.Mock).mockResolvedValue(mockIssuer);
      (prisma.attestation.create as jest.Mock).mockResolvedValue({
        ...mockAttestation,
        schemaVersion: "1.0",
      });
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      await service.createAttestation(mockUser, "issuer-1", input);

      const callArgs = (prisma.attestation.create as jest.Mock).mock.calls[0][0];
      expect(callArgs.data.schemaVersion).toBe("1.0");
    });
  });

  describe("getAttestation", () => {
    it("should retrieve attestation by ID and issuer", async () => {
      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(mockAttestation);

      const result = await service.getAttestation("issuer-1", "att-1");

      expect(result).toMatchObject({
        id: "att-1",
        issuerId: "issuer-1",
        isValid: true,
      });
      expect(prisma.attestation.findFirst).toHaveBeenCalledWith({
        where: {
          id: "att-1",
          issuerId: "issuer-1",
        },
      });
    });

    it("should throw NotFoundException when attestation not found", async () => {
      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getAttestation("issuer-1", "att-unknown"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("listAttestations", () => {
    it("should list attestations with default pagination", async () => {
      const query = {};
      const attestations = [mockAttestation];

      (prisma.attestation.findMany as jest.Mock).mockResolvedValue(attestations);
      (prisma.attestation.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listAttestations("issuer-1", query);

      expect(result).toMatchObject({
        items: expect.any(Array),
        total: 1,
        page: 1,
        limit: 20,
      });
      expect(prisma.attestation.findMany).toHaveBeenCalled();
    });

    it("should filter by status", async () => {
      const query = { status: ResourceStatus.REVOKED };
      const revokedAttestations = [mockRevokedAttestation];

      (prisma.attestation.findMany as jest.Mock).mockResolvedValue(revokedAttestations);
      (prisma.attestation.count as jest.Mock).mockResolvedValue(1);

      await service.listAttestations("issuer-1", query);

      const callArgs = (prisma.attestation.findMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.where.status).toBe(ResourceStatus.REVOKED);
    });

    it("should filter by type", async () => {
      const query = { type: AttestationType.EMPLOYMENT };

      (prisma.attestation.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.attestation.count as jest.Mock).mockResolvedValue(0);

      await service.listAttestations("issuer-1", query);

      const callArgs = (prisma.attestation.findMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.where.type).toBe(AttestationType.EMPLOYMENT);
    });

    it("should filter by subject wallet hash", async () => {
      const query = { subjectWalletHash: "sha256:subject1" };

      (prisma.attestation.findMany as jest.Mock).mockResolvedValue([mockAttestation]);
      (prisma.attestation.count as jest.Mock).mockResolvedValue(1);

      await service.listAttestations("issuer-1", query);

      const callArgs = (prisma.attestation.findMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.where.subjectWalletHash).toBe("sha256:subject1");
    });

    it("should paginate with custom limit", async () => {
      const query = { page: 2, limit: 50 };

      (prisma.attestation.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.attestation.count as jest.Mock).mockResolvedValue(0);

      await service.listAttestations("issuer-1", query);

      const callArgs = (prisma.attestation.findMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.skip).toBe(50); // (2-1) * 50
      expect(callArgs.take).toBe(50);
    });

    it("should enforce max limit of 100", async () => {
      const query = { limit: 500 };

      (prisma.attestation.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.attestation.count as jest.Mock).mockResolvedValue(0);

      await service.listAttestations("issuer-1", query);

      const callArgs = (prisma.attestation.findMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.take).toBe(100);
    });
  });

  describe("revokeAttestation", () => {
    it("should revoke attestation and record audit trail", async () => {
      const input = { revocationReason: "Policy change" };

      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(mockAttestation);
      (prisma.attestation.update as jest.Mock).mockImplementation(({ data }) => ({
        ...mockAttestation,
        ...data,
        revokedBy: mockUser.id,
      }));
      (prisma.auditLog.create as jest.Mock).mockResolvedValue({});

      const result = await service.revokeAttestation(
        mockUser,
        "issuer-1",
        "att-1",
        input,
      );

      expect(result).toMatchObject({
        status: ResourceStatus.REVOKED,
        revokedAt: expect.any(Date),
        revokedBy: mockUser.id,
        revocationReason: "Policy change",
        isValid: false,
        lifecycleState: "revoked",
      });
      expect(prisma.attestation.update).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it("should reject when user is not ADMIN", async () => {
      const input = { revocationReason: "Test" };

      await expect(
        service.revokeAttestation(mockNonAdminUser, "issuer-1", "att-1", input),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject when attestation not found", async () => {
      const input = { revocationReason: "Test" };

      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.revokeAttestation(mockUser, "issuer-1", "att-unknown", input),
      ).rejects.toThrow(NotFoundException);
    });

    it("should reject when attestation already revoked", async () => {
      const input = { revocationReason: "Test" };

      (prisma.attestation.findFirst as jest.Mock).mockResolvedValue(mockRevokedAttestation);

      await expect(
        service.revokeAttestation(mockUser, "issuer-1", "att-revoked", input),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("isAttestationValid", () => {
    it("should return true for active, non-expired attestation", async () => {
      (prisma.attestation.findUnique as jest.Mock).mockResolvedValue(mockAttestation);

      const result = await service.isAttestationValid("att-1");

      expect(result).toBe(true);
    });

    it("should return false for revoked attestation", async () => {
      (prisma.attestation.findUnique as jest.Mock).mockResolvedValue(mockRevokedAttestation);

      const result = await service.isAttestationValid("att-revoked");

      expect(result).toBe(false);
    });

    it("should return false for expired attestation", async () => {
      (prisma.attestation.findUnique as jest.Mock).mockResolvedValue(mockExpiredAttestation);

      const result = await service.isAttestationValid("att-expired");

      expect(result).toBe(false);
    });

    it("should return false when attestation not found", async () => {
      (prisma.attestation.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.isAttestationValid("att-unknown");

      expect(result).toBe(false);
    });

    it("should return true for attestation with no expiry", async () => {
      const noExpiryAttestation = {
        ...mockAttestation,
        expiresAt: null,
      };

      (prisma.attestation.findUnique as jest.Mock).mockResolvedValue(noExpiryAttestation);

      const result = await service.isAttestationValid("att-noexpiry");

      expect(result).toBe(true);
    });
  });

  describe("getAttestationLifecycleState", () => {
    it("should return 'revoked' for revoked attestation", async () => {
      (prisma.attestation.findUnique as jest.Mock).mockResolvedValue(mockRevokedAttestation);

      const result = await service.getAttestationLifecycleState("att-revoked");

      expect(result).toBe("revoked");
    });

    it("should return 'expired' for expired attestation", async () => {
      (prisma.attestation.findUnique as jest.Mock).mockResolvedValue(mockExpiredAttestation);

      const result = await service.getAttestationLifecycleState("att-expired");

      expect(result).toBe("expired");
    });

    it("should return 'active' for valid attestation", async () => {
      (prisma.attestation.findUnique as jest.Mock).mockResolvedValue(mockAttestation);

      const result = await service.getAttestationLifecycleState("att-1");

      expect(result).toBe("active");
    });

    it("should return null when attestation not found", async () => {
      (prisma.attestation.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.getAttestationLifecycleState("att-unknown");

      expect(result).toBeNull();
    });
  });

  describe("getValidAttestationsForSubject", () => {
    it("should return valid attestations for subject", async () => {
      const validAttestations = [
        { id: "att-1", issuerId: "issuer-1", type: AttestationType.PAYMENT, expiresAt: new Date("2026-12-31") },
      ];

      (prisma.attestation.findMany as jest.Mock).mockResolvedValue(validAttestations);

      const result = await service.getValidAttestationsForSubject("sha256:subject1");

      expect(result).toEqual(validAttestations);
      expect(prisma.attestation.findMany).toHaveBeenCalled();
      const callArgs = (prisma.attestation.findMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.where.AND).toBeDefined();
      expect(callArgs.where.AND[0]).toMatchObject({
        subjectWalletHash: "sha256:subject1",
        status: ResourceStatus.ACTIVE,
        revokedAt: null,
      });
    });

    it("should filter by issuer when provided", async () => {
      (prisma.attestation.findMany as jest.Mock).mockResolvedValue([]);

      await service.getValidAttestationsForSubject("sha256:subject1", "issuer-1");

      const callArgs = (prisma.attestation.findMany as jest.Mock).mock.calls[0][0];
      // issuerId should be in the AND array
      expect(callArgs.where.AND.some((clause: any) => clause.issuerId === "issuer-1")).toBe(true);
    });

    it("should return empty array when no valid attestations exist", async () => {
      (prisma.attestation.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.getValidAttestationsForSubject("sha256:subject-no-att");

      expect(result).toEqual([]);
    });
  });
});
