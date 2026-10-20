import {
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PaymentClassification, ProofType, VerificationResult } from "@prisma/client";
import { AttestationsService } from "../attestations/attestations.service";
import { ApiErrorCode } from "../common/dto/api-error.dto";
import { CreateAggregateEarningsProofDto } from "./dto/create-aggregate-earnings-proof.dto";
import { ProofsService } from "./proofs.service";

/**
 * Aggregate-earnings issuance through the shared proof pipeline: owner-scoped
 * selection, persistence, signing, public verification and tamper detection.
 */

const OWNER = {
  id: "user_owner",
  walletAddress: "GB_OWNER",
  walletHash: "sha256:owner",
  role: "WORKER",
};

const USDC_ISSUER = "GB_ASSET_ISSUER";

type StoredPayment = {
  id: string;
  userId: string;
  operationId: string;
  sourceAddress: string;
  assetCode: string;
  assetIssuer: string | null;
  amountEncrypted: string | null;
  classification: PaymentClassification;
  isEligible: boolean;
  occurredAt: Date;
};

function protect(amount: string) {
  return `redacted:${Buffer.from(amount).toString("base64url")}`;
}

function payment(id: string, amount: string, overrides: Partial<StoredPayment> = {}): StoredPayment {
  return {
    id,
    userId: OWNER.id,
    operationId: `op-${id}`,
    sourceAddress: "GB_SECRET_EMPLOYER",
    assetCode: "USDC",
    assetIssuer: USDC_ISSUER,
    amountEncrypted: protect(amount),
    classification: PaymentClassification.INCOME,
    isEligible: true,
    occurredAt: new Date("2026-03-15T12:00:00.000Z"),
    ...overrides,
  };
}

function matchesPayment(row: StoredPayment, where: Record<string, any>) {
  return (
    row.userId === where.userId &&
    row.classification === where.classification &&
    row.isEligible === where.isEligible &&
    row.assetCode === where.assetCode &&
    row.assetIssuer === where.assetIssuer &&
    row.occurredAt >= where.occurredAt.gte &&
    row.occurredAt < where.occurredAt.lt &&
    (!where.sourceAddress || where.sourceAddress.in.includes(row.sourceAddress))
  );
}

function harness(payments: StoredPayment[], options: { anchoring?: boolean } = {}) {
  const proofs = new Map<string, any>();
  const prisma: any = {
    payment: {
      findMany: jest.fn(async ({ where, take }) =>
        payments.filter((row) => matchesPayment(row, where)).slice(0, take),
      ),
    },
    trustedSource: { findMany: jest.fn().mockResolvedValue([]) },
    issuer: { findMany: jest.fn().mockResolvedValue([]) },
    proof: {
      create: jest.fn(async ({ data }) => {
        const stored = {
          ...data,
          updatedAt: data.createdAt,
          contractTransactionHash: null,
          revokedAt: null,
          user: { walletHash: OWNER.walletHash },
          claim: { id: "claim_1", proofId: data.id, createdAt: data.createdAt, frequency: null, ...data.claim.create },
        };
        proofs.set(data.id, stored);
        return stored;
      }),
      findUnique: jest.fn(async ({ where }) => proofs.get(where.id) ?? null),
    },
    anchoringIntent: { create: jest.fn().mockResolvedValue({}) },
    verificationEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  prisma.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma));

  const CONFIG_VALUES: Record<string, unknown> = {
    credentialSigningSecret: "test-signing-secret",
    paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    "stellar.network": "testnet",
    "contractAnchoring.enabled": Boolean(options.anchoring),
    "contractAnchoring.required": false,
  };
  const config = {
    get: jest.fn((key: string) => CONFIG_VALUES[key] ?? false),
    getOrThrow: jest.fn((key: string) => {
      if (key in CONFIG_VALUES) return CONFIG_VALUES[key];
      throw new Error(`Config key not found: ${key}`);
    }),
  };
  const events = { recordEvent: jest.fn().mockResolvedValue(undefined), getAggregateStats: jest.fn() };
  const attestations = {
    getValidAttestationsForSubject: jest.fn().mockResolvedValue([]),
  } as unknown as AttestationsService;

  const service = new ProofsService(prisma as never, config as never, events as never, attestations);
  return { service, prisma, proofs };
}

