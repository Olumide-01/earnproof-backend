import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ReceiptService } from "./receipt.service";
import { PrismaService } from "../../database/prisma.service";
import { CanonicalizationService } from "../crypto/canonicalization.service";
import { SigningService } from "../crypto/signing.service";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makePrismaMock() {
  return {
    proof: {
      findFirst: jest.fn(),
    },
    disclosureReceipt: {
      create: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    signingKey: {
      findFirst: jest.fn(),
    },
  };
}

function makeCanonicalizationMock() {
  return {
    canonicalizeObject: jest.fn().mockImplementation((obj) => 
      JSON.stringify(obj, Object.keys(obj).sort())
    ),
  };
}

function makeSigningMock() {
  return {
    signCredential: jest.fn().mockResolvedValue({
      signature: "ed25519:mock_signature_base64url",
      keyId: "credential-key-0",
    }),
    verifyCredentialSignature: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createProof(overrides: Partial<{
  id: string;
  userId: string;
  type: string;
  status: string;
  expiresAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "proof_123",
    userId: overrides.userId ?? "user_456", 
    type: overrides.type ?? "EMPLOYMENT_VERIFICATION",
    status: overrides.status ?? "ACTIVE",
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86400000), // +24h
    user: {
      organizationMemberships: [{
        organizationId: "org_789",
        status: "ACTIVE",
      }],
    },
  };
}

function createDisclosureReceipt(overrides: Partial<{
  id: string;
  proofId: string;
  receiptHash: string;
}> = {}) {
  return {
    id: overrides.id ?? "receipt_123",
    organizationId: "org_789",
    proofId: overrides.proofId ?? "proof_123",
    receiptHash: overrides.receiptHash ?? "sha256_receipt_hash",
    signatureKeyId: "credential-key-0",
    issuedAt: new Date("2024-01-15T10:30:00Z"),
    expiresAt: new Date("2024-02-15T10:30:00Z"),
  };
}

function createSigningKey() {
  return {
    id: "credential-key-0",
    algorithm: "EdDSA",
    status: "ACTIVE",
  };
}

// ---------------------------------------------------------------------------
// ReceiptService.generateDisclosureReceipt
// ---------------------------------------------------------------------------

describe("ReceiptService.generateDisclosureReceipt", () => {
  let service: ReceiptService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let canonicalization: ReturnType<typeof makeCanonicalizationMock>;
  let signing: ReturnType<typeof makeSigningMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    canonicalization = makeCanonicalizationMock();
    signing = makeSigningMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReceiptService,
        { provide: PrismaService, useValue: prisma },
        { provide: CanonicalizationService, useValue: canonicalization },
        { provide: SigningService, useValue: signing },
      ],
    }).compile();

    service = module.get<ReceiptService>(ReceiptService);
  });

  it("generates signed disclosure receipt for valid proof", async () => {
    const proof = createProof();
    const signingKey = createSigningKey();
    const approvalData = {
      userId: "user_456",
      purpose: "Employment verification for background check",
      approvalTimestamp: new Date("2024-01-15T10:30:00Z"),
    };

    prisma.proof.findFirst.mockResolvedValue(proof);
    prisma.signingKey.findFirst.mockResolvedValue(signingKey);
    prisma.disclosureReceipt.create.mockResolvedValue(createDisclosureReceipt());

    const result = await service.generateDisclosureReceipt(
      "org_789",
      "proof_123", 
      approvalData,
      { policyVersion: "privacy-policy-v2.1" },
    );

    expect(result.receiptId).toMatch(/^receipt_/);
    expect(result.receipt.version).toBe("1.0");
    expect(result.receipt.organizationId).toBe("org_789");
    expect(result.receipt.proofId).toBe("proof_123");
    expect(result.receipt.proofType).toBe("EMPLOYMENT_VERIFICATION");
    expect(result.receipt.requester.userId).toBe("user_456");
    expect(result.receipt.requester.purpose).toBe(approvalData.purpose);
    expect(result.receipt.disclosure.policyVersion).toBe("privacy-policy-v2.1");

    expect(result.signature.algorithm).toBe("EdDSA");
    expect(result.signature.keyId).toBe("credential-key-0");
    expect(result.signature.signature).toBe("ed25519:mock_signature_base64url");

    expect(signing.signCredential).toHaveBeenCalledWith(
      expect.any(String), // canonicalized payload
      signingKey.id,
    );
  });

  it("rejects receipt generation for non-existent proof", async () => {
    prisma.proof.findFirst.mockResolvedValue(null);

    await expect(
      service.generateDisclosureReceipt(
        "org_789",
        "nonexistent_proof",
        {
          userId: "user_456",
          purpose: "Test",
          approvalTimestamp: new Date(),
        },
        {},
      ),
    ).rejects.toThrow(NotFoundException);

    expect(signing.signCredential).not.toHaveBeenCalled();
    expect(prisma.disclosureReceipt.create).not.toHaveBeenCalled();
  });

  it("rejects receipt generation for inactive proof", async () => {
    const proof = createProof({ status: "REVOKED" });
    prisma.proof.findFirst.mockResolvedValue(proof);

    await expect(
      service.generateDisclosureReceipt(
        "org_789", 
        "proof_123",
        {
          userId: "user_456",
          purpose: "Test",
          approvalTimestamp: new Date(),
        },
        {},
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects receipt generation for expired proof", async () => {
    const proof = createProof({
      expiresAt: new Date(Date.now() - 3600000), // -1 hour
    });
    prisma.proof.findFirst.mockResolvedValue(proof);

    await expect(
      service.generateDisclosureReceipt(
        "org_789",
        "proof_123",
        {
          userId: "user_456", 
          purpose: "Test",
          approvalTimestamp: new Date(),
        },
        {},
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("uses proof expiry as default receipt expiry", async () => {
    const proof = createProof({
      expiresAt: new Date("2024-06-01T00:00:00Z"),
    });
    const signingKey = createSigningKey();

    prisma.proof.findFirst.mockResolvedValue(proof);
    prisma.signingKey.findFirst.mockResolvedValue(signingKey);
    prisma.disclosureReceipt.create.mockResolvedValue(createDisclosureReceipt());

    const result = await service.generateDisclosureReceipt(
      "org_789",
      "proof_123",
      {
        userId: "user_456",
        purpose: "Test", 
        approvalTimestamp: new Date("2024-01-15T10:30:00Z"),
      },
      {}, // No explicit expiry
    );

    expect(result.receipt.disclosure.expiresAt).toBe("2024-06-01T00:00:00.000Z");
  });

  it("respects explicit receipt expiry when provided", async () => {
    const proof = createProof();
    const signingKey = createSigningKey();
    const explicitExpiry = new Date("2024-03-01T00:00:00Z");

    prisma.proof.findFirst.mockResolvedValue(proof);
    prisma.signingKey.findFirst.mockResolvedValue(signingKey);
    prisma.disclosureReceipt.create.mockResolvedValue(createDisclosureReceipt());

    const result = await service.generateDisclosureReceipt(
      "org_789",
      "proof_123",
      {
        userId: "user_456",
        purpose: "Test",
        approvalTimestamp: new Date("2024-01-15T10:30:00Z"),
      },
      { expiresAt: explicitExpiry },
    );

    expect(result.receipt.disclosure.expiresAt).toBe(explicitExpiry.toISOString());
  });

  it("canonicalizes receipt payload before signing", async () => {
    const proof = createProof();
    const signingKey = createSigningKey();

    prisma.proof.findFirst.mockResolvedValue(proof);
    prisma.signingKey.findFirst.mockResolvedValue(signingKey);
    prisma.disclosureReceipt.create.mockResolvedValue(createDisclosureReceipt());

    await service.generateDisclosureReceipt(
      "org_789",
      "proof_123",
      {
        userId: "user_456",
        purpose: "Test",
        approvalTimestamp: new Date("2024-01-15T10:30:00Z"),
      },
      {},
    );

    expect(canonicalization.canonicalizeObject).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "1.0",
        organizationId: "org_789",
        proofId: "proof_123",
      }),
    );

    const canonicalizedPayload = canonicalization.canonicalizeObject.mock.calls[0][0];
    expect(signing.signCredential).toHaveBeenCalledWith(
      JSON.stringify(canonicalizedPayload, Object.keys(canonicalizedPayload).sort()),
      signingKey.id,
    );
  });

  it("stores receipt hash for audit trail", async () => {
    const proof = createProof();
    const signingKey = createSigningKey();

    prisma.proof.findFirst.mockResolvedValue(proof);
    prisma.signingKey.findFirst.mockResolvedValue(signingKey);
    prisma.disclosureReceipt.create.mockResolvedValue(createDisclosureReceipt());

    await service.generateDisclosureReceipt(
      "org_789",
      "proof_123",
      {
        userId: "user_456",
        purpose: "Test",
        approvalTimestamp: new Date("2024-01-15T10:30:00Z"),
      },
      {},
    );

    expect(prisma.disclosureReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        receiptHash: expect.stringMatching(/^[a-f0-9]{64}$/), // SHA-256 hash
        signatureKeyId: signingKey.id,
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// ReceiptService.verifyDisclosureReceipt  
// ---------------------------------------------------------------------------

describe("ReceiptService.verifyDisclosureReceipt", () => {
  let service: ReceiptService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let canonicalization: ReturnType<typeof makeCanonicalizationMock>;
  let signing: ReturnType<typeof makeSigningMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    canonicalization = makeCanonicalizationMock();
    signing = makeSigningMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReceiptService,
        { provide: PrismaService, useValue: prisma },
        { provide: CanonicalizationService, useValue: canonicalization },
        { provide: SigningService, useValue: signing },
      ],
    }).compile();

    service = module.get<ReceiptService>(ReceiptService);
  });

  it("verifies valid receipt signature", async () => {
    const receiptPayload = {
      version: "1.0",
      organizationId: "org_789", 
      proofId: "proof_123",
      proofType: "EMPLOYMENT_VERIFICATION",
      requester: {
        userId: "user_456",
        purpose: "Employment verification",
      },
      disclosure: {
        approvedAt: "2024-01-15T10:30:00.000Z",
        policyVersion: "privacy-policy-v2.1",
        expiresAt: "2024-02-15T10:30:00.000Z",
      },
      issuedAt: "2024-01-15T10:30:00.000Z",
    };

    const signature = {
      algorithm: "EdDSA" as const,
      keyId: "credential-key-0",
      signature: "ed25519:valid_signature",
      credentialHash: "sha256_hash",
    };

    const signingKey = createSigningKey();
    prisma.signingKey.findFirst.mockResolvedValue(signingKey);
    signing.verifyCredentialSignature.mockResolvedValue({ isValid: true });

    const result = await service.verifyDisclosureReceipt(
      receiptPayload,
      signature,
    );

    expect(result.isValid).toBe(true);
    expect(result.status).toBe("valid");
    expect(result.verifiedAt).toBeInstanceOf(Date);
    expect(result.expiresAt).toEqual(new Date("2024-02-15T10:30:00.000Z"));

    expect(signing.verifyCredentialSignature).toHaveBeenCalledWith(
      expect.any(String), // canonicalized payload
      signature.signature,
      signingKey,
    );
  });

  it("rejects receipt with unknown signing key", async () => {
    const receiptPayload = {
      version: "1.0",
      organizationId: "org_789",
      proofId: "proof_123", 
      proofType: "EMPLOYMENT_VERIFICATION",
      requester: { userId: "user_456", purpose: "Test" },
      disclosure: {
        approvedAt: "2024-01-15T10:30:00.000Z",
        policyVersion: "privacy-policy-v2.1", 
        expiresAt: "2024-02-15T10:30:00.000Z",
      },
      issuedAt: "2024-01-15T10:30:00.000Z",
    };

    const signature = {
      algorithm: "EdDSA" as const,
      keyId: "unknown-key",
      signature: "ed25519:signature",
      credentialHash: "hash",
    };

    prisma.signingKey.findFirst.mockResolvedValue(null);

    const result = await service.verifyDisclosureReceipt(
      receiptPayload,
      signature,
    );

    expect(result.isValid).toBe(false);
    expect(result.status).toBe("unknown_key");
    expect(signing.verifyCredentialSignature).not.toHaveBeenCalled();
  });

  it("rejects receipt with invalid signature", async () => {
    const receiptPayload = {
      version: "1.0",
      organizationId: "org_789",
      proofId: "proof_123",
      proofType: "EMPLOYMENT_VERIFICATION", 
      requester: { userId: "user_456", purpose: "Test" },
      disclosure: {
        approvedAt: "2024-01-15T10:30:00.000Z",
        policyVersion: "privacy-policy-v2.1",
        expiresAt: "2024-02-15T10:30:00.000Z",
      },
      issuedAt: "2024-01-15T10:30:00.000Z",
    };

    const signature = {
      algorithm: "EdDSA" as const,
      keyId: "credential-key-0",
      signature: "ed25519:invalid_signature",
      credentialHash: "hash",
    };

    const signingKey = createSigningKey();
    prisma.signingKey.findFirst.mockResolvedValue(signingKey);
    signing.verifyCredentialSignature.mockResolvedValue({ isValid: false });

    const result = await service.verifyDisclosureReceipt(
      receiptPayload,
      signature,
    );

    expect(result.isValid).toBe(false);
    expect(result.status).toBe("invalid_signature");
  });

  it("rejects expired receipt", async () => {
    const receiptPayload = {
      version: "1.0", 
      organizationId: "org_789",
      proofId: "proof_123",
      proofType: "EMPLOYMENT_VERIFICATION",
      requester: { userId: "user_456", purpose: "Test" },
      disclosure: {
        approvedAt: "2024-01-15T10:30:00.000Z",
        policyVersion: "privacy-policy-v2.1",
        expiresAt: new Date(Date.now() - 3600000).toISOString(), // -1 hour
      },
      issuedAt: "2024-01-15T10:30:00.000Z",
    };

    const signature = {
      algorithm: "EdDSA" as const,
      keyId: "credential-key-0", 
      signature: "ed25519:signature",
      credentialHash: "hash",
    };

    const signingKey = createSigningKey();
    prisma.signingKey.findFirst.mockResolvedValue(signingKey);
    signing.verifyCredentialSignature.mockResolvedValue({ isValid: true });

    const result = await service.verifyDisclosureReceipt(
      receiptPayload,
      signature,
    );

    expect(result.isValid).toBe(false);
    expect(result.status).toBe("expired");
  });

  it("handles malformed receipt gracefully", async () => {
    const malformedPayload = {
      version: "1.0",
      // Missing required fields
    } as any;

    const signature = {
      algorithm: "EdDSA" as const,
      keyId: "credential-key-0",
      signature: "ed25519:signature", 
      credentialHash: "hash",
    };

    const result = await service.verifyDisclosureReceipt(
      malformedPayload,
      signature,
    );

    expect(result.isValid).toBe(false);
    expect(result.status).toBe("malformed");
  });
});

// ---------------------------------------------------------------------------
// ReceiptService.getOwnerReceipts
// ---------------------------------------------------------------------------

describe("ReceiptService.getOwnerReceipts", () => {
  let service: ReceiptService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReceiptService,
        { provide: PrismaService, useValue: prisma },
        { provide: CanonicalizationService, useValue: makeCanonicalizationMock() },
        { provide: SigningService, useValue: makeSigningMock() },
      ],
    }).compile();

    service = module.get<ReceiptService>(ReceiptService);
  });

  it("returns receipts for user-owned proofs", async () => {
    const receipts = [
      createDisclosureReceipt({ id: "receipt_1", proofId: "proof_1" }),
      createDisclosureReceipt({ id: "receipt_2", proofId: "proof_2" }),
    ];

    prisma.disclosureReceipt.findMany.mockResolvedValue(receipts);

    const result = await service.getOwnerReceipts("user_456", "org_789", {});

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("receipt_1");
    expect(result[1].id).toBe("receipt_2");

    expect(prisma.disclosureReceipt.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org_789",
        proof: { userId: "user_456" },
      },
      orderBy: { issuedAt: "desc" },
      take: 50,
    });
  });

  it("filters by proof ID when specified", async () => {
    prisma.disclosureReceipt.findMany.mockResolvedValue([]);

    await service.getOwnerReceipts("user_456", "org_789", {
      proofId: "proof_123",
    });

    expect(prisma.disclosureReceipt.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org_789",
        proof: { userId: "user_456" },
        proofId: "proof_123",
      },
      orderBy: { issuedAt: "desc" },
      take: 50,
    });
  });

  it("excludes expired receipts by default", async () => {
    prisma.disclosureReceipt.findMany.mockResolvedValue([]);

    await service.getOwnerReceipts("user_456", "org_789", {});

    expect(prisma.disclosureReceipt.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org_789", 
        proof: { userId: "user_456" },
        expiresAt: { gt: expect.any(Date) },
      },
      orderBy: { issuedAt: "desc" },
      take: 50,
    });
  });

  it("includes expired receipts when requested", async () => {
    prisma.disclosureReceipt.findMany.mockResolvedValue([]);

    await service.getOwnerReceipts("user_456", "org_789", {
      includeExpired: true,
    });

    const whereClause = prisma.disclosureReceipt.findMany.mock.calls[0][0].where;
    expect(whereClause.expiresAt).toBeUndefined();
  });

  it("applies limit parameter", async () => {
    prisma.disclosureReceipt.findMany.mockResolvedValue([]);

    await service.getOwnerReceipts("user_456", "org_789", { limit: 25 });

    expect(prisma.disclosureReceipt.findMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      orderBy: { issuedAt: "desc" },
      take: 25,
    });
  });
});

