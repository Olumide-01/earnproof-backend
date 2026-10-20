import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { OfflineBundleService } from "./offline-bundle.service";
import { CredentialSigningKeyringService } from "@/common/crypto/credential-signing-keyring.service";
import { PrismaService } from "@/database/prisma.service";
import { AuditService } from "@/audit/audit.service";
import { Clock } from "@/common/time/clock";
import { OfflineBundleDto } from "./dto/offline-bundle.dto";
import { CreateOfflineBundleDto } from "./dto/create-offline-bundle.dto";
import { canonicalize } from "@/common/crypto/canonicalize";
import { createHmac } from "crypto";

// Mock implementations
class FixedClock implements Clock {
  constructor(private readonly fixed: Date) {}

  now(): Date {
    return new Date(this.fixed.getTime());
  }

  nowMs(): number {
    return this.fixed.getTime();
  }
}

const mockConfigService = {
  getOrThrow: jest.fn((key: string) => {
    const values: Record<string, unknown> = {
      credentialSigningSecret: "test-signing-secret-key-for-testing-only",
    };
    return values[key];
  }),
  get: jest.fn((key: string) => {
    const values: Record<string, unknown> = {
      credentialSigningSecret: "test-signing-secret-key-for-testing-only",
    };
    return values[key];
  }),
};

