import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ProofStatus, ProofType } from "@prisma/client";
import { ProofsService } from "./proofs.service";
import { unlimitedQuotas } from "../testing/quotas";
import { AttestationsService } from "../attestations/attestations.service";
import { encodeCursor } from "../common/pagination/cursor";

describe("ProofsService proof history", () => {
  const config = {
    get: jest.fn().mockReturnValue(false),
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        credentialSigningSecret: "test-signing-secret",
        paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "stellar.network": "testnet",
      };
      return values[key];
    }),
  };
  const events = {
    recordEvent: jest.fn(),
    getAggregateStats: jest.fn(),
  };
  const mockAttestationsService = {
    getValidAttestationsForSubject: jest.fn().mockResolvedValue([]),
  } as unknown as AttestationsService;
  const user = {
    id: "user_1",
    walletAddress: "GB_OWNER",
    walletHash: "sha256:owner",
    role: "WORKER",
  };

  const proof = (overrides: Record<string, unknown> = {}) => ({
    id: "proof_1",
    userId: "user_1",
    proofType: ProofType.MINIMUM_INCOME,
    schemaVersion: "earnproof.minimum-income.v1",
    status: ProofStatus.ACTIVE,
    network: "testnet",
    assetCode: "USDC",
    assetIssuer: "GB_ISSUER",
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    periodEnd: new Date("2026-07-31T23:59:59.000Z"),
    expiresAt: new Date("2099-08-31T00:00:00.000Z"),
    commitment: "sha256:commitment",
    credentialHash: "sha256:credential",
    contractTransactionHash: null,
    revokedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  });

  it("scopes filters and cursor pagination to the authenticated owner", async () => {
    const rows = [proof(), proof({ id: "proof_2" }), proof({ id: "proof_3" })];
    const prisma = {
      proof: {
        findMany: jest.fn().mockResolvedValue(rows),
      },
    };
    const service = new ProofsService(
      prisma as never,
      config as never,
      events as never,
      unlimitedQuotas() as never,
      mockAttestationsService,
    );
    const cursor = encodeCursor(
      new Date("2026-07-31T00:00:00.000Z"),
      "cursor_1",
    );

    const result = await service.listProofs("user_1", {
      cursor,
      limit: 2,
      type: ProofType.MINIMUM_INCOME,
      status: ProofStatus.ACTIVE,
      assetCode: "USDC",
      issuedFrom: "2026-08-01T00:00:00.000Z",
      issuedTo: "2026-08-31T23:59:59.000Z",
    });

    expect(prisma.proof.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user_1",
          proofType: ProofType.MINIMUM_INCOME,
          status: ProofStatus.ACTIVE,
          assetCode: "USDC",
          OR: [
            { createdAt: { lt: new Date("2026-07-31T00:00:00.000Z") } },
            {
              createdAt: new Date("2026-07-31T00:00:00.000Z"),
              id: { lt: "cursor_1" },
            },
          ],
        }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 3,
      }),
    );
    expect(result.data).toHaveLength(2);
    expect(result.pageInfo.hasMore).toBe(true);
    expect(result.pageInfo.nextCursor).toBe(
      encodeCursor(new Date("2026-08-01T00:00:00.000Z"), "proof_2"),
    );
  });

  it("rejects a malformed pagination cursor without querying the database", async () => {
    const prisma = { proof: { findMany: jest.fn() } };
    const service = new ProofsService(
      prisma as never,
      config as never,
      events as never,
      unlimitedQuotas() as never,
      mockAttestationsService,
    );

    await expect(
      service.listProofs("user_1", { cursor: "not-base64url-json", limit: 20 }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.proof.findMany).not.toHaveBeenCalled();
  });

  it("rejects a cursor with an unsupported version", async () => {
    const prisma = { proof: { findMany: jest.fn() } };
    const service = new ProofsService(
      prisma as never,
      config as never,
      events as never,
      mockAttestationsService,
    );
    const futureCursor = Buffer.from(
      JSON.stringify({ v: 999, k: new Date().toISOString(), id: "x" }),
    ).toString("base64url");

    await expect(
      service.listProofs("user_1", { cursor: futureCursor, limit: 20 }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.proof.findMany).not.toHaveBeenCalled();
  });

  it("returns the same not-found response for unknown and non-owned IDs", async () => {
    const prisma = { proof: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new ProofsService(
      prisma as never,
      config as never,
      events as never,
      unlimitedQuotas() as never,
      mockAttestationsService,
    );

    for (const id of ["unknown", "owned-by-someone-else"]) {
      await expect(service.getProofDetail(user, id)).rejects.toMatchObject({
        constructor: NotFoundException,
        response: {
          statusCode: 404,
          message: "Proof not found",
          error: "Not Found",
        },
      });
    }
    expect(prisma.proof.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: "unknown", userId: "user_1" },
      include: { claim: true },
    });
  });

  it("separates expiration and revocation from local status", async () => {
    const prisma = {
      proof: {
        findMany: jest.fn().mockResolvedValue([
          proof({ id: "expired", expiresAt: new Date("2020-01-01") }),
          proof({
            id: "revoked",
            status: ProofStatus.REVOKED,
            revokedAt: new Date("2026-08-02T00:00:00.000Z"),
          }),
        ]),
      },
    };
    const service = new ProofsService(
      prisma as never,
      config as never,
      events as never,
      unlimitedQuotas() as never,
      mockAttestationsService,
    );

    const result = await service.listProofs("user_1", { limit: 20 });

    expect(result.data[0]).toMatchObject({
      localStatus: ProofStatus.ACTIVE,
      credentialValidity: "expired",
      expired: true,
    });
    expect(result.data[1]).toMatchObject({
      localStatus: ProofStatus.REVOKED,
      credentialValidity: "revoked",
    });
  });

  it("returns a safe claim summary and checked anchoring state", async () => {
    const prisma = {
      proof: {
        findFirst: jest.fn().mockResolvedValue({
          ...proof({ contractTransactionHash: "stellar_tx" }),
          claim: {
            id: "claim_1",
            proofId: "proof_1",
            operator: "gte",
            thresholdEncrypted: "protected-exact-amount",
            frequency: null,
            result: true,
            disclosurePolicy: {
              qualifyingPaymentCount: 4,
              selectedPaymentIds: ["secret-payment-id"],
            },
            createdAt: new Date(),
          },
        }),
      },
    };
    const contract = {
      getProofStatus: jest
        .fn()
        .mockResolvedValue({ checked: true, revoked: false, valid: true }),
    };
    const service = new ProofsService(
      prisma as never,
      config as never,
      events as never,
      unlimitedQuotas() as never,
      mockAttestationsService,
      contract as never,
    );

    const result = await service.getProofDetail(user, "proof_1");
    const serialized = JSON.stringify(result);

    expect(result.claim).toEqual({
      operator: "gte",
      result: true,
      qualifyingPaymentCount: 4,
    });
    expect(result.anchoring).toMatchObject({
      anchored: true,
      status: "valid",
      checked: true,
    });
    expect(serialized).not.toContain("protected-exact-amount");
    expect(serialized).not.toContain("secret-payment-id");
    expect(serialized).not.toMatch(/memo/i);
  });
});
