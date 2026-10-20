import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { IssuerKeyLifecycleState } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { IssuerSigningKeysService } from "./issuer-signing-keys.service";

describe("IssuerSigningKeysService", () => {
  let service: IssuerSigningKeysService;
  let prisma: {
    issuer: { findUnique: jest.Mock };
    issuerSigningKey: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      issuer: { findUnique: jest.fn() },
      issuerSigningKey: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new IssuerSigningKeysService(prisma as unknown as PrismaService);
  });

  describe("registerKey", () => {
    it("should register a pending key when activateImmediately is false", async () => {
      prisma.issuer.findUnique.mockResolvedValue({ id: "iss-1" });
      prisma.issuerSigningKey.findUnique.mockResolvedValue(null);
      prisma.issuerSigningKey.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: "key-rec-1",
          ...data,
          retiredAt: null,
          compromisedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        }),
      );

      const result = await service.registerKey("iss-1", {
        keyId: "k-1",
        publicKey: "ed25519-pub-key-1",
        commitmentHash: "sha256:hash-1",
        activateImmediately: false,
      });

      expect(result.keyId).toBe("k-1");
      expect(result.state).toBe(IssuerKeyLifecycleState.PENDING);
      expect(result.activatedAt).toBeNull();
    });

    it("should reject duplicate keyId for same issuer", async () => {
      prisma.issuer.findUnique.mockResolvedValue({ id: "iss-1" });
      prisma.issuerSigningKey.findUnique.mockResolvedValue({ id: "existing-key" });

      await expect(
        service.registerKey("iss-1", {
          keyId: "k-1",
          publicKey: "pub-1",
          commitmentHash: "hash-1",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("should fail when issuer does not exist", async () => {
      prisma.issuer.findUnique.mockResolvedValue(null);

      await expect(
        service.registerKey("non-existent", {
          keyId: "k-1",
          publicKey: "pub-1",
          commitmentHash: "hash-1",
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("retireKey", () => {
    it("should retire an active key", async () => {
      prisma.issuerSigningKey.findUnique.mockResolvedValue({
        id: "key-rec-1",
        issuerId: "iss-1",
        keyId: "k-1",
        publicKey: "pub-1",
        commitmentHash: "hash-1",
        state: IssuerKeyLifecycleState.ACTIVE,
      });
      prisma.issuerSigningKey.update.mockResolvedValue({
        id: "key-rec-1",
        issuerId: "iss-1",
        keyId: "k-1",
        publicKey: "pub-1",
        commitmentHash: "hash-1",
        state: IssuerKeyLifecycleState.RETIRED,
        retiredAt: new Date(),
        compromisedAt: null,
        revokedAt: null,
        activatedAt: new Date(),
        createdAt: new Date(),
      });

      const result = await service.retireKey("iss-1", "k-1");
      expect(result.state).toBe(IssuerKeyLifecycleState.RETIRED);
      expect(result.retiredAt).toBeDefined();
    });

    it("should throw BadRequestException when trying to retire a compromised key", async () => {
      prisma.issuerSigningKey.findUnique.mockResolvedValue({
        id: "key-rec-1",
        state: IssuerKeyLifecycleState.COMPROMISED,
      });

      await expect(service.retireKey("iss-1", "k-1")).rejects.toThrow(BadRequestException);
    });
  });

  describe("markCompromised", () => {
    it("should mark key as COMPROMISED with timestamp", async () => {
      prisma.issuerSigningKey.findUnique.mockResolvedValue({
        id: "key-rec-1",
        issuerId: "iss-1",
        keyId: "k-1",
        state: IssuerKeyLifecycleState.ACTIVE,
      });
      prisma.issuerSigningKey.update.mockResolvedValue({
        id: "key-rec-1",
        issuerId: "iss-1",
        keyId: "k-1",
        publicKey: "pub-1",
        commitmentHash: "hash-1",
        state: IssuerKeyLifecycleState.COMPROMISED,
        compromisedAt: new Date(),
        retiredAt: null,
        revokedAt: null,
        activatedAt: new Date(),
        createdAt: new Date(),
      });

      const result = await service.markCompromised("iss-1", "k-1");
      expect(result.state).toBe(IssuerKeyLifecycleState.COMPROMISED);
      expect(result.compromisedAt).toBeDefined();
    });
  });

  describe("reconcileKeyWithContract", () => {
    it("should return reconciled: true when commitment matches", async () => {
      prisma.issuerSigningKey.findUnique.mockResolvedValue({
        id: "key-rec-1",
        commitmentHash: "sha256:matched",
      });
      prisma.issuerSigningKey.update.mockResolvedValue({});

      const outcome = await service.reconcileKeyWithContract("iss-1", "k-1", "sha256:matched");
      expect(outcome.reconciled).toBe(true);
      expect(outcome.conflict).toBeUndefined();
    });

    it("should return conflict when on-chain commitment drifts", async () => {
      prisma.issuerSigningKey.findUnique.mockResolvedValue({
        id: "key-rec-1",
        commitmentHash: "sha256:local",
      });

      const outcome = await service.reconcileKeyWithContract("iss-1", "k-1", "sha256:remote-drift");
      expect(outcome.reconciled).toBe(false);
      expect(outcome.conflict).toContain("Commitment hash mismatch");
    });
  });
});