describe("OfflineBundleService", () => {
  let service: OfflineBundleService;
  let prismaService: PrismaService;
  let auditService: AuditService;
  let signingKeyring: CredentialSigningKeyringService;
  let clock: FixedClock;

  const baseTime = new Date("2025-10-15T14:30:00.000Z");

  beforeEach(async () => {
    clock = new FixedClock(baseTime);

    const mockPrismaService = {
      proof: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      revocationCheckpoint: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      offlineBundle: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const mockAuditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OfflineBundleService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
        {
          provide: Clock,
          useValue: clock,
        },
        {
          provide: CredentialSigningKeyringService,
          useValue: new CredentialSigningKeyringService(mockConfigService as any),
        },
      ],
    }).compile();

    service = module.get<OfflineBundleService>(OfflineBundleService);
    prismaService = module.get<PrismaService>(PrismaService);
    auditService = module.get<AuditService>(AuditService);
    signingKeyring = module.get<CredentialSigningKeyringService>(
      CredentialSigningKeyringService,
    );
  });

  describe("generateBundle - Positive Cases", () => {
    it("should generate a valid bundle with single proof", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1"],
        expiresAt: new Date(baseTime.getTime() + 1800000).toISOString(), // +30 min
        maxFreshnessSeconds: 1800,
        operations: ["verify"],
        acknowledgeOfflineRisk: true,
      };

      const context = {
        organizationId: "org_1",
        requestingApiKeyId: "key_1",
        accessibleProofIds: new Set(["proof_1"]),
      };

      const bundle = await service.generateBundle(req, context);

      expect(bundle).toBeDefined();
      expect(bundle.version).toBe("earnproof.offline-bundle.v1");
      expect(bundle.bundleId).toMatch(/^obb_/);
      expect(bundle.manifest.expiresAt).toBe(req.expiresAt);
      expect(bundle.manifest.maxFreshnessSeconds).toBe(1800);
      expect(bundle.manifest.scope.proofIds).toEqual(["proof_1"]);
      expect(bundle.manifest.signature).toMatch(/^hmac-sha256:v\d+=([a-f0-9]{64})/);
    });

    it("should generate bundle with multiple proofs", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1", "proof_2", "proof_3"],
        expiresAt: new Date(baseTime.getTime() + 900000).toISOString(), // +15 min
        maxFreshnessSeconds: 3600,
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        requestingApiKeyId: "key_1",
        accessibleProofIds: new Set(["proof_1", "proof_2", "proof_3"]),
      };

      const bundle = await service.generateBundle(req, context);

      expect(bundle.manifest.scope.proofIds).toHaveLength(3);
    });

    it("should include verification keys in bundle", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1"],
        expiresAt: new Date(baseTime.getTime() + 1800000).toISOString(),
        maxFreshnessSeconds: 1800,
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        accessibleProofIds: new Set(["proof_1"]),
      };

      const bundle = await service.generateBundle(req, context);

      expect(bundle.contents.verificationKeys).toBeDefined();
      expect(bundle.contents.verificationKeys.length).toBeGreaterThan(0);
      expect(bundle.contents.verificationKeys[0].keyId).toBeDefined();
      expect(bundle.contents.verificationKeys[0].type).toBe("Ed25519");
    });
  });

  describe("generateBundle - Authorization Cases", () => {
    it("should reject if proof not in accessible list", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1"],
        expiresAt: new Date(baseTime.getTime() + 1800000).toISOString(),
        maxFreshnessSeconds: 1800,
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        accessibleProofIds: new Set(), // Empty: proof_1 not accessible
      };

      await expect(service.generateBundle(req, context)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should reject multiple inaccessible proofs with clear error", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1", "proof_2"],
        expiresAt: new Date(baseTime.getTime() + 1800000).toISOString(),
        maxFreshnessSeconds: 1800,
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        accessibleProofIds: new Set(), // Neither accessible
      };

      await expect(service.generateBundle(req, context)).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining("proof_1"),
        }),
      );
    });
  });

  describe("generateBundle - Validation Cases", () => {
    it("should reject expiry in the past", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1"],
        expiresAt: new Date(baseTime.getTime() - 1000).toISOString(), // Past
        maxFreshnessSeconds: 1800,
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        accessibleProofIds: new Set(["proof_1"]),
      };

      await expect(service.generateBundle(req, context)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject expiry too far in the future (> 1 hour)", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1"],
        expiresAt: new Date(baseTime.getTime() + 3600000 + 1000).toISOString(), // >1 hour
        maxFreshnessSeconds: 1800,
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        accessibleProofIds: new Set(["proof_1"]),
      };

      await expect(service.generateBundle(req, context)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject maxFreshnessSeconds below minimum (60)", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1"],
        expiresAt: new Date(baseTime.getTime() + 1800000).toISOString(),
        maxFreshnessSeconds: 59, // Below 60
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        accessibleProofIds: new Set(["proof_1"]),
      };

      await expect(service.generateBundle(req, context)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject maxFreshnessSeconds above maximum (86400)", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1"],
        expiresAt: new Date(baseTime.getTime() + 1800000).toISOString(),
        maxFreshnessSeconds: 86401, // Above 86400
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        accessibleProofIds: new Set(["proof_1"]),
      };

      await expect(service.generateBundle(req, context)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("generateBundle - Boundary Cases", () => {
    it("should accept expiry exactly at max lifetime (1 hour)", async () => {
      const expiresAt = new Date(baseTime.getTime() + 3600000); // Exactly 1 hour

      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1"],
        expiresAt: expiresAt.toISOString(),
        maxFreshnessSeconds: 1800,
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        accessibleProofIds: new Set(["proof_1"]),
      };

      const bundle = await service.generateBundle(req, context);
      expect(bundle).toBeDefined();
    });

    it("should accept maxFreshnessSeconds at minimum boundary (60)", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1"],
        expiresAt: new Date(baseTime.getTime() + 1800000).toISOString(),
        maxFreshnessSeconds: 60, // At minimum
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        accessibleProofIds: new Set(["proof_1"]),
      };

      const bundle = await service.generateBundle(req, context);
      expect(bundle.manifest.maxFreshnessSeconds).toBe(60);
    });

    it("should accept maxFreshnessSeconds at maximum boundary (86400)", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1"],
        expiresAt: new Date(baseTime.getTime() + 1800000).toISOString(),
        maxFreshnessSeconds: 86400, // At maximum
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        accessibleProofIds: new Set(["proof_1"]),
      };

      const bundle = await service.generateBundle(req, context);
      expect(bundle.manifest.maxFreshnessSeconds).toBe(86400);
    });
  });

  describe("verifyBundle - Positive Cases", () => {
    it("should verify a valid bundle", async () => {
      const now = new Date("2025-10-15T14:30:00.000Z");
      const expiresAt = new Date(now.getTime() + 1800000);

      // Create a properly signed bundle
      const bundleId = "obb_test123";
      const scope = {
        proofIds: ["proof_1"],
        operations: ["verify"] as const,
        organizationId: "org_1",
      };
      const contents = {
        credentials: [],
        verificationKeys: [],
        checkpoints: [],
      };

      // Compute contents hash
      const canonical = canonicalize(contents);
      const contentHash = require("crypto")
        .createHash("sha256")
        .update(canonical)
        .digest("hex");
      const contentsHash = `sha256:${contentHash}`;

      // Build and sign manifest
      const manifestToSign = {
        bundleId,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        maxFreshnessSeconds: 1800,
        issuer: "earnproof",
        scope,
        contentsHash,
      };

      const manifestCanonical = canonicalize(manifestToSign);
      const signingKey = "test-signing-secret-key-for-testing-only";
      const signatureHex = createHmac("sha256", signingKey)
        .update(manifestCanonical)
        .digest("hex");
      const signature = `hmac-sha256:v0=${signatureHex}`;

      const bundle: OfflineBundleDto = {
        version: "earnproof.offline-bundle.v1",
        bundleId,
        manifest: {
          bundleId,
          issuedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          maxFreshnessSeconds: 1800,
          issuer: "earnproof",
          scope,
          contentsHash,
          signature,
        },
        contents,
        generatedAt: now.toISOString(),
      };

      const result = await service.verifyBundle(bundle, now);
      expect(result).toBe(true);
    });
  });

  describe("verifyBundle - Expiry Boundary Cases", () => {
    it("should reject bundle at exact expiry instant (now >= expiresAt)", async () => {
      const now = new Date("2025-10-15T14:30:00.000Z");
      const expiresAt = new Date(now.getTime()); // Exactly now

      const bundle: OfflineBundleDto = {
        version: "earnproof.offline-bundle.v1",
        bundleId: "obb_test",
        manifest: {
          bundleId: "obb_test",
          issuedAt: new Date(now.getTime() - 1800000).toISOString(),
          expiresAt: expiresAt.toISOString(),
          maxFreshnessSeconds: 1800,
          issuer: "earnproof",
          scope: { proofIds: [], operations: ["verify"], organizationId: "org_1" },
          contentsHash: "sha256:abc123",
          signature: "hmac-sha256:v0=xyz789",
        },
        contents: { credentials: [], verificationKeys: [], checkpoints: [] },
        generatedAt: now.toISOString(),
      };

      await expect(service.verifyBundle(bundle, now)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should accept bundle just before expiry", async () => {
      const now = new Date("2025-10-15T14:30:00.000Z");
      const expiresAt = new Date(now.getTime() + 1); // 1ms in future

      const scope = {
        proofIds: ["proof_1"],
        operations: ["verify"] as const,
        organizationId: "org_1",
      };
      const contents = {
        credentials: [],
        verificationKeys: [],
        checkpoints: [],
      };

      const canonical = canonicalize(contents);
      const contentHash = require("crypto")
        .createHash("sha256")
        .update(canonical)
        .digest("hex");
      const contentsHash = `sha256:${contentHash}`;

      const manifestToSign = {
        bundleId: "obb_test",
        issuedAt: new Date(now.getTime() - 1800000).toISOString(),
        expiresAt: expiresAt.toISOString(),
        maxFreshnessSeconds: 1800,
        issuer: "earnproof",
        scope,
        contentsHash,
      };

      const manifestCanonical = canonicalize(manifestToSign);
      const signingKey = "test-signing-secret-key-for-testing-only";
      const signatureHex = createHmac("sha256", signingKey)
        .update(manifestCanonical)
        .digest("hex");
      const signature = `hmac-sha256:v0=${signatureHex}`;

      const bundle: OfflineBundleDto = {
        version: "earnproof.offline-bundle.v1",
        bundleId: "obb_test",
        manifest: {
          bundleId: "obb_test",
          issuedAt: new Date(now.getTime() - 1800000).toISOString(),
          expiresAt: expiresAt.toISOString(),
          maxFreshnessSeconds: 1800,
          issuer: "earnproof",
          scope,
          contentsHash,
          signature,
        },
        contents,
        generatedAt: now.toISOString(),
      };

      const result = await service.verifyBundle(bundle, now);
      expect(result).toBe(true);
    });
  });

  describe("verifyBundle - Checkpoint Freshness Boundary Cases", () => {
    it("should reject checkpoint exactly at freshness limit + 1 second", async () => {
      const now = new Date("2025-10-15T14:30:00.000Z");
      const expiresAt = new Date(now.getTime() + 1800000);
      const maxFreshness = 1800;
      const checkpointObservedAt = new Date(now.getTime() - (maxFreshness + 1) * 1000);

      const bundle: OfflineBundleDto = {
        version: "earnproof.offline-bundle.v1",
        bundleId: "obb_test",
        manifest: {
          bundleId: "obb_test",
          issuedAt: new Date(now.getTime() - 3600000).toISOString(),
          expiresAt: expiresAt.toISOString(),
          maxFreshnessSeconds: maxFreshness,
          issuer: "earnproof",
          scope: { proofIds: [], operations: ["verify"], organizationId: "org_1" },
          contentsHash: "sha256:abc123",
          signature: "hmac-sha256:v0=xyz789",
        },
        contents: {
          credentials: [],
          verificationKeys: [],
          checkpoints: [
            {
              proofId: "proof_1",
              version: 1,
              observedAt: checkpointObservedAt.toISOString(),
              status: "active",
            },
          ],
        },
        generatedAt: now.toISOString(),
      };

      await expect(service.verifyBundle(bundle, now)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should accept checkpoint at exact freshness limit", async () => {
      const now = new Date("2025-10-15T14:30:00.000Z");
      const expiresAt = new Date(now.getTime() + 1800000);
      const maxFreshness = 1800;
      const checkpointObservedAt = new Date(now.getTime() - maxFreshness * 1000);

      const scope = {
        proofIds: ["proof_1"],
        operations: ["verify"] as const,
        organizationId: "org_1",
      };
      const contents = {
        credentials: [],
        verificationKeys: [],
        checkpoints: [
          {
            proofId: "proof_1",
            version: 1,
            observedAt: checkpointObservedAt.toISOString(),
            status: "active",
          },
        ],
      };

      const canonical = canonicalize(contents);
      const contentHash = require("crypto")
        .createHash("sha256")
        .update(canonical)
        .digest("hex");
      const contentsHash = `sha256:${contentHash}`;

      const manifestToSign = {
        bundleId: "obb_test",
        issuedAt: new Date(now.getTime() - 3600000).toISOString(),
        expiresAt: expiresAt.toISOString(),
        maxFreshnessSeconds: maxFreshness,
        issuer: "earnproof",
        scope,
        contentsHash,
      };

      const manifestCanonical = canonicalize(manifestToSign);
      const signingKey = "test-signing-secret-key-for-testing-only";
      const signatureHex = createHmac("sha256", signingKey)
        .update(manifestCanonical)
        .digest("hex");
      const signature = `hmac-sha256:v0=${signatureHex}`;

      const bundle: OfflineBundleDto = {
        version: "earnproof.offline-bundle.v1",
        bundleId: "obb_test",
        manifest: {
          bundleId: "obb_test",
          issuedAt: new Date(now.getTime() - 3600000).toISOString(),
          expiresAt: expiresAt.toISOString(),
          maxFreshnessSeconds: maxFreshness,
          issuer: "earnproof",
          scope,
          contentsHash,
          signature,
        },
        contents,
        generatedAt: now.toISOString(),
      };

      const result = await service.verifyBundle(bundle, now);
      expect(result).toBe(true);
    });
  });

  describe("verifyBundle - Tamper Detection", () => {
    it("should reject bundle with invalid signature", async () => {
      const bundle: OfflineBundleDto = {
        version: "earnproof.offline-bundle.v1",
        bundleId: "obb_test",
        manifest: {
          bundleId: "obb_test",
          issuedAt: new Date("2025-10-15T13:00:00.000Z").toISOString(),
          expiresAt: new Date("2025-10-15T15:00:00.000Z").toISOString(),
          maxFreshnessSeconds: 1800,
          issuer: "earnproof",
          scope: { proofIds: [], operations: ["verify"], organizationId: "org_1" },
          contentsHash: "sha256:abc123",
          signature: "hmac-sha256:v0=0000000000000000000000000000000000000000000000000000000000000000", // Invalid
        },
        contents: { credentials: [], verificationKeys: [], checkpoints: [] },
        generatedAt: new Date().toISOString(),
      };

      await expect(service.verifyBundle(bundle)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject bundle with mismatched contents hash", async () => {
      const now = new Date("2025-10-15T14:30:00.000Z");
      const expiresAt = new Date(now.getTime() + 1800000);

      const scope = {
        proofIds: ["proof_1"],
        operations: ["verify"] as const,
        organizationId: "org_1",
      };
      const contents = {
        credentials: [],
        verificationKeys: [],
        checkpoints: [],
      };

      // Sign with one hash, but return with different hash
      const canonical = canonicalize(contents);
      const contentHash = require("crypto")
        .createHash("sha256")
        .update(canonical)
        .digest("hex");

      const manifestToSign = {
        bundleId: "obb_test",
        issuedAt: new Date(now.getTime() - 1800000).toISOString(),
        expiresAt: expiresAt.toISOString(),
        maxFreshnessSeconds: 1800,
        issuer: "earnproof",
        scope,
        contentsHash: `sha256:${contentHash}`,
      };

      const manifestCanonical = canonicalize(manifestToSign);
      const signingKey = "test-signing-secret-key-for-testing-only";
      const signatureHex = createHmac("sha256", signingKey)
        .update(manifestCanonical)
        .digest("hex");
      const signature = `hmac-sha256:v0=${signatureHex}`;

      const bundle: OfflineBundleDto = {
        version: "earnproof.offline-bundle.v1",
        bundleId: "obb_test",
        manifest: {
          bundleId: "obb_test",
          issuedAt: new Date(now.getTime() - 1800000).toISOString(),
          expiresAt: expiresAt.toISOString(),
          maxFreshnessSeconds: 1800,
          issuer: "earnproof",
          scope,
          contentsHash: "sha256:different_hash_000000000000000000000000000000000000",
          signature,
        },
        contents,
        generatedAt: now.toISOString(),
      };

      await expect(service.verifyBundle(bundle, now)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("verifyBundle - Version Handling", () => {
    it("should reject unknown bundle version", async () => {
      const bundle: OfflineBundleDto = {
        version: "earnproof.offline-bundle.v999", // Unknown version
        bundleId: "obb_test",
        manifest: {
          bundleId: "obb_test",
          issuedAt: "2025-10-15T13:00:00.000Z",
          expiresAt: "2025-10-15T15:00:00.000Z",
          maxFreshnessSeconds: 1800,
          issuer: "earnproof",
          scope: { proofIds: [], operations: ["verify"], organizationId: "org_1" },
          contentsHash: "sha256:abc123",
          signature: "hmac-sha256:v0=xyz789",
        },
        contents: { credentials: [], verificationKeys: [], checkpoints: [] },
        generatedAt: "2025-10-15T14:30:00.000Z",
      };

      await expect(service.verifyBundle(bundle)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("Regression Cases - Private Data Exclusion", () => {
    it("should never include secrets in built credentials", async () => {
      const req: CreateOfflineBundleDto = {
        proofIds: ["proof_1"],
        expiresAt: new Date(baseTime.getTime() + 1800000).toISOString(),
        maxFreshnessSeconds: 1800,
        operations: ["verify"],
      };

      const context = {
        organizationId: "org_1",
        accessibleProofIds: new Set(["proof_1"]),
      };

      const bundle = await service.generateBundle(req, context);

      // Verify no private keys appear in serialized bundle
      const bundleJson = JSON.stringify(bundle);
      expect(bundleJson).not.toContain("privateKey");
      expect(bundleJson).not.toContain("secret");
      expect(bundleJson).not.toContain("walletAddress"); // Only walletHash allowed
    });
  });
});