function request(overrides: Partial<CreateAggregateEarningsProofDto> = {}): CreateAggregateEarningsProofDto {
  return {
    assets: [{ code: "USDC", issuer: USDC_ISSUER }],
    periodStart: "2026-03-01T00:00:00.000Z",
    periodEnd: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ProofsService aggregate-earnings proofs", () => {
  it("issues a credential that commits only the floored aggregate and policy", async () => {
    const { service, prisma } = harness([
      payment("p1", "1200.7500000"),
      payment("p2", "899.9999999"),
    ]);

    const created = await service.createAggregateEarningsProof(OWNER, request({ roundingIncrement: "100" }));

    expect(created.credential).toMatchObject({
      type: "EarnProofAggregateEarningsCredential",
      schemaVersion: "earnproof.aggregate-earnings.v1",
      subject: { walletHash: OWNER.walletHash },
      claim: {
        operator: "sum",
        aggregateAmount: "2100.0000000",
        rounding: { mode: "floor", increment: "100" },
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
        periodStart: "2026-03-01T00:00:00.000Z",
        periodEnd: "2026-04-01T00:00:00.000Z",
        periodBoundary: "start-inclusive-end-exclusive",
        sourceScope: "income",
        qualifyingPaymentCount: 2,
        policyVersion: "earnproof.aggregate-earnings.policy.v1",
      },
      privacy: { exactIncomeHidden: true, sourceTransactionsHidden: true, sourceIdentitiesHidden: true },
    });

    const serialized = JSON.stringify(created);
    for (const secret of ["op-p1", "op-p2", "p1\"", "GB_SECRET_EMPLOYER", "1200.75", "899.99", "2100.7499999"]) {
      expect(serialized).not.toContain(secret);
    }

    const [{ data }] = prisma.proof.create.mock.calls[0];
    expect(data).toMatchObject({
      proofType: ProofType.AGGREGATE_EARNINGS,
      schemaVersion: "earnproof.aggregate-earnings.v1",
      claim: {
        create: {
          operator: "sum",
          disclosurePolicy: expect.objectContaining({
            policyVersion: "earnproof.aggregate-earnings.policy.v1",
            roundingIncrement: "100",
            sourceScope: "income",
            qualifyingPaymentCount: 2,
            inputsDigest: expect.stringMatching(/^hmac-sha256:/),
          }),
        },
      },
    });
    expect(JSON.stringify(data)).not.toContain("GB_SECRET_EMPLOYER");
  });

  it("only aggregates the caller's own payments", async () => {
    const { service, prisma } = harness([
      payment("p1", "10"),
      payment("p2", "20"),
      payment("stranger", "1000000", { userId: "user_other" }),
    ]);

    const created = await service.createAggregateEarningsProof(OWNER, request());

    expect(created.credential.claim).toMatchObject({ aggregateAmount: "30.0000000", qualifyingPaymentCount: 2 });
    expect(prisma.payment.findMany.mock.calls[0][0].where.userId).toBe(OWNER.id);
  });

  it("excludes non-income, ineligible, other-asset and out-of-period payments", async () => {
    const { service } = harness([
      payment("p1", "10"),
      payment("p2", "20"),
      payment("reimb", "500", { classification: PaymentClassification.REIMBURSEMENT }),
      payment("inelig", "500", { isEligible: false }),
      payment("xlm", "500", { assetCode: "XLM", assetIssuer: null }),
      payment("at-end", "500", { occurredAt: new Date("2026-04-01T00:00:00.000Z") }),
    ]);

    const created = await service.createAggregateEarningsProof(OWNER, request());

    expect(created.credential.claim).toMatchObject({ aggregateAmount: "30.0000000", qualifyingPaymentCount: 2 });
  });

  it("verifies publicly and detects tampering with the committed aggregate or policy", async () => {
    const { service, proofs } = harness([payment("p1", "10"), payment("p2", "20")]);
    const created = await service.createAggregateEarningsProof(OWNER, request());

    const verified = await service.verifyProof(created.proofId);
    expect(verified.result).toBe(VerificationResult.VALID);
    expect(verified.credential).toEqual(created.credential);

    const stored = proofs.get(created.proofId);
    stored.claim.thresholdEncrypted = protect("31.0000000");
    expect((await service.verifyProof(created.proofId)).result).toBe(VerificationResult.INVALID_SIGNATURE);

    stored.claim.thresholdEncrypted = protect("30.0000000");
    stored.claim.disclosurePolicy = { ...stored.claim.disclosurePolicy, roundingIncrement: "1000" };
    expect((await service.verifyProof(created.proofId)).result).toBe(VerificationResult.INVALID_SIGNATURE);

    stored.claim.disclosurePolicy = { ...stored.claim.disclosurePolicy, roundingIncrement: "bogus" };
    expect((await service.verifyProof(created.proofId)).result).toBe(VerificationResult.INVALID_SIGNATURE);
  });

  it("enqueues anchoring through the shared pipeline when enabled", async () => {
    const { service, prisma } = harness([payment("p1", "10"), payment("p2", "20")], { anchoring: true });

    const created = await service.createAggregateEarningsProof(OWNER, request());

    expect(created.anchoring).toEqual({ anchored: false, reason: "pending" });
    expect(prisma.anchoringIntent.create).toHaveBeenCalledWith({
      data: { proofId: created.proofId, operation: "REGISTER", status: "PENDING" },
    });
  });

  it.each([
    [
      "cross-asset aggregation",
      request({ assets: [{ code: "USDC", issuer: USDC_ISSUER }, { code: "XLM" }] }),
      UnprocessableEntityException,
      ApiErrorCode.AGGREGATION_CROSS_ASSET_UNSUPPORTED,
    ],
    [
      "a future period",
      request({ periodEnd: "2999-01-01T00:00:00.000Z" }),
      BadRequestException,
      ApiErrorCode.INVALID_INPUT,
    ],
    [
      "issuerIds outside the verified_issuers scope",
      request({ issuerIds: ["iss_1"] }),
      BadRequestException,
      ApiErrorCode.INVALID_INPUT,
    ],
  ])("refuses %s with a stable code", async (_label, input, type, code) => {
    const { service, prisma } = harness([payment("p1", "10"), payment("p2", "20")]);

    const error = await service.createAggregateEarningsProof(OWNER, input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(type);
    expect((error as { response: { code: string } }).response.code).toBe(code);
    expect(prisma.proof.create).not.toHaveBeenCalled();
  });

  it("refuses a single-payment aggregate", async () => {
    const { service, prisma } = harness([payment("p1", "10")]);

    await expect(service.createAggregateEarningsProof(OWNER, request())).rejects.toMatchObject({
      response: { code: ApiErrorCode.AGGREGATION_INSUFFICIENT_PAYMENTS },
    });
    expect(prisma.proof.create).not.toHaveBeenCalled();
  });

  it("refuses an aggregate with an unreadable amount without revealing it", async () => {
    const { service } = harness([payment("p1", "10"), payment("p2", "20", { amountEncrypted: "enc:v9:corrupt" })]);

    const error = await service.createAggregateEarningsProof(OWNER, request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as { response: { code: string } }).response.code).toBe(ApiErrorCode.PAYMENT_NOT_ELIGIBLE);
    expect(JSON.stringify((error as { response: unknown }).response)).not.toContain("corrupt");
  });
});
