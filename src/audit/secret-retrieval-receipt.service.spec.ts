import { Test } from "@nestjs/testing";
import { SecretRetrievalReceiptService } from "./secret-retrieval-receipt.service";
import { PrismaService } from "../database/prisma.service";
import {
  SecretType,
  DeliveryChannel,
  ReceiptStatus,
} from "./types/secret-retrieval-receipt.types";

describe("SecretRetrievalReceiptService", () => {
  let service: SecretRetrievalReceiptService;
  let prisma: PrismaService;

  const mockPrismaService = {
    secretRetrievalReceipt: {
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        SecretRetrievalReceiptService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<SecretRetrievalReceiptService>(
      SecretRetrievalReceiptService,
    );
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("deriveOrgSalt", () => {
    it("should derive a deterministic salt from organizationId", () => {
      // Call the private method via reflection (for testing only)
      const salt1 = (service as any).deriveOrgSalt("org_123");
      const salt2 = (service as any).deriveOrgSalt("org_123");

      expect(salt1).toBe(salt2);
      expect(salt1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it("should derive different salts for different organizationIds", () => {
      const salt1 = (service as any).deriveOrgSalt("org_123");
      const salt2 = (service as any).deriveOrgSalt("org_456");

      expect(salt1).not.toBe(salt2);
    });
  });

  describe("computeAcknowledgementHash", () => {
    it("should compute a deterministic hash", () => {
      const orgId = "org_123";
      const resourceId = "key_abc";
      const secretType = SecretType.API_KEY;
      const revealedAt = new Date("2025-10-15T10:30:00Z");

      const hash1 = service.computeAcknowledgementHash(
        orgId,
        resourceId,
        secretType,
        revealedAt,
      );
      const hash2 = service.computeAcknowledgementHash(
        orgId,
        resourceId,
        secretType,
        revealedAt,
      );

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it("should produce different hashes for different inputs", () => {
      const orgId = "org_123";
      const revealedAt = new Date("2025-10-15T10:30:00Z");

      const hash1 = service.computeAcknowledgementHash(
        orgId,
        "key_abc",
        SecretType.API_KEY,
        revealedAt,
      );
      const hash2 = service.computeAcknowledgementHash(
        orgId,
        "key_xyz", // different resource
        SecretType.API_KEY,
        revealedAt,
      );
      const hash3 = service.computeAcknowledgementHash(
        orgId,
        "key_abc",
        SecretType.WEBHOOK, // different type
        revealedAt,
      );
      const hash4 = service.computeAcknowledgementHash(
        "org_456", // different org
        "key_abc",
        SecretType.API_KEY,
        revealedAt,
      );

      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1).not.toBe(hash4);
    });

    it("should produce different hashes for different timestamps", () => {
      const orgId = "org_123";
      const resourceId = "key_abc";
      const secretType = SecretType.API_KEY;

      const hash1 = service.computeAcknowledgementHash(
        orgId,
        resourceId,
        secretType,
        new Date("2025-10-15T10:30:00Z"),
      );
      const hash2 = service.computeAcknowledgementHash(
        orgId,
        resourceId,
        secretType,
        new Date("2025-10-15T10:30:01Z"), // 1 second later
      );

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("isExpired", () => {
    it("should return true if status is EXPIRED", () => {
      const receipt = { status: ReceiptStatus.EXPIRED };
      expect(service.isExpired(receipt)).toBe(true);
    });

    it("should return true if expiresAt is in the past", () => {
      const receipt = {
        status: ReceiptStatus.ACTIVE,
        expiresAt: new Date(Date.now() - 1000), // 1 second ago
      };
      expect(service.isExpired(receipt)).toBe(true);
    });

    it("should return true if expiresAt is exactly now", () => {
      const now = new Date();
      const receipt = {
        status: ReceiptStatus.ACTIVE,
        expiresAt: now,
      };
      expect(service.isExpired(receipt)).toBe(true);
    });

    it("should return false if expiresAt is in the future", () => {
      const receipt = {
        status: ReceiptStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 1000), // 1 second from now
      };
      expect(service.isExpired(receipt)).toBe(false);
    });

    it("should return false if no expiry is set", () => {
      const receipt = {
        status: ReceiptStatus.ACTIVE,
        expiresAt: null,
      };
      expect(service.isExpired(receipt)).toBe(false);
    });
  });

  describe("create", () => {
    it("should create a receipt with computed hash and default expiry", async () => {
      const input = {
        organizationId: "org_123",
        secretType: SecretType.API_KEY,
        resourceId: "key_abc",
        resourceReference: "Ep4ZxkY3",
        recipientId: "user_456",
        revealedAt: new Date("2025-10-15T10:30:00Z"),
      };

      const mockReceipt = {
        id: "receipt_123",
        ...input,
        deliveryChannel: DeliveryChannel.HTTP_RESPONSE,
        acknowledgementHash: "abc123def456",
        status: ReceiptStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        metadata: {},
        hash: "hash123",
        hashVersion: 1,
        prevHash: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.secretRetrievalReceipt.create as jest.Mock).mockResolvedValue(
        mockReceipt,
      );

      const result = await service.create(input);

      expect(result).toBeDefined();
      expect(result.id).toBe("receipt_123");
      expect(result.secretType).toBe(SecretType.API_KEY);
      expect(result.resourceId).toBe("key_abc");
      expect(prisma.secretRetrievalReceipt.create).toHaveBeenCalled();
    });

    it("should respect custom expiresAt", async () => {
      const customExpiry = new Date("2026-10-15T10:30:00Z");
      const input = {
        organizationId: "org_123",
        secretType: SecretType.WEBHOOK,
        resourceId: "webhook_789",
        resourceReference: "https://example.com/webhook",
        expiresAt: customExpiry,
        revealedAt: new Date(),
      };

      const mockReceipt = {
        id: "receipt_124",
        ...input,
        deliveryChannel: DeliveryChannel.HTTP_RESPONSE,
        acknowledgementHash: "hash",
        status: ReceiptStatus.ACTIVE,
        metadata: {},
        hash: "hash",
        hashVersion: 1,
        prevHash: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.secretRetrievalReceipt.create as jest.Mock).mockResolvedValue(
        mockReceipt,
      );

      const result = await service.create(input);

      expect(result.expiresAt).toEqual(customExpiry);
    });
  });

  describe("expire", () => {
    it("should mark a receipt as expired", async () => {
      const receiptId = "receipt_123";
      const mockUpdated = {
        id: receiptId,
        organizationId: "org_123",
        secretType: SecretType.EXPORT,
        resourceId: "export_789",
        resourceReference: "export-payments",
        recipientId: "user_456",
        deliveryChannel: DeliveryChannel.DOWNLOAD_URL,
        revealedAt: new Date(),
        acknowledgementHash: "hash",
        status: ReceiptStatus.EXPIRED,
        expiresAt: new Date(),
        metadata: {},
        hash: "hash",
        hashVersion: 1,
        prevHash: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.secretRetrievalReceipt.update as jest.Mock).mockResolvedValue(
        mockUpdated,
      );

      const result = await service.expire(receiptId);

      expect(result.status).toBe(ReceiptStatus.EXPIRED);
      expect(prisma.secretRetrievalReceipt.update).toHaveBeenCalledWith({
        where: { id: receiptId },
        data: {
          status: ReceiptStatus.EXPIRED,
          updatedAt: expect.any(Date),
        },
      });
    });
  });

  describe("findByOrganization", () => {
    it("should find receipts by organization and filters", async () => {
      const orgId = "org_123";
      const mockReceipts = [
        {
          id: "receipt_1",
          organizationId: orgId,
          secretType: SecretType.API_KEY,
          resourceId: "key_1",
          resourceReference: "prefix1",
          recipientId: "user_1",
          deliveryChannel: DeliveryChannel.HTTP_RESPONSE,
          revealedAt: new Date(),
          acknowledgementHash: "hash1",
          status: ReceiptStatus.ACTIVE,
          expiresAt: null,
          metadata: {},
          hash: "hash",
          hashVersion: 1,
          prevHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (prisma.secretRetrievalReceipt.findMany as jest.Mock).mockResolvedValue(
        mockReceipts,
      );

      const result = await service.findByOrganization(orgId, {
        secretType: SecretType.API_KEY,
      });

      expect(result).toHaveLength(1);
      expect(result[0].secretType).toBe(SecretType.API_KEY);
      expect(prisma.secretRetrievalReceipt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: orgId,
          }),
        }),
      );
    });
  });

  describe("findById", () => {
    it("should find a receipt by ID", async () => {
      const receiptId = "receipt_123";
      const mockReceipt = {
        id: receiptId,
        organizationId: "org_123",
        secretType: SecretType.API_KEY,
        resourceId: "key_abc",
        resourceReference: "Ep4ZxkY3",
        recipientId: "user_456",
        deliveryChannel: DeliveryChannel.HTTP_RESPONSE,
        revealedAt: new Date(),
        acknowledgementHash: "hash",
        status: ReceiptStatus.ACTIVE,
        expiresAt: null,
        metadata: {},
        hash: "hash",
        hashVersion: 1,
        prevHash: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.secretRetrievalReceipt.findUnique as jest.Mock).mockResolvedValue(
        mockReceipt,
      );

      const result = await service.findById(receiptId);

      expect(result).toBeDefined();
      expect(result?.id).toBe(receiptId);
    });

    it("should return null if receipt not found", async () => {
      (prisma.secretRetrievalReceipt.findUnique as jest.Mock).mockResolvedValue(
        null,
      );

      const result = await service.findById("nonexistent");

      expect(result).toBeNull();
    });
  });
});
