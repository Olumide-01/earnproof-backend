import { BadRequestException } from "@nestjs/common";
import { ProofStatus } from "@prisma/client";
import { createHmac } from "crypto";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { CredentialsService } from "./credentials.service";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const SIGNING_SECRET = "test-signing-secret";
const FUTURE_EXPIRY = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

const config = {
  getOrThrow: jest.fn((key: string) => {
    const values: Record<string, string> = {
      credentialSigningSecret: SIGNING_SECRET,
    };
    return values[key];
  }),
};

/** Builds the unsigned credential body (matches ProofsService.buildCredential shape). */
function buildCredentialBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "proof_test_1",
    type: "EarnProofMinimumIncomeCredential",
    schemaVersion: "earnproof.minimum-income.v1",
    issuer: "earnproof-backend",
    subject: { walletHash: "sha256:abcdef" },
    claim: {
      operator: "gte",
      thresholdAmount: "100",
      assetCode: "XLM",
      assetIssuer: null,
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-31T23:59:59.000Z",
      qualifyingPaymentCount: 3,
    },
    privacy: { exactIncomeHidden: true as const, sourceTransactionsHidden: true as const },
    issuedAt: "2026-08-02T00:00:00.000Z",
    expiresAt: FUTURE_EXPIRY.toISOString(),
    ...overrides,
  };
}

/** Signs a credential body exactly as ProofsService.signCredential does. */
function signCredential(
  body: Record<string, unknown>,
  secret = SIGNING_SECRET,
  keyId?: string,
) {
  const canonicalPayload = canonicalize(body);
  return {
    ...body,
    proof: {
      type: "HMAC-SHA256",
      ...(keyId ? { keyId } : {}),
      credentialHash: `sha256:${sha256(canonicalPayload)}`,
      signature: `hmac-sha256:${createHmac("sha256", secret)
        .update(canonicalPayload)
        .digest("base64url")}`,
    },
  };
}

/** Computes the credentialHash that would be stored in the DB for a given body. */
function credentialHashFor(body: Record<string, unknown>) {
  return `sha256:${sha256(canonicalize(body))}`;
}

