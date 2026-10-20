import { Test, TestingModule } from "@nestjs/testing";
import { CredentialVerificationKeyTrustPinController } from "./credential-verification-key-trust-pin.controller";
import { CredentialVerificationKeyTrustPinService } from "./credential-verification-key-trust-pin.service";
import {
  CreateCredentialVerificationKeyTrustPinDto,
  UpdateCredentialVerificationKeyTrustPinStatusDto,
} from "./dto/credential-verification-key-trust-pin.dto";
import { AuthenticatedUser } from "../auth/auth.types";
import { activeTrustPin, retiredTrustPin, revokedTrustPin } from "../testing/factories";

describe("CredentialVerificationKeyTrustPinController", () => {
  let controller: CredentialVerificationKeyTrustPinController;
  let service: CredentialVerificationKeyTrustPinService;

  // Synthetic test data
  const orgId = "synthetic_org_1";
  const issuerId = "synthetic_issuer_1";
  const adminUser: AuthenticatedUser = {
    id: "synthetic_user_admin",
    walletHash: "sha256:test",
    role: "ADMIN",
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CredentialVerificationKeyTrustPinController],
      providers: [
        {
          provide: CredentialVerificationKeyTrustPinService,
          useValue: {
            createTrustPin: jest.fn(),
            getTrustPin: jest.fn(),
            listTrustPins: jest.fn(),
            retireTrustPin: jest.fn(),
            revokeTrustPin: jest.fn(),
            deleteTrustPin: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<CredentialVerificationKeyTrustPinController>(
      CredentialVerificationKeyTrustPinController,
    );
    service = module.get<CredentialVerificationKeyTrustPinService>(
      CredentialVerificationKeyTrustPinService,
    );
  });

  describe("createTrustPin", () => {
    it("creates a trust pin for an issuer verification key", async () => {
      // Arrange
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
          x: "dGVzdC1wdWJsaWMta2V5LW1hdGVyaWFsLWJhc2U2NHVybA",
          use: "sig",
          status: "active",
        },
        effectiveAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      };

      const expectedPin = activeTrustPin("test1", orgId, issuerId);
      jest.spyOn(service, "createTrustPin").mockResolvedValue(expectedPin);

      // Act
      const result = await controller.createTrustPin(adminUser, dto);

      // Assert
      expect(result).toEqual(expectedPin);
      expect(service.createTrustPin).toHaveBeenCalledWith(dto);
    });
  });

  describe("getTrustPin", () => {
    it("retrieves a trust pin by ID", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      jest.spyOn(service, "getTrustPin").mockResolvedValue(pin);

      // Act
      const result = await controller.getTrustPin(pin.id);

      // Assert
      expect(result).toEqual(pin);
      expect(service.getTrustPin).toHaveBeenCalledWith(pin.id);
    });
  });

  describe("listTrustPins", () => {
    it("lists trust pins for an issuer", async () => {
      // Arrange
      const pins = [
        activeTrustPin("test1", orgId, issuerId),
        retiredTrustPin("test2", orgId, issuerId, { keyId: "key-2" }),
      ];
      jest.spyOn(service, "listTrustPins").mockResolvedValue({
        pins,
        total: 2,
        page: 1,
        pageSize: 10,
      });

      // Act
      const result = await controller.listTrustPins(
        adminUser,
        issuerId,
        orgId,
        undefined,
        "1",
        "10",
      );

      // Assert
      expect(result.pins).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("filters trust pins by status", async () => {
      // Arrange
      const activePins = [activeTrustPin("test1", orgId, issuerId)];
      jest.spyOn(service, "listTrustPins").mockResolvedValue({
        pins: activePins,
        total: 1,
        page: 1,
        pageSize: 10,
      });

      // Act
      const result = await controller.listTrustPins(
        adminUser,
        issuerId,
        orgId,
        "ACTIVE",
        "1",
        "10",
      );

      // Assert
      expect(result.pins).toHaveLength(1);
      expect(result.pins[0].status).toBe("ACTIVE");
    });
  });

  describe("retireTrustPin", () => {
    it("retires a trust pin", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      const retiredPin = { ...pin, status: "RETIRED", revision: 1 };
      jest.spyOn(service, "retireTrustPin").mockResolvedValue(retiredPin);

      // Act
      const result = await controller.retireTrustPin(
        adminUser,
        pin.id,
        { expectedRevision: pin.revision },
      );

      // Assert
      expect(result.status).toBe("RETIRED");
      expect(service.retireTrustPin).toHaveBeenCalledWith(pin.id, pin.revision);
    });
  });

  describe("revokeTrustPin", () => {
    it("revokes a trust pin due to compromise", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      const revokedPin = revokedTrustPin("test1", orgId, issuerId);
      jest.spyOn(service, "revokeTrustPin").mockResolvedValue(revokedPin);

      const dto: UpdateCredentialVerificationKeyTrustPinStatusDto = {
        status: "REVOKED",
        expectedRevision: pin.revision,
        revocationReason: "Key compromise detected",
        revokedBy: adminUser.id,
      };

      // Act
      const result = await controller.revokeTrustPin(adminUser, pin.id, dto);

      // Assert
      expect(result.status).toBe("REVOKED");
      expect(result.revokedBy).toBeTruthy();
      expect(result.revocationReason).toBe("Key compromise detected");
    });

    it("uses current user as revokedBy if not provided", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      const revokedPin = { ...pin, status: "REVOKED", revokedBy: adminUser.id };
      jest.spyOn(service, "revokeTrustPin").mockResolvedValue(revokedPin);

      const dto: UpdateCredentialVerificationKeyTrustPinStatusDto = {
        status: "REVOKED",
        revocationReason: "Key compromise detected",
      };

      // Act
      const result = await controller.revokeTrustPin(adminUser, pin.id, dto);

      // Assert
      expect(result.revokedBy).toBe(adminUser.id);
    });
  });

  describe("deleteTrustPin", () => {
    it("deletes a trust pin", async () => {
      // Arrange
      const pin = activeTrustPin("test1", orgId, issuerId);
      jest.spyOn(service, "deleteTrustPin").mockResolvedValue(undefined);

      // Act
      await controller.deleteTrustPin(pin.id);

      // Assert
      expect(service.deleteTrustPin).toHaveBeenCalledWith(pin.id);
    });
  });
});
