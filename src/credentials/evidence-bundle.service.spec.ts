import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CredentialSigningKeyringService } from "../common/crypto/credential-signing-keyring.service";
import {
  MAX_EVIDENCE_BUNDLE_BYTES,
  SignedEvidenceBundle,
} from "./dto/evidence-bundle.dto";
import { EvidenceBundleService } from "./evidence-bundle.service";

describe("EvidenceBundleService", () => {
  let service: EvidenceBundleService;
  let prismaMock: any;
  let configServiceMock: any;
  let keyringService: CredentialSigningKeyringService;

  const ACTIVE_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const V1_SECRET = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

  beforeEach(() => {
    prismaMock = {
      proof: {
        findUnique: jest.fn(),
      },
    };

    configServiceMock = {
      get: jest.fn((key: string) => {
        if (key === "credentialSigningKeyVersion") return 0;
        if (key === "credentialSigningKeyVersions.0") return ACTIVE_SECRET;
        if (key === "credentialSigningKeyVersions.1") return V1_SECRET;
        return undefined;
      }),
      getOrThrow: jest.fn((key: string) => {
        if (key === "credentialSigningKeyVersions.0") return ACTIVE_SECRET;
        return undefined;
      }),
    };

    keyringService = new CredentialSigningKeyringService(configServiceMock as ConfigService);

    service = new EvidenceBundleService(
      prismaMock as any,
      configServiceMock as ConfigService,
      keyringService,
    );
  });

  describe("generateBundle", () => {
    it("generates a signed evidence bundle containing allowed evidence and no private records", async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 7 * 86400 * 1000);

      prismaMock.proof.findUnique.mockResolvedValueOnce({
        id: "proof_123",
        status: "ACTIVE",
        network: "testnet",
        credentialHash: "sha256:cred123",
        contractTransactionHash: "tx_hash_abc",
        commitment: "sha256:commit_xyz",
        assetCode: "USDC",
        assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        createdAt: now,
        expiresAt,
      });

      const bundle = await service.generateBundle("proof_123", "testnet");

      expect(bundle).toBeDefined();
      expect(bundle.manifest.manifestVersion).toBe("1.0.0");
      expect(bundle.manifest.proofId).toBe("proof_123");
      expect(bundle.manifest.network).toBe("testnet");
      expect(bundle.manifest.evidence.credentialHash).toBe("sha256:cred123");
      expect(bundle.manifest.evidence.assetCode).toBe("USDC");
      expect(bundle.signing.keyId).toBe("earnproof-v0");
      expect(bundle.signing.algorithm).toBe("hmac-sha256");
      expect(bundle.signing.signature).toHaveLength(64);

      // Verify no sensitive fields (e.g. memo, amount, counterparty) leaked into manifest
      expect(bundle.manifest.evidence).not.toHaveProperty("amount");
      expect(bundle.manifest.evidence).not.toHaveProperty("memo");
      expect(bundle.manifest.evidence).not.toHaveProperty("walletAddress");
    });

    it("rejects generation for non-existent proof", async () => {
      prismaMock.proof.findUnique.mockResolvedValueOnce(null);

      await expect(service.generateBundle("non_existent")).rejects.toThrow(NotFoundException);
    });

    it("rejects generation for revoked or inactive proof", async () => {
      prismaMock.proof.findUnique.mockResolvedValueOnce({
        id: "proof_revoked",
        status: "REVOKED",
        expiresAt: new Date(Date.now() + 100000),
      });

      await expect(service.generateBundle("proof_revoked")).rejects.toThrow(BadRequestException);
    });

    it("rejects generation for expired proof", async () => {
      prismaMock.proof.findUnique.mockResolvedValueOnce({
        id: "proof_expired",
        status: "ACTIVE",
        expiresAt: new Date(Date.now() - 100000),
      });

      await expect(service.generateBundle("proof_expired")).rejects.toThrow(BadRequestException);
    });
  });

  describe("verifyBundle", () => {
    let validBundle: SignedEvidenceBundle;

    beforeEach(async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 7 * 86400 * 1000);

      prismaMock.proof.findUnique.mockResolvedValueOnce({
        id: "proof_valid",
        status: "ACTIVE",
        network: "testnet",
        credentialHash: "sha256:valid_hash",
        contractTransactionHash: "tx_123",
        commitment: "sha256:com_123",
        assetCode: "XLM",
        assetIssuer: null,
        createdAt: now,
        expiresAt,
      });

      validBundle = await service.generateBundle("proof_valid", "testnet");
    });

    it("accepts a valid, untampered evidence bundle", async () => {
      const verdict = await service.verifyBundle(validBundle, "testnet");
      expect(verdict.valid).toBe(true);
      expect(verdict.bundleId).toBe(validBundle.manifest.bundleId);
      expect(verdict.proofId).toBe("proof_valid");
      expect(verdict.keyId).toBe("earnproof-v0");
    });

    it("accepts a valid bundle passed as serialized JSON string", async () => {
      const jsonStr = JSON.stringify(validBundle);
      const verdict = await service.verifyBundle(jsonStr, "testnet");
      expect(verdict.valid).toBe(true);
    });

    it("fails on signature tampering / content modification", async () => {
      const tampered: SignedEvidenceBundle = {
        ...validBundle,
        manifest: {
          ...validBundle.manifest,
          evidence: {
            ...validBundle.manifest.evidence,
            credentialHash: "sha256:tampered_hash_here",
          },
        },
      };

      const verdict = await service.verifyBundle(tampered, "testnet");
      expect(verdict.valid).toBe(false);
      expect(verdict.reason).toMatch(/Signature mismatch/);
    });

    it("fails on unsupported manifest version", async () => {
      const unsupported: any = {
        ...validBundle,
        manifest: {
          ...validBundle.manifest,
          manifestVersion: "2.0.0",
        },
      };

      const verdict = await service.verifyBundle(unsupported, "testnet");
      expect(verdict.valid).toBe(false);
      expect(verdict.reason).toMatch(/Unsupported manifest version/);
    });

    it("fails on network mismatch", async () => {
      const verdict = await service.verifyBundle(validBundle, "mainnet");
      expect(verdict.valid).toBe(false);
      expect(verdict.reason).toMatch(/Network mismatch/);
    });

    it("fails on expired evidence", async () => {
      const expiredBundle: any = {
        ...validBundle,
        manifest: {
          ...validBundle.manifest,
          evidence: {
            ...validBundle.manifest.evidence,
            expiresAt: new Date(Date.now() - 10000).toISOString(),
          },
        },
      };

      const verdict = await service.verifyBundle(expiredBundle, "testnet");
      expect(verdict.valid).toBe(false);
      expect(verdict.reason).toMatch(/Evidence has expired/);
    });

    it("fails on unsupported or retired key version", async () => {
      const retiredKeyBundle: SignedEvidenceBundle = {
        ...validBundle,
        signing: {
          ...validBundle.signing,
          keyId: "earnproof-v99", // not loaded in keyring
        },
      };

      const verdict = await service.verifyBundle(retiredKeyBundle, "testnet");
      expect(verdict.valid).toBe(false);
      expect(verdict.reason).toMatch(/Signing key version .* is expired, retired, or not loaded/);
    });

    it("fails if bundle payload exceeds maximum byte size", async () => {
      const hugeString = "a".repeat(MAX_EVIDENCE_BUNDLE_BYTES + 10);
      const verdict = await service.verifyBundle(hugeString);
      expect(verdict.valid).toBe(false);
      expect(verdict.reason).toMatch(/exceeds maximum allowed size/);
    });
  });
});
