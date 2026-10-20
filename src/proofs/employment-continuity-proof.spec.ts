import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  PaymentClassification,
  ProofType,
  ResourceStatus,
  VerificationResult,
} from "@prisma/client";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { ApiErrorCode } from "../common/dto/api-error.dto";
import { AttestationsService } from "../attestations/attestations.service";
import {
  EMPLOYMENT_CONTINUITY_POLICY_VERSION,
  MAX_CONTINUITY_PAYMENTS,
} from "./employment-continuity.policy";
import { ProofsService } from "./proofs.service";

describe("ProofsService employment-continuity proofs", () => {
  const user = {
    id: "user_1",
    walletAddress: "GB_OWNER",
    walletHash: "sha256:owner",
    role: "WORKER",
  };
  const ISSUER_ACCOUNT = "GISSUER_ACCOUNT";
  const PAYROLL_ACCOUNT = "GPAYROLL_ACCOUNT";
  const baseInput = {
    trustedSourceId: "ts_1",
    assetCode: "USDC",
    periodStart: "2026-01-01T00:00:00.000Z",
    observedPeriods: 6,
  };
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

  type Row = { id: string; operationId: string; occurredAt: Date };

  /** One payment on the 15th of each listed month (1-based) of 2026. */
  function monthly(months: number[]): Row[] {
    return months.map((month) => ({
      id: `pay_${month}`,
      operationId: `op-${month}`,
      occurredAt: new Date(
        `2026-${String(month).padStart(2, "0")}-15T12:00:00.000Z`,
      ),
    }));
  }

  const reference = (row: { operationId: string }) =>
    `sha256:${sha256(row.operationId)}`;

  type Scenario = {
    sourceAddress?: string;
    source?: Record<string, unknown> | null;
    issuerStatus?: ResourceStatus;
    rows?: Row[];
    attestations?: Array<{ id: string; paymentReferenceHash: string }>;
    lockedSource?: Record<string, unknown>;
    /** Payment ids that no longer qualify when re-read under lock. */
    disqualifiedPaymentIds?: string[];
    /** Attestation ids revoked by the time they are re-read under lock. */
    revokedAttestationIds?: string[];
  };

  function sqlIds(values: unknown[]): string[] {
    const joined = values.find(
      (value): value is { values: unknown[] } =>
        typeof value === "object" &&
        value !== null &&
        Array.isArray((value as { values?: unknown }).values),
    );
    return (joined?.values ?? []) as string[];
  }

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
              organization: { status: ResourceStatus.ACTIVE },
            },
            ...scenario.source,
          };
    let storedProof: any;
    const prisma: any = {
      trustedSource: { findFirst: jest.fn().mockResolvedValue(source) },
      issuer: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            sourceAddress === ISSUER_ACCOUNT ? { id: "issuer_1" } : null,
          ),
      },
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValue(scenario.rows ?? monthly([1, 2, 3, 4, 5, 6])),
      },
      attestation: {
        findMany: jest.fn().mockResolvedValue(scenario.attestations ?? []),
      },
      $queryRaw: jest.fn(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join("?");
          if (sql.includes('FROM "TrustedSource"')) {
            return [
              scenario.lockedSource ?? {
                sourceStatus: ResourceStatus.ACTIVE,
                sourceAddress,
                issuerId: "issuer_1",
                issuerStatus: ResourceStatus.ACTIVE,
                organizationStatus: ResourceStatus.ACTIVE,
              },
            ];
          }
          if (sql.includes('FROM "Payment"')) {
            return sqlIds(values).map((id) => ({
              id,
              classification: (scenario.disqualifiedPaymentIds ?? []).includes(id)
                ? PaymentClassification.EXCLUDED
                : PaymentClassification.INCOME,
              isEligible: true,
            }));
          }
          if (sql.includes('FROM "Attestation"')) {
            return sqlIds(values).map((id) => ({
              id,
              status: (scenario.revokedAttestationIds ?? []).includes(id)
                ? ResourceStatus.REVOKED
                : ResourceStatus.ACTIVE,
              revokedAt: (scenario.revokedAttestationIds ?? []).includes(id)
                ? new Date()
                : null,
              expiresAt: null,
            }));
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      ),
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
    prisma.$transaction = jest.fn(async (callback: any) => callback(prisma));
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
    it("commits only the continuity result and the policy it used", async () => {
      const { service, getStoredProof } = harness();

      const result = await service.createEmploymentContinuityProof(user, baseInput);

      expect(result.credential).toMatchObject({
        type: "EarnProofEmploymentContinuityCredential",
        schemaVersion: "earnproof.employment-continuity.v1",
        claim: {
          employerIssuerId: "issuer_1",
          assetCode: "USDC",
          assetIssuer: null,
          periodStart: "2026-01-01T00:00:00.000Z",
          periodEnd: "2026-07-01T00:00:00.000Z",
          periodUnit: "calendar-month-utc",
          observedPeriods: 6,
          toleratedMissingPeriods: 1,
          continuous: true,
          policyVersion: EMPLOYMENT_CONTINUITY_POLICY_VERSION,
        },
      });
      expect(Object.keys(result.credential.claim).sort()).toEqual(
        [
          "assetCode",
          "assetIssuer",
          "continuous",
          "employerIssuerId",
          "observedPeriods",
          "periodEnd",
          "periodStart",
          "periodUnit",
          "policyVersion",
          "toleratedMissingPeriods",
        ].sort(),
      );
      expect(getStoredProof()).toMatchObject({
        proofType: ProofType.EMPLOYMENT_CONTINUITY,
        periodStart: new Date("2026-01-01T00:00:00.000Z"),
        periodEnd: new Date("2026-07-01T00:00:00.000Z"),
      });
    });

    it("never discloses payment dates, identifiers or sender", async () => {
      const rows = monthly([1, 2, 3, 4, 5, 6]);
      const { service, getStoredProof } = harness({ rows });

      const result = await service.createEmploymentContinuityProof(user, baseInput);
      const response = JSON.stringify(result);
      const stored = JSON.stringify(getStoredProof());

      for (const row of rows) {
        expect(response).not.toContain(row.operationId);
        expect(response).not.toContain(row.occurredAt.toISOString());
        expect(stored).not.toContain(row.operationId);
      }
      expect(response).not.toContain(ISSUER_ACCOUNT);
      expect(response).not.toMatch(/coveredPeriods|missingPeriods/);
    });

    it("tolerates one missing middle month", async () => {
      const { service } = harness({ rows: monthly([1, 2, 3, 5, 6]) });

      await expect(
        service.createEmploymentContinuityProof(user, baseInput),
      ).resolves.toMatchObject({ status: "ACTIVE" });
    });

    it("queries one source, one asset and the half-open window only", async () => {
      const { service, prisma } = harness();

      await service.createEmploymentContinuityProof(user, baseInput);

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: user.id,
            sourceAddress: ISSUER_ACCOUNT,
            assetCode: "USDC",
            assetIssuer: null,
            classification: PaymentClassification.INCOME,
            isEligible: true,
            occurredAt: {
              gte: new Date("2026-01-01T00:00:00.000Z"),
              lt: new Date("2026-07-01T00:00:00.000Z"),
            },
          },
          take: MAX_CONTINUITY_PAYMENTS + 1,
        }),
      );
    });
  });

  describe("gaps and duplicates", () => {
    it.each([
      ["two missing months", [1, 3, 5, 6]],
      ["missing first month", [2, 3, 4, 5, 6]],
      ["missing last month", [1, 2, 3, 4, 5]],
    ])("refuses %s", async (_label, months) => {
      const { service, prisma } = harness({ rows: monthly(months) });

      await expectCode(
        service.createEmploymentContinuityProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.CONTINUITY_NOT_SATISFIED,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });

    it("does not let duplicate rows fill a gap", async () => {
      const rows = [
        ...monthly([1, 2, 3, 6]),
        // Replayed operation ids with shifted timestamps must not cover
        // April or May.
        { id: "pay_dup_a", operationId: "op-3", occurredAt: new Date("2026-04-02T00:00:00.000Z") },
        { id: "pay_dup_b", operationId: "op-3", occurredAt: new Date("2026-05-02T00:00:00.000Z") },
      ];
      const { service } = harness({ rows });

      await expectCode(
        service.createEmploymentContinuityProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.CONTINUITY_NOT_SATISFIED,
      );
    });

    it("refuses instead of truncating when the window holds too many payments", async () => {
      const rows = Array.from({ length: MAX_CONTINUITY_PAYMENTS + 1 }, (_, index) => ({
        id: `pay_${index}`,
        operationId: `op-${index}`,
        occurredAt: new Date("2026-03-01T00:00:00.000Z"),
      }));
      const { service } = harness({ rows });

      await expectCode(
        service.createEmploymentContinuityProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.CONTINUITY_LIMIT_EXCEEDED,
      );
    });
  });

  describe("timezone and window boundaries", () => {
    it("counts a payment at 00:00:00.000Z on the 1st in the new month", async () => {
      const rows = monthly([1, 2, 3, 4, 6]).concat({
        // Exactly the first instant of May fills May, not April.
        id: "pay_may",
        operationId: "op-may",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      });
      const { service } = harness({
        rows: rows.filter((row) => row.operationId !== "op-4"),
      });

      // January, February, March, May, June covered; April missing.
      await expect(
        service.createEmploymentContinuityProof(user, baseInput),
      ).resolves.toMatchObject({ status: "ACTIVE" });
    });

    it("counts a payment one millisecond before midnight UTC in the old month", async () => {
      const rows = [
        ...monthly([1, 2, 3, 4, 5]),
        // 23:59:59.999Z on 30 June is June even though it is 1 July in UTC+2.
        { id: "pay_june", operationId: "op-june", occurredAt: new Date("2026-06-30T23:59:59.999Z") },
      ];
      const { service } = harness({ rows });

      await expect(
        service.createEmploymentContinuityProof(user, baseInput),
      ).resolves.toMatchObject({ status: "ACTIVE" });
    });

    it.each([
      ["a local-time month start", { periodStart: "2026-01-01T00:00:00+01:00" }],
      ["a mid-month start", { periodStart: "2026-01-15T00:00:00.000Z" }],
      ["an unfinished window", { periodStart: "2026-04-01T00:00:00.000Z" }],
      ["too short an observation", { observedPeriods: 2 }],
      ["too long an observation", { observedPeriods: 25 }],
    ])("rejects %s before touching the database", async (_label, patch) => {
      const { service, prisma } = harness();

      await expectCode(
        service.createEmploymentContinuityProof(user, { ...baseInput, ...patch }),
        BadRequestException,
        ApiErrorCode.INVALID_INPUT,
      );
      expect(prisma.trustedSource.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("trusted employer source", () => {
    it("returns not-found for another user's source", async () => {
      const { service, prisma } = harness({ source: null });

      await expectCode(
        service.createEmploymentContinuityProof(user, baseInput),
        NotFoundException,
        ApiErrorCode.NOT_FOUND,
      );
      expect(prisma.trustedSource.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "ts_1", userId: user.id } }),
      );
    });

    it("refuses a source whose issuer is revoked", async () => {
      const { service, prisma } = harness({ issuerStatus: ResourceStatus.REVOKED });

      await expectCode(
        service.createEmploymentContinuityProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
      );
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });

    it("counts only attested payments from a payroll address", async () => {
      const rows = monthly([1, 2, 3, 4, 5, 6]);
      const { service } = harness({
        sourceAddress: PAYROLL_ACCOUNT,
        // Two months lack an attestation, so the source does not vouch for
        // them and the window has two gaps.
        attestations: rows
          .filter((row) => !["op-3", "op-4"].includes(row.operationId))
          .map((row) => ({ id: `att_${row.operationId}`, paymentReferenceHash: reference(row) })),
      });

      await expectCode(
        service.createEmploymentContinuityProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.CONTINUITY_NOT_SATISFIED,
      );
    });

    it("issues from a payroll address when every counted payment is attested", async () => {
      const rows = monthly([1, 2, 3, 4, 5, 6]);
      const { service } = harness({
        sourceAddress: PAYROLL_ACCOUNT,
        attestations: rows.map((row) => ({
          id: `att_${row.operationId}`,
          paymentReferenceHash: reference(row),
        })),
      });

      await expect(
        service.createEmploymentContinuityProof(user, baseInput),
      ).resolves.toMatchObject({ status: "ACTIVE" });
    });
  });

  describe("source changes during issuance", () => {
    it("refuses when the source is relinked to another issuer before commit", async () => {
      const { service, prisma } = harness({
        lockedSource: {
          sourceStatus: ResourceStatus.ACTIVE,
          sourceAddress: ISSUER_ACCOUNT,
          issuerId: "issuer_2",
          issuerStatus: ResourceStatus.ACTIVE,
          organizationStatus: ResourceStatus.ACTIVE,
        },
      });

      await expectCode(
        service.createEmploymentContinuityProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });

    it("refuses when the issuer is revoked before commit", async () => {
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
        service.createEmploymentContinuityProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });

    it("re-evaluates on locked rows: one attestation revoked still leaves one tolerated gap", async () => {
      const rows = monthly([1, 2, 3, 4, 5, 6]);
      const { service, prisma } = harness({
        sourceAddress: PAYROLL_ACCOUNT,
        attestations: rows.map((row) => ({
          id: `att_${row.operationId}`,
          paymentReferenceHash: reference(row),
        })),
        revokedAttestationIds: ["att_op-3"],
      });

      await expect(
        service.createEmploymentContinuityProof(user, baseInput),
      ).resolves.toMatchObject({ status: "ACTIVE" });
      expect(prisma.proof.create).toHaveBeenCalled();
    });

    it("refuses when revocations at lock time open a second gap", async () => {
      const rows = monthly([1, 2, 3, 4, 5, 6]);
      const { service, prisma } = harness({
        sourceAddress: PAYROLL_ACCOUNT,
        attestations: rows.map((row) => ({
          id: `att_${row.operationId}`,
          paymentReferenceHash: reference(row),
        })),
        revokedAttestationIds: ["att_op-3", "att_op-4"],
      });

      await expectCode(
        service.createEmploymentContinuityProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.CONTINUITY_NOT_SATISFIED,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });

    it("refuses when a reclassified payment uncovers the last month", async () => {
      const { service, prisma } = harness({ disqualifiedPaymentIds: ["pay_6"] });

      await expectCode(
        service.createEmploymentContinuityProof(user, baseInput),
        UnprocessableEntityException,
        ApiErrorCode.CONTINUITY_NOT_SATISFIED,
      );
      expect(prisma.proof.create).not.toHaveBeenCalled();
    });
  });

  describe("verification and policy versioning", () => {
    it("verifies an issued proof as valid", async () => {
      const { service } = harness();
      const issued = await service.createEmploymentContinuityProof(user, baseInput);

      const verified = await service.verifyProof(issued.proofId);

      expect(verified.result).toBe(VerificationResult.VALID);
      expect(verified.credential).toMatchObject({ claim: issued.credential.claim });
    });

    it("keeps the meaning of a proof issued under an older policy", async () => {
      // Simulate a proof issued under a different, earlier policy: its stored
      // parameters differ from today's constants. Verification must rebuild it
      // from what was stored, not re-interpret it under the current policy.
      const { service, getStoredProof, setStoredProof } = harness();
      const issued = await service.createEmploymentContinuityProof(user, baseInput);
      const stored = getStoredProof();
      const unsigned = { ...(issued.credential as any) };
      delete unsigned.proof;
      const legacy = {
        ...unsigned,
        claim: {
          ...unsigned.claim,
          toleratedMissingPeriods: 2,
          policyVersion: "earnproof.employment-continuity.policy.v0",
        },
      };
      setStoredProof({
        ...stored,
        credentialHash: `sha256:${sha256(canonicalize(legacy))}`,
        claim: {
          ...stored.claim,
          disclosurePolicy: {
            ...stored.claim.disclosurePolicy,
            toleratedMissingPeriods: 2,
            policyVersion: "earnproof.employment-continuity.policy.v0",
          },
        },
      });

      const verified = await service.verifyProof(issued.proofId);

      expect(verified.result).toBe(VerificationResult.VALID);
      expect(verified.credential).toMatchObject({
        claim: {
          toleratedMissingPeriods: 2,
          policyVersion: "earnproof.employment-continuity.policy.v0",
        },
      });
    });

    it("reports a tampered policy parameter as an invalid signature", async () => {
      const { service, getStoredProof, setStoredProof } = harness();
      const issued = await service.createEmploymentContinuityProof(user, baseInput);
      const stored = getStoredProof();
      setStoredProof({
        ...stored,
        claim: {
          ...stored.claim,
          disclosurePolicy: { ...stored.claim.disclosurePolicy, observedPeriods: 12 },
        },
      });

      const verified = await service.verifyProof(issued.proofId);

      expect(verified.result).toBe(VerificationResult.INVALID_SIGNATURE);
    });
  });
});