// ---------------------------------------------------------------------------
// ReceiptService.cleanupExpiredReceipts
// ---------------------------------------------------------------------------

describe("ReceiptService.cleanupExpiredReceipts", () => {
  let service: ReceiptService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReceiptService,
        { provide: PrismaService, useValue: prisma },
        { provide: CanonicalizationService, useValue: makeCanonicalizationMock() },
        { provide: SigningService, useValue: makeSigningMock() },
      ],
    }).compile();

    service = module.get<ReceiptService>(ReceiptService);
  });

  it("deletes expired receipts and returns count", async () => {
    prisma.disclosureReceipt.deleteMany.mockResolvedValue({ count: 12 });

    const result = await service.cleanupExpiredReceipts();

    expect(result.deletedCount).toBe(12);
    expect(prisma.disclosureReceipt.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: expect.any(Date) },
      },
    });

    const cutoffDate = prisma.disclosureReceipt.deleteMany.mock.calls[0][0].where.expiresAt.lte;
    expect(cutoffDate.getTime()).toBeCloseTo(Date.now(), -3); // Within 1 second
  });

  it("handles cleanup when no expired receipts exist", async () => {
    prisma.disclosureReceipt.deleteMany.mockResolvedValue({ count: 0 });

    const result = await service.cleanupExpiredReceipts();

    expect(result.deletedCount).toBe(0);
  });
});