import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  AttestationType,
  PaymentClassification,
  ProofType,
  ResourceStatus,
  VerificationResult,
} from "@prisma/client";
import { sha256 } from "../common/crypto/hash";
import { ApiErrorCode } from "../common/dto/api-error.dto";
import { AttestationsService } from "../attestations/attestations.service";
import { EMPLOYER_PAYMENT_POLICY_VERSION } from "./employer-payment.policy";
import { ProofsService } from "./proofs.service";

describe("ProofsService employer-payment proofs", () => {
  const user = {
    id: "user_1",
    walletAddress: "GB_OWNER",
    walletHash: "sha256:owner",
    role: "WORKER",
  };
  const ISSUER_ACCOUNT = "GISSUER_ACCOUNT";
  const PAYROLL_ACCOUNT = "GPAYROLL_ACCOUNT";
  const periodStart = "2026-08-01T00:00:00.000Z";
  const periodEnd = "2026-09-01T00:00:00.000Z";
  const baseInput = {
    trustedSourceId: "ts_1",
    assetCode: "USDC",
    assetIssuer: "GASSET_ISSUER",
    periodStart,
    periodEnd,
  };
  const payments = [
    {
      id: "pay_old",
      operationId: "op-1000",
      occurredAt: new Date("2026-08-02T00:00:00.000Z"),
    },
    {
      id: "pay_new",
      operationId: "op-2000",
      occurredAt: new Date("2026-08-25T00:00:00.000Z"),
    },
  ];
  const config = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        credentialSigningSecret: "test-signing-secret",
        paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "stellar.network": "testnet",
      };
      return values[key];
    }),
  };

  type Scenario = {
    sourceAddress?: string;
    source?: Record<string, unknown> | null;
    issuerStatus?: ResourceStatus;
    organizationStatus?: ResourceStatus;
    addressOwnerId?: string | null;
    candidates?: typeof payments;
    attestations?: Array<{ id: string; paymentReferenceHash: string }>;
    lockedSource?: Record<string, unknown> | undefined;
    lockedAttestation?: Record<string, unknown> | undefined;
    lockedPayment?: Record<string, unknown> | undefined;
  };

  function harness(scenario: Scenario = {}) {
    const sourceAddress = scenario.sourceAddress ?? ISSUER_ACCOUNT;
    const source =
      scenario.source === null
        ? null
        : {
            id: "ts_1",
            sourceAddress,
            status: ResourceStatus.ACTIVE,
            issuerId: "issuer_1",
            issuer: {
              id: "issuer_1",
              status: scenario.issuerStatus ?? ResourceStatus.ACTIVE,
              stellarAddress: ISSUER_ACCOUNT,
              organization: {
                status: scenario.organizationStatus ?? ResourceStatus.ACTIVE,
              },
            },
            ...scenario.source,
          };
    let storedProof: any;
    const queries: string[] = [];
    const prisma: any = {
      trustedSource: { findFirst: jest.fn().mockResolvedValue(source) },
      issuer: {
        findUnique: jest.fn().mockResolvedValue(
          scenario.addressOwnerId === undefined
            ? sourceAddress === ISSUER_ACCOUNT
              ? { id: "issuer_1" }
              : null
            : scenario.addressOwnerId === null
              ? null
              : { id: scenario.addressOwnerId },
        ),
      },
      payment: {
        findMany: jest.fn().mockResolvedValue(scenario.candidates ?? payments),
      },
      attestation: {
        findMany: jest.fn().mockResolvedValue(scenario.attestations ?? []),
      },
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join("?");
        queries.push(sql);
        if (sql.includes('FROM "TrustedSource"')) {
          return "lockedSource" in scenario
            ? scenario.lockedSource
              ? [scenario.lockedSource]
              : []
            : [
                {
                  sourceStatus: ResourceStatus.ACTIVE,
                  sourceAddress,
                  issuerId: "issuer_1",
                  issuerStatus: ResourceStatus.ACTIVE,
                  organizationStatus: ResourceStatus.ACTIVE,
                },
              ];
        }
        if (sql.includes('FROM "Attestation"')) {
          return "lockedAttestation" in scenario
            ? scenario.lockedAttestation
              ? [scenario.lockedAttestation]
              : []
            : [{ status: ResourceStatus.ACTIVE, revokedAt: null, expiresAt: null }];
        }
        if (sql.includes('FROM "Payment"')) {
          return "lockedPayment" in scenario
            ? scenario.lockedPayment
              ? [scenario.lockedPayment]
              : []
            : [{ classification: PaymentClassification.INCOME, isEligible: true }];
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      proof: {
        create: jest.fn().mockImplementation(({ data }) => {
          storedProof = {
            ...data,
            updatedAt: data.createdAt,
            contractTransactionHash: null,
            revokedAt: null,
            user: { walletHash: user.walletHash },
            claim: {
              id: "claim_1",
              proofId: data.id,
              createdAt: data.createdAt,
              frequency: null,
              thresholdEncrypted: null,
              ...data.claim.create,
            },
          };
          return storedProof;
        }),
        findUnique: jest.fn().mockImplementation(() => storedProof),
      },
      verificationEvent: { create: jest.fn().mockResolvedValue({}) },
      anchoringIntent: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction = jest.fn(async (callback) => callback(prisma));
    const service = new ProofsService(
      prisma as never,
      { ...config, get: jest.fn().mockReturnValue(false) } as never,
      { recordEvent: jest.fn().mockResolvedValue(undefined) } as never,
      {
        getValidAttestationsForSubject: jest.fn().mockResolvedValue([]),
      } as unknown as AttestationsService,
    );
    return {
      service,
      prisma,
      queries,
      getStoredProof: () => storedProof,
      setStoredProof: (proof: any) => {
        storedProof = proof;
      },
    };
  }

  async function expectCode(promise: Promise<unknown>, type: any, code: string) {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(type);
    expect((error as any).getResponse()).toMatchObject({ code });
  }

  beforeAll(() => {
    // Only the clock is faked: timers keep running so nothing is left pending.
    jest.useFakeTimers({
      now: new Date("2026-09-15T00:00:00.000Z"),
      doNotFake: [
        "nextTick",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  describe("positive issuance", () => {
    it("issues a minimal credential from the issuer's own account", async () => {
      const { service, prisma, getStoredProof } = harness();

      const result = await service.createEmployerPaymentProof(user, baseInput);

      expect(result.credential).toMatchObject({
        type: "EarnProofEmployerPaymentCredential",
        schemaVersion: "earnproof.employer-payment.v1",
        claim: {
          employerIssuerId: "issuer_1",
          corroboration: "issuer_account",
          assetCode: "USDC",
          assetIssuer: "GASSET_ISSUER",
          periodStart,
          periodEnd,
          periodBoundary: "start-inclusive-end-exclusive",
          paymentObserved: true,
          policyVersion: EMPLOYER_PAYMENT_POLICY_VERSION,
        },
        privacy: {
          amountHidden: true,
          senderHidden: true,
          memoHidden: true,
          sourceTransactionsHidden: true,
        },
      });
      expect(getStoredProof()).toMatchObject({
        proofType: ProofType.EMPLOYER_PAYMENT,
        userId: user.id,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
      });
      expect(prisma.attestation.findMany).not.toHaveBeenCalled();
    });

    it("never discloses raw transaction, memo, sender or amount data", async () => {
      const { service, getStoredProof } = harness();

      const result = await service.createEmployerPaymentProof(user, baseInput);
      const response = JSON.stringify(result);
      const stored = JSON.stringify(getStoredProof());

      for (const payment of payments) {
        expect(response).not.toContain(payment.operationId);
        expect(response).not.toContain(payment.occurredAt.toISOString());
        expect(stored).not.toContain(payment.operationId);
      }
      expect(response).not.toContain(ISSUER_ACCOUNT);
      expect(result.credential.claim).not.toHaveProperty("amount");
      expect(result.credential.claim).not.toHaveProperty("memo");
      expect(getStoredProof().claim.disclosurePolicy.paymentReferenceDigest).toMatch(
        /^hmac-sha256:/,
      );
    });

    it("accepts a payroll account corroborated by an issuer PAYMENT attestation", async () => {
      const reference = `sha256:${sha256("op-1000")}`;
      const { service, prisma, queries } = harness({
        sourceAddress: PAYROLL_ACCOUNT,
        attestations: [{ id: "att_1", paymentReferenceHash: reference }],
      });

      const result = await service.createEmployerPaymentProof(user, baseInput);

      expect(result.credential.claim.corroboration).toBe("issuer_attestation");
      expect(prisma.attestation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            issuerId: "issuer_1",
            subjectWalletHash: user.walletHash,
            type: AttestationType.PAYMENT,
            status: ResourceStatus.ACTIVE,
            revokedAt: null,
          }),
        }),
      );
      expect(queries.some((sql) => sql.includes('FROM "Attestation"'))).toBe(
        true,
      );
    });

    it("queries only the caller's eligible income in the half-open period", async () => {
      const { service, prisma } = harness();

      await service.createEmployerPaymentProof(user, baseInput);

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: user.id,
            sourceAddress: ISSUER_ACCOUNT,
            assetCode: "USDC",
            assetIssuer: "GASSET_ISSUER",
            classification: PaymentClassification.INCOME,
            isEligible: true,
            occurredAt: { gte: new Date(periodStart), lt: new Date(periodEnd) },
          },
          orderBy: [{ occurredAt: "desc" }, { operationId: "asc" }],
        }),
      );
    });
  });

  describe("deterministic claim selection", () => {
    it("stores the same payment digest regardless of row order", async () => {
      const first = harness({ candidates: payments });
      const second = harness({ candidates: [...payments].reverse() });

      const a = await first.service.createEmployerPaymentProof(user, baseInput);
      const b = await second.service.createEmployerPaymentProof(user, baseInput);

      expect(
        first.getStoredProof().claim.disclosurePolicy.paymentReferenceDigest,
      ).toBe(
        second.getStoredProof().claim.disclosurePolicy.paymentReferenceDigest,
      );
      expect(a.credential.claim).toEqual(b.credential.claim);
    });

    it("locks the most recent corroborated payment", async () => {
      const { service, prisma } = harness({ candidates: [...payments].reverse() });

      await service.createEmployerPaymentProof(user, baseInput);

      const paymentLock = prisma.$queryRaw.mock.calls.find(
        ([strings]: [TemplateStringsArray]) =>
          strings.join("?").includes('FROM "Payment"'),
      );
      expect(paymentLock.slice(1)).toContain("pay_new");
    });
  });

  describe("untrusted and ambiguous sources", () => {
    it("refuses a source that is not linked to an issuer", async () => {
      const { service, prisma } = harness({
        source: { issuerId: null, issuer: null },
      });

      await expectCode(
        service.createEmployerPaymentProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });

    it.each([
      ["revoked issuer", { issuerStatus: ResourceStatus.REVOKED }],
      ["pending issuer", { issuerStatus: ResourceStatus.PENDING }],
      ["suspended organization", { organizationStatus: ResourceStatus.SUSPENDED }],
      ["revoked trusted source", { source: { status: ResourceStatus.REVOKED } }],
      ["deleted trusted source", { source: { status: ResourceStatus.DELETED } }],
    ])("refuses a %s", async (_label, scenario) => {
      const { service, prisma } = harness(scenario as Scenario);

      await expectCode(
        service.createEmployerPaymentProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
      );
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });

    it("refuses an address registered to a different issuer as ambiguous", async () => {
      const { service, prisma } = harness({
        sourceAddress: PAYROLL_ACCOUNT,
        addressOwnerId: "issuer_other",
      });

      await expectCode(
        service.createEmployerPaymentProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_SOURCE_AMBIGUOUS,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });

    it("refuses a self-linked payroll address without an issuer attestation (false match)", async () => {
      const { service, prisma } = harness({
        sourceAddress: PAYROLL_ACCOUNT,
        attestations: [],
      });

      await expectCode(
        service.createEmployerPaymentProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });

    it("ignores an attestation that references a different payment (false match)", async () => {
      const { service } = harness({
        sourceAddress: PAYROLL_ACCOUNT,
        attestations: [
          { id: "att_x", paymentReferenceHash: `sha256:${sha256("op-other")}` },
        ],
      });

      await expectCode(
        service.createEmployerPaymentProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
      );
    });

    it("error messages never echo addresses or identifiers", async () => {
      const { service } = harness({
        sourceAddress: PAYROLL_ACCOUNT,
        addressOwnerId: "issuer_other",
      });

      const error = await service
        .createEmployerPaymentProof(user, baseInput)
        .catch((caught: unknown) => caught);
      const body = JSON.stringify((error as any).getResponse());
      expect(body).not.toContain(PAYROLL_ACCOUNT);
      expect(body).not.toContain("issuer_other");
      expect(body).not.toContain("issuer_1");
    });
  });

  describe("authorization", () => {
    it("returns not-found for a source owned by another user", async () => {
      const { service, prisma } = harness({ source: null });

      await expectCode(
        service.createEmployerPaymentProof(user, {
          ...baseInput,
          trustedSourceId: "ts_someone_else",
        }),
        NotFoundException,
        ApiErrorCode.NOT_FOUND,
      );
      expect(prisma.trustedSource.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ts_someone_else", userId: user.id },
        }),
      );
    });
  });

  describe("period boundaries", () => {
    it("refuses when no eligible payment falls inside the period", async () => {
      const { service, prisma } = harness({ candidates: [] });

      await expectCode(
        service.createEmployerPaymentProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_PAYMENT_NOT_FOUND,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });

    it.each([
      ["inverted", { periodStart: periodEnd, periodEnd: periodStart }],
      ["empty", { periodStart, periodEnd: periodStart }],
      [
        "longer than 366 days",
        { periodStart: "2025-08-01T00:00:00.000Z", periodEnd },
      ],
      [
        "ending in the future",
        { periodStart, periodEnd: "2026-09-15T00:00:00.001Z" },
      ],
    ])("rejects a period that is %s before touching the database", async (_label, period) => {
      const { service, prisma } = harness();

      await expectCode(
        service.createEmployerPaymentProof(user, { ...baseInput, ...period }),
        BadRequestException,
        ApiErrorCode.INVALID_INPUT,
      );
      expect(prisma.trustedSource.findFirst).not.toHaveBeenCalled();
    });

    it("accepts a period ending exactly now", async () => {
      const { service } = harness();

      await expect(
        service.createEmployerPaymentProof(user, {
          ...baseInput,
          periodEnd: "2026-09-15T00:00:00.000Z",
        }),
      ).resolves.toMatchObject({ status: "ACTIVE" });
    });
  });

  describe("transactional revocation", () => {
    it("refuses when the issuer is revoked between selection and commit", async () => {
      const { service, prisma } = harness({
        lockedSource: {
          sourceStatus: ResourceStatus.ACTIVE,
          sourceAddress: ISSUER_ACCOUNT,
          issuerId: "issuer_1",
          issuerStatus: ResourceStatus.REVOKED,
          organizationStatus: ResourceStatus.ACTIVE,
        },
      });

      await expectCode(
        service.createEmployerPaymentProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });

    it("refuses when the trusted source is deleted or relinked before commit", async () => {
      for (const lockedSource of [
        undefined,
        {
          sourceStatus: ResourceStatus.DELETED,
          sourceAddress: ISSUER_ACCOUNT,
          issuerId: "issuer_1",
          issuerStatus: ResourceStatus.ACTIVE,
          organizationStatus: ResourceStatus.ACTIVE,
        },
        {
          sourceStatus: ResourceStatus.ACTIVE,
          sourceAddress: ISSUER_ACCOUNT,
          issuerId: "issuer_2",
          issuerStatus: ResourceStatus.ACTIVE,
          organizationStatus: ResourceStatus.ACTIVE,
        },
      ]) {
        const { service, prisma } = harness({ lockedSource });
        await expectCode(
          service.createEmployerPaymentProof(user, baseInput),
          UnprocessableEntityException,
          ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
        );
        expect(prisma.proof.create).not.toHaveBeenCalled();
      }
    });

    it("refuses when the corroborating attestation is revoked before commit", async () => {
      const { service, prisma } = harness({
        sourceAddress: PAYROLL_ACCOUNT,
        attestations: [
          { id: "att_1", paymentReferenceHash: `sha256:${sha256("op-2000")}` },
        ],
        lockedAttestation: {
          status: ResourceStatus.REVOKED,
          revokedAt: new Date(),
          expiresAt: null,
        },
      });

      await expectCode(
        service.createEmployerPaymentProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });

    it("refuses when the selected payment is reclassified before commit", async () => {
      const { service, prisma } = harness({
        lockedPayment: {
          classification: PaymentClassification.EXCLUDED,
          isEligible: true,
        },
      });

      await expectCode(
        service.createEmployerPaymentProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_PAYMENT_NOT_FOUND,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });

    it("takes row locks on source, issuer and organization inside the transaction", async () => {
      const { service, queries } = harness();

      await service.createEmployerPaymentProof(user, baseInput);

      const sourceLock = queries.find((sql) => sql.includes('FROM "TrustedSource"'));
      expect(sourceLock).toMatch(/FOR SHARE OF ts, i, o/);
    });
  });

  describe("verification", () => {
    it("verifies an issued employer-payment proof as valid", async () => {
      const { service } = harness();
      const issued = await service.createEmployerPaymentProof(user, baseInput);

      const verified = await service.verifyProof(issued.proofId);

      expect(verified.result).toBe(VerificationResult.VALID);
      expect(verified.credential).toMatchObject({
        type: "EarnProofEmployerPaymentCredential",
        claim: issued.credential.claim,
      });
    });

    it("reports a tampered employer identity as an invalid signature", async () => {
      const { service, getStoredProof, setStoredProof } = harness();
      const issued = await service.createEmployerPaymentProof(user, baseInput);
      const stored = getStoredProof();
      setStoredProof({
        ...stored,
        claim: {
          ...stored.claim,
          disclosurePolicy: {
            ...stored.claim.disclosurePolicy,
            employerIssuerId: "issuer_forged",
          },
        },
      });

      const verified = await service.verifyProof(issued.proofId);

      expect(verified.result).toBe(VerificationResult.INVALID_SIGNATURE);
    });
  });
});
