import { ProofStatus } from "@prisma/client";
import { createHmac } from "crypto";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { CredentialsService } from "./credentials.service";

const SIGNING_SECRET = "test-signing-secret";
const config = {
  getOrThrow: jest.fn(() => SIGNING_SECRET),
};

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
    privacy: {
      exactIncomeHidden: true as const,
      sourceTransactionsHidden: true as const,
    },
    issuedAt: "2026-08-02T00:00:00.000Z",
    expiresAt: "2027-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function signCredential(body: Record<string, unknown>, secret = SIGNING_SECRET) {
  const canonicalPayload = canonicalize(body);
  return {
    ...body,
    proof: {
      type: "HMAC-SHA256",
      credentialHash: `sha256:${sha256(canonicalPayload)}`,
      signature: `hmac-sha256:${createHmac("sha256", secret)
        .update(canonicalPayload)
        .digest("base64url")}`,
    },
  };
}

function credentialHashFor(body: Record<string, unknown>) {
  return `sha256:${sha256(canonicalize(body))}`;
}

/** Prisma mock keyed by credentialHash, returning an active future-dated row. */
function prismaWithHashes(hashes: string[]) {
  const rows = new Map(
    hashes.map((hash) => [
      hash,
      {
        id: `proof-${hash.slice(0, 8)}`,
        status: ProofStatus.ACTIVE,
        expiresAt: new Date("2027-09-02T00:00:00.000Z"),
        schemaVersion: "earnproof.minimum-income.v1",
        contractTransactionHash: null,
      },
    ]),
  );
  return {
    proof: {
      findUnique: jest.fn(({ where }: { where: { credentialHash: string } }) =>
        Promise.resolve(rows.get(where.credentialHash) ?? null),
      ),
    },
  };
}

describe("CredentialsService.verifyCredentialsBatch", () => {
  it("returns one ordered result per submitted credential (mixed outcomes)", async () => {
    const valid = signCredential(buildCredentialBody({ id: "valid" }));
    const tampered = {
      ...signCredential(buildCredentialBody({ id: "tampered" })),
      claim: { ...buildCredentialBody().claim, thresholdAmount: "9999" },
    };
    const unknown = signCredential(buildCredentialBody({ id: "unknown" }));

    // Only the valid credential's hash exists in the DB.
    const prisma = prismaWithHashes([
      credentialHashFor(buildCredentialBody({ id: "valid" })),
    ]);
    const service = new CredentialsService(prisma as never, config as never);

    const { results } = await service.verifyCredentialsBatch([
      valid,
      tampered,
      unknown,
    ]);

    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(results[0].result).toBe("valid");
    expect(results[1].result).toBe("invalid_signature");
    expect(results[2].result).toBe("unknown_anchor");
  });

  it("coalesces duplicate items into a single storage lookup", async () => {
    const body = buildCredentialBody({ id: "dup" });
    const signed = signCredential(body);
    const prisma = prismaWithHashes([credentialHashFor(body)]);
    const service = new CredentialsService(prisma as never, config as never);

    const { results } = await service.verifyCredentialsBatch([
      signed,
      signed,
      signed,
    ]);

    expect(results.map((r) => r.result)).toEqual(["valid", "valid", "valid"]);
    // Verified once despite three identical submissions.
    expect(prisma.proof.findUnique).toHaveBeenCalledTimes(1);
  });

  it("isolates a malformed (oversized) item without hiding the others", async () => {
    const good = signCredential(buildCredentialBody({ id: "good" }));
    const oversized = signCredential(
      buildCredentialBody({ id: "big", note: "x".repeat(40 * 1024) }),
    );
    const prisma = prismaWithHashes([
      credentialHashFor(buildCredentialBody({ id: "good" })),
    ]);
    const service = new CredentialsService(prisma as never, config as never);

    const { results } = await service.verifyCredentialsBatch([good, oversized]);

    expect(results[0].result).toBe("valid");
    expect(results[1].result).toBeUndefined();
    expect(results[1].error).toContain("32 KB");
  });

  it("reports a credential signed with a rotated-out key as invalid_signature", async () => {
    const body = buildCredentialBody({ id: "old-key" });
    const oldKeySigned = signCredential(body, "previous-secret");
    const prisma = prismaWithHashes([]);
    const service = new CredentialsService(prisma as never, config as never);

    const { results } = await service.verifyCredentialsBatch([oldKeySigned]);
    expect(results[0].result).toBe("invalid_signature");
  });
});
