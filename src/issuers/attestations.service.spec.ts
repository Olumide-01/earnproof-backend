import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { AttestationsService } from "./attestations.service";

const NOW = new Date("2026-09-24T12:00:00.000Z");

const config = { get: jest.fn((_key: string, def: number) => def) };

function serviceWith(row: object | null) {
  const prisma = {
    attestation: { findUnique: jest.fn().mockResolvedValue(row) },
  };
  return {
    prisma,
    service: new AttestationsService(prisma as never, config as never),
  };
}

describe("AttestationsService", () => {
  it("computes ACTIVE for a live attestation", async () => {
    const { service } = serviceWith({
      status: ResourceStatus.ACTIVE,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      revokedAt: null,
    });
    await expect(service.getEffectiveStatus("a", NOW)).resolves.toBe("ACTIVE");
  });

  it("computes EXPIRED from live fields even before the reconciler runs", async () => {
    const { service } = serviceWith({
      status: ResourceStatus.ACTIVE, // stored status still ACTIVE
      expiresAt: new Date(NOW.getTime() - 3_600_000),
      revokedAt: null,
    });
    await expect(service.getEffectiveStatus("a", NOW)).resolves.toBe("EXPIRED");
  });

  it("throws NotFound for an unknown attestation", async () => {
    const { service } = serviceWith(null);
    await expect(service.getEffectiveStatus("missing", NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("refuses issuance for an expired attestation", async () => {
    const { service } = serviceWith({
      status: ResourceStatus.ACTIVE,
      expiresAt: new Date(NOW.getTime() - 3_600_000),
      revokedAt: null,
    });
    await expect(service.canAuthorizeIssuance("a", NOW)).resolves.toBe(false);
    await expect(
      service.assertCanAuthorizeIssuance("a", NOW),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("permits issuance for an active attestation", async () => {
    const { service } = serviceWith({
      status: ResourceStatus.ACTIVE,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      revokedAt: null,
    });
    await expect(service.canAuthorizeIssuance("a", NOW)).resolves.toBe(true);
    await expect(
      service.assertCanAuthorizeIssuance("a", NOW),
    ).resolves.toBeUndefined();
  });

  it("treats an unknown attestation as unable to authorize issuance", async () => {
    const { service } = serviceWith(null);
    await expect(service.canAuthorizeIssuance("missing", NOW)).resolves.toBe(
      false,
    );
  });
});

describe("AttestationsService - policy version tracking (#307)", () => {
  describe("capturePolicyVersion", () => {
    it("should create deterministic policy version string", () => {
      const { service } = serviceWith({
        status: ResourceStatus.ACTIVE,
        expiresAt: new Date(NOW.getTime() + 3_600_000),
        revokedAt: null,
        signingKeyVersionId: "key-v5",
        createdAt: new Date("2026-10-15T12:30:45.000Z"),
      });

      const attestation = {
        signingKeyVersionId: "key-v5",
        createdAt: new Date("2026-10-15T12:30:45.000Z"),
      };

      const version = service.capturePolicyVersion(attestation as never);

      expect(version).toContain("key-v5");
      expect(version).toContain("2026-10-15T12:30:45.000Z");
    });

    it("should produce identical versions for identical attestations", () => {
      const { service } = serviceWith({});

      const attestation = {
        signingKeyVersionId: "key-v1",
        createdAt: new Date("2026-10-16T00:00:00.000Z"),
      };

      const version1 = service.capturePolicyVersion(attestation as never);
      const version2 = service.capturePolicyVersion(attestation as never);

      expect(version1).toBe(version2);
    });

    it("should produce different versions for different signing keys", () => {
      const { service } = serviceWith({});

      const att1 = {
        signingKeyVersionId: "key-v1",
        createdAt: new Date("2026-10-16T00:00:00.000Z"),
      };
      const att2 = {
        signingKeyVersionId: "key-v2",
        createdAt: new Date("2026-10-16T00:00:00.000Z"),
      };

      const version1 = service.capturePolicyVersion(att1 as never);
      const version2 = service.capturePolicyVersion(att2 as never);

      expect(version1).not.toBe(version2);
      expect(version1).toContain("key-v1");
      expect(version2).toContain("key-v2");
    });
  });

  describe("recordPolicyVersion", () => {
    it("should record a policy version on attestation", async () => {
      const policyVersion = "earnproof.attestation.policy.v1:key-v1:2026-10-16T00:00:00Z";
      const prisma = {
        attestation: {
          findUnique: jest.fn().mockResolvedValue({
            id: "att-1",
            policyVersion: null,
          }),
          update: jest.fn().mockResolvedValue({
            id: "att-1",
            policyVersion,
          }),
          findUniqueOrThrow: jest.fn(),
        },
      };
      const service = new AttestationsService(prisma as never, config as never);

      await service.recordPolicyVersion("att-1", policyVersion);

      expect(prisma.attestation.update).toHaveBeenCalledWith({
        where: { id: "att-1" },
        data: { policyVersion },
      });
    });

    it("should be idempotent if version already recorded", async () => {
      const existingVersion = "earnproof.attestation.policy.v1:key-v1:2026-10-16T00:00:00Z";
      const prisma = {
        attestation: {
          findUnique: jest.fn().mockResolvedValue({
            id: "att-1",
            policyVersion: existingVersion,
          }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            id: "att-1",
            policyVersion: existingVersion,
          }),
          update: jest.fn(),
        },
      };
      const service = new AttestationsService(prisma as never, config as never);

      await service.recordPolicyVersion("att-1", "different-version");

      expect(prisma.attestation.update).not.toHaveBeenCalled();
    });

    it("should throw NotFoundException if attestation not found", async () => {
      const prisma = {
        attestation: {
          findUnique: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
          findUniqueOrThrow: jest.fn(),
        },
      };
      const service = new AttestationsService(prisma as never, config as never);

      await expect(service.recordPolicyVersion("nonexistent", "version")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getOrCapturePolicyVersion", () => {
    it("should return existing policy version if already recorded", async () => {
      const existingVersion = "earnproof.attestation.policy.v1:key-v1:2026-10-16T00:00:00Z";
      const prisma = {
        attestation: {
          findUnique: jest.fn().mockResolvedValue({
            id: "att-1",
            policyVersion: existingVersion,
            signingKeyVersionId: "key-v1",
            createdAt: new Date("2026-10-16T00:00:00Z"),
          }),
          update: jest.fn(),
          findUniqueOrThrow: jest.fn(),
        },
      };
      const service = new AttestationsService(prisma as never, config as never);

      const result = await service.getOrCapturePolicyVersion("att-1");

      expect(result).toBe(existingVersion);
      expect(prisma.attestation.update).not.toHaveBeenCalled();
    });

    it("should capture and record version if not yet set", async () => {
      const prisma = {
        attestation: {
          findUnique: jest.fn().mockResolvedValue({
            id: "att-1",
            policyVersion: null,
            signingKeyVersionId: "key-v1",
            createdAt: new Date("2026-10-16T00:00:00Z"),
          }),
          update: jest.fn().mockResolvedValue({
            id: "att-1",
            policyVersion: "earnproof.attestation.policy.v1:key-v1:2026-10-16T00:00:00.000Z",
          }),
          findUniqueOrThrow: jest.fn(),
        },
      };
      const service = new AttestationsService(prisma as never, config as never);

      const result = await service.getOrCapturePolicyVersion("att-1");

      expect(result).toContain("earnproof.attestation.policy.v1");
      expect(result).toContain("key-v1");
      expect(prisma.attestation.update).toHaveBeenCalled();
    });

    it("should throw NotFoundException if attestation not found", async () => {
      const prisma = {
        attestation: {
          findUnique: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
          findUniqueOrThrow: jest.fn(),
        },
      };
      const service = new AttestationsService(prisma as never, config as never);

      await expect(service.getOrCapturePolicyVersion("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