// ---------------------------------------------------------------------------
// Helper: build a minimal prisma mock that returns a given proof row
// ---------------------------------------------------------------------------
function mockPrismaWith(proofRow: object | null) {
  return {
    proof: {
      findUnique: jest.fn().mockResolvedValue(proofRow),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CredentialsService.verifyCredential", () => {
  // ---- 1. Valid credential → "valid" ----------------------------------------
  it("returns valid for a correctly signed, active, non-expired credential", async () => {
    const body = buildCredentialBody();
    const signed = signCredential(body);
    const hash = credentialHashFor(body);

    const prisma = mockPrismaWith({
      status: ProofStatus.ACTIVE,
      expiresAt: FUTURE_EXPIRY, // future
      schemaVersion: "earnproof.minimum-income.v1",
    });

    const service = new CredentialsService(prisma as never, config as never);
    await expect(service.verifyCredential(signed)).resolves.toEqual({
      result: "valid",
    });
    expect(prisma.proof.findUnique).toHaveBeenCalledWith({
      where: { credentialHash: hash },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        schemaVersion: true,
        contractTransactionHash: true,
      },
    });
  });

  // ---- 2. Tampered field → "invalid_signature" --------------------------------
  it("returns invalid_signature when a claim field has been tampered with", async () => {
    const body = buildCredentialBody();
    const signed = signCredential(body) as Record<string, unknown>;
    // Tamper the thresholdAmount after signing
    const tampered: Record<string, unknown> = {
      ...signed,
      claim: { ...(signed["claim"] as object), thresholdAmount: "9999" },
    };

    const prisma = mockPrismaWith(null); // DB lookup never reached
    const service = new CredentialsService(prisma as never, config as never);
    await expect(service.verifyCredential(tampered)).resolves.toEqual({
      result: "invalid_signature",
    });
    expect(prisma.proof.findUnique).not.toHaveBeenCalled();
  });

  // ---- 3. Tampered signature → "invalid_signature" ----------------------------
  it("returns invalid_signature when the signature value itself is altered", async () => {
    const body = buildCredentialBody();
    const signed = signCredential(body);
    const tampered = {
      ...signed,
      proof: { ...(signed.proof as object), signature: "hmac-sha256:invalidsig" },
    } as Record<string, unknown>;

    const prisma = mockPrismaWith(null);
    const service = new CredentialsService(prisma as never, config as never);
    await expect(service.verifyCredential(tampered)).resolves.toEqual({
      result: "invalid_signature",
    });
  });

  it("returns invalid_signature when the embedded credential hash is altered", async () => {
    const signed = signCredential(buildCredentialBody());
    signed.proof.credentialHash = `sha256:${"0".repeat(64)}`;

    const service = new CredentialsService(
      mockPrismaWith(null) as never,
      config as never,
    );
    await expect(service.verifyCredential(signed)).resolves.toEqual({
      result: "invalid_signature",
    });
  });

  it("rejects unsigned extra fields instead of silently stripping them", async () => {
    const signed = signCredential(buildCredentialBody()) as Record<
      string,
      unknown
    >;
    signed["injected"] = "not-signed";

    const service = new CredentialsService(
      mockPrismaWith(null) as never,
      config as never,
    );
    await expect(service.verifyCredential(signed)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("returns unsupported_key for an unknown signature scheme", async () => {
    const signed = signCredential(buildCredentialBody());
    signed.proof.type = "UNKNOWN";

    const service = new CredentialsService(
      mockPrismaWith(null) as never,
      config as never,
    );
    await expect(service.verifyCredential(signed)).resolves.toEqual({
      result: "unsupported_key",
    });
  });

  // ---- 4. Oversized payload → throws BadRequestException ----------------------
  it("throws BadRequestException when the payload exceeds 32 KB", async () => {
    const body = buildCredentialBody({
      // Pad claim with a large string to exceed the 32 KB limit
      _padding: "x".repeat(33 * 1024),
    });
    const signed = signCredential(body);

    const prisma = mockPrismaWith(null);
    const service = new CredentialsService(prisma as never, config as never);
    await expect(service.verifyCredential(signed)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.verifyCredential(signed)).rejects.toThrow(/32 KB/);
  });

  // ---- 5. Depth > 5 → throws BadRequestException ------------------------------
  it("throws BadRequestException when the payload nesting depth exceeds 5", async () => {
    // Build a 6-level-deep object: root → l1 → l2 → l3 → l4 → l5 → leaf
    const body = buildCredentialBody({
      nested: { a: { b: { c: { d: { e: "too deep" } } } } },
    });
    const signed = signCredential(body);

    const prisma = mockPrismaWith(null);
    const service = new CredentialsService(prisma as never, config as never);
    await expect(service.verifyCredential(signed)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.verifyCredential(signed)).rejects.toThrow(/nested deeper/);
  });

  // ---- 6. Wrong schemaVersion → "unsupported_schema" -------------------------
  it("returns unsupported_schema when schemaVersion does not match", async () => {
    const body = buildCredentialBody({ schemaVersion: "earnproof.other-proof.v99" });
    const signed = signCredential(body);

    const prisma = mockPrismaWith(null);
    const service = new CredentialsService(prisma as never, config as never);
    await expect(service.verifyCredential(signed)).resolves.toEqual({
      result: "unsupported_schema",
    });
    expect(prisma.proof.findUnique).not.toHaveBeenCalled();
  });

  // ---- 7. Expired credential (DB record expired) → "expired" ------------------
  it("returns expired when the proof record has passed its expiresAt", async () => {
    const body = buildCredentialBody();
    const signed = signCredential(body);

    const prisma = mockPrismaWith({
      status: ProofStatus.ACTIVE,
      expiresAt: new Date("2020-01-01T00:00:00.000Z"), // past date
      schemaVersion: "earnproof.minimum-income.v1",
    });

    const service = new CredentialsService(prisma as never, config as never);
    await expect(service.verifyCredential(signed)).resolves.toEqual({
      result: "expired",
    });
  });

  // ---- 8. Revoked credential → "revoked" -------------------------------------
  it("returns revoked when the proof record has REVOKED status", async () => {
    const body = buildCredentialBody();
    const signed = signCredential(body);

    const prisma = mockPrismaWith({
      status: ProofStatus.REVOKED,
      expiresAt: FUTURE_EXPIRY, // future
      schemaVersion: "earnproof.minimum-income.v1",
    });

    const service = new CredentialsService(prisma as never, config as never);
    await expect(service.verifyCredential(signed)).resolves.toEqual({
      result: "revoked",
    });
  });

  // ---- 9. Unknown anchor (no DB record) → "unknown_anchor" -------------------
  it("returns unknown_anchor when no proof record matches the credentialHash", async () => {
    const body = buildCredentialBody();
    const signed = signCredential(body);

    const prisma = mockPrismaWith(null);
    const service = new CredentialsService(prisma as never, config as never);
    await expect(service.verifyCredential(signed)).resolves.toEqual({
      result: "unknown_anchor",
    });
  });

  // ---- 10. Malformed shape (missing required fields) → throws BadRequestException
  it("throws BadRequestException when required credential fields are missing", async () => {
    // Missing claim, privacy, subject fields — passes size/depth/schema checks
    // but fails Zod shape validation
    const malformed: Record<string, unknown> = {
      id: "proof_bad",
      type: "EarnProofMinimumIncomeCredential",
      schemaVersion: "earnproof.minimum-income.v1",
      issuer: "earnproof-backend",
      // subject intentionally omitted
      // claim intentionally omitted
      issuedAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2027-09-02T00:00:00.000Z",
      proof: {
        type: "HMAC-SHA256",
        credentialHash: "sha256:dummy",
        signature: "hmac-sha256:dummy",
      },
    };

    const prisma = mockPrismaWith(null);
    const service = new CredentialsService(prisma as never, config as never);
    await expect(service.verifyCredential(malformed)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.verifyCredential(malformed)).rejects.toThrow(
      /malformed/,
    );
  });
});

describe("CredentialsService.verifyCredential — key rotation", () => {
  function rotatedConfig(overrides: Record<string, unknown> = {}) {
    return {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          "credentialSigningKeyVersions.0": "old-secret",
          "credentialSigningKeyVersions.1": "new-secret",
          credentialSigningKeyVersion: 1,
          ...overrides,
        };
        return values[key];
      }),
      getOrThrow: jest.fn(),
    };
  }

  it("verifies a credential signed with the new (active) key, addressed by its keyId", async () => {
    const body = buildCredentialBody();
    const signed = signCredential(body, "new-secret", "earnproof-v1");
    const prisma = mockPrismaWith({
      status: ProofStatus.ACTIVE,
      expiresAt: new Date("2027-09-02T00:00:00.000Z"),
      schemaVersion: "earnproof.minimum-income.v1",
    });

    const service = new CredentialsService(prisma as never, rotatedConfig() as never);
    await expect(service.verifyCredential(signed)).resolves.toEqual({ result: "valid" });
  });

  it("verifies a credential signed with the old (verify-only) key, addressed by its keyId", async () => {
    const body = buildCredentialBody();
    const signed = signCredential(body, "old-secret", "earnproof-v0");
    const prisma = mockPrismaWith({
      status: ProofStatus.ACTIVE,
      expiresAt: new Date("2027-09-02T00:00:00.000Z"),
      schemaVersion: "earnproof.minimum-income.v1",
    });

    const service = new CredentialsService(prisma as never, rotatedConfig() as never);
    await expect(service.verifyCredential(signed)).resolves.toEqual({ result: "valid" });
  });

  it("treats a credential with no keyId as signed by legacy version 0", async () => {
    const body = buildCredentialBody();
    const signed = signCredential(body, "old-secret"); // no keyId
    const prisma = mockPrismaWith({
      status: ProofStatus.ACTIVE,
      expiresAt: new Date("2027-09-02T00:00:00.000Z"),
      schemaVersion: "earnproof.minimum-income.v1",
    });

    const service = new CredentialsService(prisma as never, rotatedConfig() as never);
    await expect(service.verifyCredential(signed)).resolves.toEqual({ result: "valid" });
  });

  it("refuses a credential addressed to a retired key that is no longer loaded", async () => {
    const body = buildCredentialBody();
    // Signed as if by a v0 key that has since been retired (removed from config).
    const signed = signCredential(body, "retired-secret", "earnproof-v0");
    const prisma = mockPrismaWith(null);

    const service = new CredentialsService(
      prisma as never,
      rotatedConfig({ "credentialSigningKeyVersions.0": undefined }) as never,
    );

    await expect(service.verifyCredential(signed)).resolves.toEqual({
      result: "unsupported_key",
    });
  });

  it("refuses a credential addressed to a verify-only key past its overlap window (expired)", async () => {
    const body = buildCredentialBody();
    const signed = signCredential(body, "old-secret", "earnproof-v0");
    const prisma = mockPrismaWith(null);

    const past = new Date(Date.now() - 60_000).toISOString();
    const service = new CredentialsService(
      prisma as never,
      rotatedConfig({ "credentialSigningKeyVerifyUntil.0": past }) as never,
    );

    await expect(service.verifyCredential(signed)).resolves.toEqual({
      result: "unsupported_key",
    });
  });

  it("refuses a credential addressed to an unknown key id", async () => {
    const body = buildCredentialBody();
    const signed = signCredential(body, "new-secret", "earnproof-v99");
    const prisma = mockPrismaWith(null);

    const service = new CredentialsService(prisma as never, rotatedConfig() as never);

    await expect(service.verifyCredential(signed)).resolves.toEqual({
      result: "unsupported_key",
    });
  });

  it("refuses a credential whose keyId names a loaded key but whose signature does not match it", async () => {
    const body = buildCredentialBody();
    // Signed with the wrong secret for the claimed key id.
    const signed = signCredential(body, "wrong-secret", "earnproof-v1");
    const prisma = mockPrismaWith(null);

    const service = new CredentialsService(prisma as never, rotatedConfig() as never);

    await expect(service.verifyCredential(signed)).resolves.toEqual({
      result: "invalid_signature",
    });
  });
});
