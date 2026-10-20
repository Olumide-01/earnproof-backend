import { BadRequestException, NotFoundException, ConflictException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../database/prisma.service";
import { CredentialVerificationKeyTrustPinService } from "./credential-verification-key-trust-pin.service";
import {
  CreateCredentialVerificationKeyTrustPinDto,
  UpdateCredentialVerificationKeyTrustPinStatusDto,
  TrustedKeySnapshot,
} from "./dto/credential-verification-key-trust-pin.dto";
import {
  buildTrustPin,
  activeTrustPin,
  retiredTrustPin,
  revokedTrustPin,
  expiredTrustPin,
} from "../testing/factories";

describe("CredentialVerificationKeyTrustPinService", () => {
  let service: CredentialVerificationKeyTrustPinService;
  let prisma: PrismaService;

  // Synthetic test data
  const orgId = "synthetic_org_1";
  const issuerId = "synthetic_issuer_1";
  const userId = "synthetic_user_1";

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialVerificationKeyTrustPinService,
        {
          provide: PrismaService,
          useValue: {
            issuer: { findUnique: jest.fn() },
            credentialVerificationKeyTrustPin: {
              create: jest.fn(),
              findUnique: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<CredentialVerificationKeyTrustPinService>(
      CredentialVerificationKeyTrustPinService,
    );
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe("createTrustPin", () => {
    it("creates a trust pin when all preconditions are met", async () => {
      // Arrange
      const mockIssuer = { id: issuerId, organizationId: orgId };
      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(mockIssuer);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findFirst").mockResolvedValue(null);

      const keySnapshot: TrustedKeySnapshot = {
        alg: "EdDSA",
        crv: "Ed25519",
        kid: "key-1",
        kty: "OKP",
        x: "dGVzdC1wdWJsaWMta2V5LW1hdGVyaWFsLWJhc2U2NHVybA",
        use: "sig",
        status: "active",
      };

      const dto: CreateCredentialVerificationKeyTrustPinDto = {
        organizationId: orgId,
        issuerId,
        network: "testnet",
        keyId: "key-1",
        trustedKeySnapshot: keySnapshot,
        effectiveAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        decisionMetadata: {
          decidedBy: userId,
          reason: "Test trust pin",
        },
      };

      const createdPin = buildTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "create").mockResolvedValue(createdPin as any);

      // Act
      const result = await service.createTrustPin(dto);

      // Assert
      expect(result).toEqual(expect.objectContaining({
        organizationId: orgId,
        issuerId,
        network: "testnet",
        keyId: "key-1",
        status: "ACTIVE",
      }));
    });

    it("rejects if issuer does not exist", async () => {
      // Arrange
      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(null);

      const dto: CreateCredentialVerificationKeyTrustPinDto = {
        organizationId: orgId,
        issuerId: "nonexistent",
        network: "testnet",
        keyId: "key-1",
        trustedKeySnapshot: {
          alg: "EdDSA",
          crv: "Ed25519",
          kid: "key-1",
          kty: "OKP",
          x: "dGVzdC1wdWJsaWMta2V5",
          use: "sig",
          status: "active",
        },
        effectiveAt: new Date().toISOString(),
      };

      // Act & Assert
      await expect(service.createTrustPin(dto)).rejects.toThrow(NotFoundException);
    });

    it("rejects if issuer belongs to different organization", async () => {
      // Arrange
      const mockIssuer = { id: issuerId, organizationId: "different_org" };
      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(mockIssuer);

      const dto: CreateCredentialVerificationKeyTrustPinDto = {
        organizationId: orgId,
        issuerId,
        network: "testnet",
        keyId: "key-1",
        trustedKeySnapshot: {
          alg: "EdDSA",
          crv: "Ed25519",
          kid: "key-1",
          kty: "OKP",
          x: "dGVzdC1wdWJsaWMta2V5",
          use: "sig",
          status: "active",
        },
        effectiveAt: new Date().toISOString(),
      };

      // Act & Assert
      await expect(service.createTrustPin(dto)).rejects.toThrow(expect.objectContaining({
        name: "ForbiddenException",
      }));
    });

    it("rejects if active pin already exists for this issuer/network/key", async () => {
      // Arrange
      const mockIssuer = { id: issuerId, organizationId: orgId };
      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(mockIssuer);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findFirst").mockResolvedValue(
        buildTrustPin("existing", orgId, issuerId) as any,
      );

      const dto: CreateCredentialVerificationKeyTrustPinDto = {
        organizationId: orgId,
        issuerId,
        network: "testnet",
        keyId: "key-1",
        trustedKeySnapshot: {
          alg: "EdDSA",
          crv: "Ed25519",
          kid: "key-1",
          kty: "OKP",
          x: "dGVzdC1wdWJsaWMta2V5",
          use: "sig",
          status: "active",
        },
        effectiveAt: new Date().toISOString(),
      };

      // Act & Assert
      await expect(service.createTrustPin(dto)).rejects.toThrow(ConflictException);
    });

    it("rejects if key snapshot contains private key markers", async () => {
      // Arrange
      const mockIssuer = { id: issuerId, organizationId: orgId };
      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(mockIssuer);

      const dto: CreateCredentialVerificationKeyTrustPinDto = {
        organizationId: orgId,
        issuerId,
        network: "testnet",
        keyId: "key-1",
        trustedKeySnapshot: {
          alg: "EdDSA",
          crv: "Ed25519",
          kid: "key-1",
          kty: "OKP",
          x: "dGVzdC1wdWJsaWMta2V5",
          use: "sig",
          status: "active",
          d: "private_key_material", // Private key marker - should be rejected
        } as any,
        effectiveAt: new Date().toISOString(),
      };

      // Act & Assert
      await expect(service.createTrustPin(dto)).rejects.toThrow(BadRequestException);
    });

    it("rejects if key algorithm is not EdDSA/Ed25519", async () => {
      // Arrange
      const mockIssuer = { id: issuerId, organizationId: orgId };
      jest.spyOn(prisma.issuer, "findUnique").mockResolvedValue(mockIssuer);

      const dto: CreateCredentialVerificationKeyTrustPinDto = {
        organizationId: orgId,
        issuerId,
        network: "testnet",
        keyId: "key-1",
        trustedKeySnapshot: {
          alg: "ECDSA",
          crv: "P-256",
          kid: "key-1",
          kty: "EC",
          x: "dGVzdC1wdWJsaWMta2V5",
          use: "sig",
          status: "active",
        } as any,
        effectiveAt: new Date().toISOString(),
      };

      // Act & Assert
      await expect(service.createTrustPin(dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe("getTrustPin", () => {
    it("returns a trust pin by ID", async () => {
      // Arrange
      const pin = buildTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findUnique").mockResolvedValue(pin as any);

      // Act
      const result = await service.getTrustPin(pin.id);

      // Assert
      expect(result).toEqual(expect.objectContaining({
        id: pin.id,
        status: "ACTIVE",
      }));
    });

    it("throws not found if pin doesn't exist", async () => {
      // Arrange
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findUnique").mockResolvedValue(null);

      // Act & Assert
      await expect(service.getTrustPin("nonexistent")).rejects.toThrow(NotFoundException);
    });
  });

  describe("getActiveTrustPin", () => {
    it("returns active trust pin for issuer/network/key", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findFirst").mockResolvedValue(pin as any);

      // Act
      const result = await service.getActiveTrustPin(orgId, issuerId, "testnet", "key-1");

      // Assert
      expect(result).toEqual(expect.objectContaining({
        status: "ACTIVE",
      }));
    });

    it("returns null if no active pin exists", async () => {
      // Arrange
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findFirst").mockResolvedValue(null);

      // Act
      const result = await service.getActiveTrustPin(orgId, issuerId, "testnet", "key-1");

      // Assert
      expect(result).toBeNull();
    });
  });

  describe("listTrustPins", () => {
    it("lists trust pins for an issuer with pagination", async () => {
      // Arrange
      const pins = [
        activeTrustPin("test1", orgId, issuerId),
        activeTrustPin("test2", orgId, issuerId, { keyId: "key-2" }),
      ];
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findMany").mockResolvedValue(pins as any);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "count").mockResolvedValue(2);

      // Act
      const result = await service.listTrustPins(orgId, issuerId, { page: 1, pageSize: 10 });

      // Assert
      expect(result.pins).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
    });

    it("filters pins by status", async () => {
      // Arrange
      const pins = [activeTrustPin("test1", orgId, issuerId)];
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findMany").mockResolvedValue(pins as any);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "count").mockResolvedValue(1);

      // Act
      const result = await service.listTrustPins(orgId, issuerId, { status: "ACTIVE" });

      // Assert
      expect(result.pins).toHaveLength(1);
    });
  });

  describe("retireTrustPin", () => {
    it("retires an active trust pin with correct revision", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findUnique").mockResolvedValue(pin as any);

      const retiredPin = { ...pin, status: "RETIRED", revision: 1 };
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "update").mockResolvedValue(retiredPin as any);

      // Act
      const result = await service.retireTrustPin(pin.id, pin.revision);

      // Assert
      expect(result).toEqual(expect.objectContaining({
        status: "RETIRED",
        revision: 1,
      }));
    });

    it("throws conflict if revision doesn't match", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findUnique").mockResolvedValue(pin as any);

      // Act & Assert
      await expect(service.retireTrustPin(pin.id, 999)).rejects.toThrow(ConflictException);
    });

    it("throws error if pin is already retired", async () => {
      // Arrange
      const pin = retiredTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findUnique").mockResolvedValue(pin as any);

      // Act & Assert
      await expect(service.retireTrustPin(pin.id, pin.revision)).rejects.toThrow(BadRequestException);
    });
  });

  describe("revokeTrustPin", () => {
    it("revokes an active trust pin with reason and actor", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findUnique").mockResolvedValue(pin as any);

      const revokedPin = { ...pin, status: "REVOKED", revokedAt: new Date(), revokedBy: userId, revocationReason: "Compromise", revision: 1 };
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "update").mockResolvedValue(revokedPin as any);

      const dto: UpdateCredentialVerificationKeyTrustPinStatusDto = {
        status: "REVOKED",
        expectedRevision: pin.revision,
        revocationReason: "Compromise",
        revokedBy: userId,
      };

      // Act
      const result = await service.revokeTrustPin(pin.id, dto);

      // Assert
      expect(result).toEqual(expect.objectContaining({
        status: "REVOKED",
        revokedBy: userId,
        revocationReason: "Compromise",
      }));
    });

    it("throws error if revocation reason is missing", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findUnique").mockResolvedValue(pin as any);

      const dto: UpdateCredentialVerificationKeyTrustPinStatusDto = {
        status: "REVOKED",
        revokedBy: userId,
      };

      // Act & Assert
      await expect(service.revokeTrustPin(pin.id, dto)).rejects.toThrow(BadRequestException);
    });

    it("throws error if pin is already revoked", async () => {
      // Arrange
      const pin = revokedTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findUnique").mockResolvedValue(pin as any);

      const dto: UpdateCredentialVerificationKeyTrustPinStatusDto = {
        status: "REVOKED",
        revocationReason: "Already compromised",
        revokedBy: userId,
      };

      // Act & Assert
      await expect(service.revokeTrustPin(pin.id, dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe("isKeyTrusted", () => {
    it("returns true for active, non-expired trust pin", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findFirst").mockResolvedValue(pin as any);

      // Act
      const result = await service.isKeyTrusted(orgId, issuerId, "testnet", "key-1");

      // Assert
      expect(result).toBe(true);
    });

    it("returns false for expired trust pin", async () => {
      // Arrange
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findFirst").mockResolvedValue(null);

      // Act
      const result = await service.isKeyTrusted(orgId, issuerId, "testnet", "key-1");

      // Assert
      expect(result).toBe(false);
    });

    it("returns false for revoked trust pin", async () => {
      // Arrange
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findFirst").mockResolvedValue(null);

      // Act
      const result = await service.isKeyTrusted(orgId, issuerId, "testnet", "key-1");

      // Assert
      expect(result).toBe(false);
    });
  });

  describe("getExpiredPins", () => {
    it("returns trust pins past their expiry date", async () => {
      // Arrange
      const expiredPin = expiredTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findMany").mockResolvedValue([expiredPin] as any);

      // Act
      const result = await service.getExpiredPins();

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].expiresAt).toBeLessThan(new Date());
    });
  });

  describe("deleteTrustPin", () => {
    it("deletes a trust pin", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findUnique").mockResolvedValue(pin as any);
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "delete").mockResolvedValue(pin as any);

      // Act
      await service.deleteTrustPin(pin.id);

      // Assert
      expect(prisma.credentialVerificationKeyTrustPin.delete).toHaveBeenCalledWith({ where: { id: pin.id } });
    });

    it("throws not found if pin doesn't exist", async () => {
      // Arrange
      jest.spyOn(prisma.credentialVerificationKeyTrustPin, "findUnique").mockResolvedValue(null);

      // Act & Assert
      await expect(service.deleteTrustPin("nonexistent")).rejects.toThrow(NotFoundException);
    });
  });
});
