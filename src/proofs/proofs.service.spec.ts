import {
  AnchoringOperation,
  AnchoringStatus,
  PaymentClassification,
  ProofStatus,
  ProofType,
  ResourceStatus,
  VerificationResult,
} from "@prisma/client";
import { sha256 } from "../common/crypto/hash";
import { ProofsService } from "./proofs.service";
import { VerificationEventService } from "../audit/verification-event.service";
import { unlimitedQuotas } from "../testing/quotas";
import { AttestationsService } from "../attestations/attestations.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortObject(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortObject(record[key]);
        return sorted;
      }, {});
  }

  return value;
}

/**
 * Config factory.
 * @param anchoringEnabled - CONTRACT_ANCHORING_ENABLED
 * @param anchoringRequired - CONTRACT_ANCHORING_REQUIRED
 */
function makeConfig(anchoringEnabled = false, anchoringRequired = false) {
  const values: Record<string, unknown> = {
    credentialSigningSecret: "test-signing-secret",
    paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    "stellar.network": "testnet",
    contractAnchoring: { enabled: anchoringEnabled, required: anchoringRequired },
    "contractAnchoring.enabled": anchoringEnabled,
    "contractAnchoring.required": anchoringRequired,
  };
  return {
    getOrThrow: jest.fn((key: string) => values[key]),
    get: jest.fn((key: string) => values[key]),
  };
}

const mockVerificationEventService = {
  recordEvent: jest.fn().mockResolvedValue(undefined),
  getAggregateStats: jest.fn().mockResolvedValue({}),
  cleanupExpiredEvents: jest.fn().mockResolvedValue(0),
} as unknown as VerificationEventService;

const mockAttestationsService = {
  getValidAttestationsForSubject: jest.fn().mockResolvedValue([]),
} as unknown as AttestationsService;

const user = {
  id: "user_1",
  walletAddress: "GB_TEST",
  walletHash: "sha256:wallet",
  role: "WORKER",
};

const config = makeConfig();

const singlePayment = [
  {
    id: "payment_1",
    assetCode: "XLM",
    assetIssuer: null,
    amountEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
    classification: PaymentClassification.INCOME,
    isEligible: true,
    occurredAt: new Date("2026-08-01T00:00:00.000Z"),
  },
];

const activeSupportedAsset = {
  id: "asset_1",
  assetKey: "testnet:native:XLM",
  code: "XLM",
  issuer: null,
  network: "testnet",
  status: ResourceStatus.ACTIVE,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function makeCreatePrisma(
  captureIntent?: (data: unknown) => void,
  supportedAsset: unknown = activeSupportedAsset,
) {
  return {
    payment: {
      findMany: jest.fn().mockResolvedValue(singlePayment),
    },
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        supportedAsset: {
          findFirst: jest.fn().mockResolvedValue(supportedAsset),
        },
        proof: {
          create: jest.fn().mockImplementation(({ data }) => ({
            id: data.id,
            userId: data.userId,
            proofType: data.proofType,
            schemaVersion: data.schemaVersion,
            status: data.status,
            network: data.network,
            assetCode: data.assetCode,
            assetIssuer: data.assetIssuer,
            assetPolicyId: data.assetPolicyId,
            assetPolicySnapshot: data.assetPolicySnapshot,
            periodStart: data.periodStart,
            periodEnd: data.periodEnd,
            expiresAt: data.expiresAt,
            credentialHash: data.credentialHash,
            commitment: data.commitment,
            createdAt: data.createdAt,
            claim: data.claim.create,
          })),
        },
        anchoringIntent: {
          create: jest.fn().mockImplementation(({ data }) => {
            captureIntent?.(data);
            return { id: "intent_1", ...data };
          }),
        },
      };
      return fn(tx);
    }),
  };
}

describe("ProofsService", () => {
  it("refuses a minimum-income proof over a payment held pending ledger reconciliation", async () => {
    const prisma = {
      payment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "payment_1",
            assetCode: "XLM",
            assetIssuer: null,
            amountEncrypted: `redacted:${Buffer.from("250").toString("base64url")}`,
            classification: PaymentClassification.INCOME,
            isEligible: true,
            finalityHoldAt: new Date("2026-08-02T00:00:00.000Z"),
            occurredAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        ]),
      },
      $transaction: jest.fn(),
    };
    const service = new ProofsService(prisma as never, config as never, mockVerificationEventService, mockAttestationsService);

    await expect(
      service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      }),
    ).rejects.toThrow("pending ledger reconciliation");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ finalityHoldAt: true }),
      }),
    );
  });

  it("rejects selected payments below the requested threshold", async () => {
    const prisma = {
      payment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "payment_1",
            assetCode: "XLM",
            assetIssuer: null,
            amountEncrypted: `redacted:${Buffer.from("25").toString("base64url")}`,
            classification: PaymentClassification.INCOME,
            isEligible: true,
            occurredAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        ]),
      },
      $transaction: jest.fn(),
    };
    const service = new ProofsService(prisma as never, config as never, mockVerificationEventService, unlimitedQuotas() as never, mockAttestationsService);

    await expect(
      service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      }),
    ).rejects.toThrow("minimum income threshold");
  });

  it("returns an unknown public verification state for missing proofs", async () => {
    (mockVerificationEventService.recordEvent as jest.Mock).mockClear();
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      verificationEventLog: {
        create: jest.fn().mockResolvedValue({ id: "event_1" }),
      },
    };
    const service = new ProofsService(prisma as never, config as never, mockVerificationEventService, unlimitedQuotas() as never, mockAttestationsService);

    await expect(service.verifyProof("missing")).resolves.toEqual({
      result: VerificationResult.UNKNOWN_PROOF,
      status: "unknown",
    });
    expect(mockVerificationEventService.recordEvent).not.toHaveBeenCalled();
  });

  it("returns a revoked public verification state", async () => {
    const credential = {
      id: "proof_1",
      type: "EarnProofMinimumIncomeCredential",
      schemaVersion: "earnproof.minimum-income.v1",
      issuer: "earnproof-backend",
      subject: { walletHash: "sha256:wallet" },
      claim: {
        operator: "gte",
        thresholdAmount: "100",
        assetCode: "XLM",
        assetIssuer: null,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
        qualifyingPaymentCount: 1,
      },
      privacy: { exactIncomeHidden: true, sourceTransactionsHidden: true },
      issuedAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2027-09-01T00:00:00.000Z",
    };
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue({
          id: "proof_1",
          proofType: ProofType.MINIMUM_INCOME,
          schemaVersion: "earnproof.minimum-income.v1",
          status: ProofStatus.REVOKED,
          network: "testnet",
          assetCode: "XLM",
          assetIssuer: null,
          periodStart: new Date("2026-08-01T00:00:00.000Z"),
          periodEnd: new Date("2026-08-31T23:59:59.000Z"),
          expiresAt: new Date("2027-09-01T00:00:00.000Z"),
          revokedAt: new Date("2026-08-03T00:00:00.000Z"),
          createdAt: new Date("2026-08-02T00:00:00.000Z"),
          credentialHash: `sha256:${sha256(canonicalize(credential))}`,
          contractTransactionHash: null,
          user: { walletHash: "sha256:wallet" },
          claim: {
            thresholdEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
            disclosurePolicy: { qualifyingPaymentCount: 1 },
          },
        }),
      },
      verificationEvent: {
        create: jest.fn().mockResolvedValue({ id: "event_1" }),
      },
    };
    const service = new ProofsService(prisma as never, config as never, mockVerificationEventService, unlimitedQuotas() as never, mockAttestationsService);

    const result = await service.verifyProof("proof_1");

    expect(JSON.stringify(result)).not.toMatch(/memo(Context)?/i);

    expect(result.result).toBe(VerificationResult.REVOKED);
    expect(result.status).toBe("revoked");
  });

  it("revokes anchored proofs by enqueuing REVOKE intent in same transaction", async () => {
    const capturedIntents: unknown[] = [];
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue({
          id: "proof_anchored",
          userId: "user_1",
          status: ProofStatus.ACTIVE,
          contractTransactionHash: "tx_register",
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          proof: {
            update: jest.fn().mockResolvedValue({
              id: "proof_anchored",
              status: ProofStatus.REVOKED,
              revokedAt: new Date("2026-08-04T00:00:00.000Z"),
              revokedByType: "OWNER",
              revocationReasonCode: "OWNER_REQUESTED",
              revocationReasonPrivate: null,
              revocationEvidenceHash: null,
            }),
          },
          auditLog: {
            create: jest.fn().mockResolvedValue({}),
          },
          anchoringIntent: {
            create: jest.fn().mockImplementation(({ data }) => {
              capturedIntents.push(data);
              return { id: "intent_revoke", ...data };
            }),
          },
        };
        return fn(tx);
      }),
    };
    const service = new ProofsService(
      prisma as never,
      makeConfig(true) as never, // anchoring enabled
      mockVerificationEventService,
      unlimitedQuotas() as never,
      mockAttestationsService,
    );

    const result = await service.revokeProof(user, "proof_anchored");

    expect(result.id).toBe("proof_anchored");
    expect(result.anchoring).toEqual({ anchored: false, reason: "pending" });
    // Revoke intent must have been created inside the transaction.
    expect(capturedIntents).toHaveLength(1);
    expect(capturedIntents[0]).toMatchObject({
      proofId: "proof_anchored",
      operation: AnchoringOperation.REVOKE,
      status: AnchoringStatus.PENDING,
    });
  });

  it("allows an administrator to revoke a proof owned by someone else", async () => {
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue({
          id: "proof_1",
          userId: "user_1",
          status: ProofStatus.ACTIVE,
          contractTransactionHash: null,
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          proof: {
            update: jest.fn().mockImplementation(({ data }) =>
              Promise.resolve({
                id: "proof_1",
                status: ProofStatus.REVOKED,
                revokedAt: new Date("2026-08-04T00:00:00.000Z"),
                revokedByType: data.revokedByType,
                revocationReasonCode: data.revocationReasonCode,
                revocationReasonPrivate: data.revocationReasonPrivate,
                revocationEvidenceHash: data.revocationEvidenceHash,
              }),
            ),
          },
          auditLog: { create: jest.fn().mockResolvedValue({}) },
          anchoringIntent: { create: jest.fn() },
        };
        return fn(tx);
      }),
    };
    const service = new ProofsService(
      prisma as never,
      config as never,
      mockVerificationEventService,
    );

    const admin = { ...user, id: "admin_1", role: "ADMIN" };
    const result = await service.revokeProof(admin, "proof_1", {
      reasonCode: "COMPLIANCE_HOLD",
    });

    expect(result.status).toBe(ProofStatus.REVOKED);
    expect(result.revokedByType).toBe("ADMIN");
    expect(result.revocationReasonCode).toBe("COMPLIANCE_HOLD");
  });

  it("refuses a non-owner, non-administrator revocation attempt", async () => {
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue({
          id: "proof_1",
          userId: "user_1",
          status: ProofStatus.ACTIVE,
          contractTransactionHash: null,
        }),
      },
      $transaction: jest.fn(),
    };
    const service = new ProofsService(
      prisma as never,
      config as never,
      mockVerificationEventService,
    );

    const stranger = { ...user, id: "user_2", role: "WORKER" };

    await expect(service.revokeProof(stranger, "proof_1")).rejects.toThrow(
      "Proof does not belong to this user",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("throws NotFoundException for a proof that does not exist", async () => {
    const prisma = {
      proof: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    };
    const service = new ProofsService(
      prisma as never,
      config as never,
      mockVerificationEventService,
    );

    await expect(service.revokeProof(user, "missing_proof")).rejects.toThrow(
      "Proof not found",
    );
  });

  it("is idempotent: a second revocation returns the original metadata unchanged and does not open a new transaction", async () => {
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue({
          id: "proof_1",
          userId: "user_1",
          status: ProofStatus.REVOKED,
          contractTransactionHash: null,
          revokedAt: new Date("2026-08-01T00:00:00.000Z"),
          revokedByType: "OWNER",
          revocationReasonCode: "DUPLICATE_PROOF",
          revocationReasonPrivate: "original note",
          revocationEvidenceHash: null,
        }),
      },
      $transaction: jest.fn(),
    };
    const service = new ProofsService(
      prisma as never,
      config as never,
      mockVerificationEventService,
    );

    const result = await service.revokeProof(user, "proof_1", {
      reasonCode: "FRAUD_SUSPECTED",
      reasonPrivate: "an attempt to overwrite the original reason",
    });

    expect(result.revocationReasonCode).toBe("DUPLICATE_PROOF");
    expect(result.revocationReasonPrivate).toBe("original note");
    expect(result.revokedAt).toBe("2026-08-01T00:00:00.000Z");
    // No write is attempted at all for an already-revoked proof.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not enqueue a REVOKE intent when the proof was never anchored", async () => {
    const capturedIntentCreate = jest.fn();
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue({
          id: "proof_1",
          userId: "user_1",
          status: ProofStatus.ACTIVE,
          contractTransactionHash: null,
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn({
          proof: {
            update: jest.fn().mockResolvedValue({
              id: "proof_1",
              status: ProofStatus.REVOKED,
              revokedAt: new Date("2026-08-04T00:00:00.000Z"),
              revokedByType: "OWNER",
              revocationReasonCode: "OWNER_REQUESTED",
              revocationReasonPrivate: null,
              revocationEvidenceHash: null,
            }),
          },
          auditLog: { create: jest.fn().mockResolvedValue({}) },
          anchoringIntent: { create: capturedIntentCreate },
        }),
      ),
    };
    const service = new ProofsService(
      prisma as never,
      makeConfig(true) as never, // anchoring enabled, but proof was never anchored
      mockVerificationEventService,
    );

    const result = await service.revokeProof(user, "proof_1");

    expect(result.anchoring).toEqual({ anchored: false, reason: "disabled" });
    expect(capturedIntentCreate).not.toHaveBeenCalled();
  });

  it("fails the whole revocation when the audit write fails, leaving no partial state observable to the caller", async () => {
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue({
          id: "proof_1",
          userId: "user_1",
          status: ProofStatus.ACTIVE,
          contractTransactionHash: null,
        }),
      },
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn({
          proof: {
            update: jest.fn().mockResolvedValue({
              id: "proof_1",
              status: ProofStatus.REVOKED,
              revokedAt: new Date("2026-08-04T00:00:00.000Z"),
            }),
          },
          auditLog: {
            create: jest.fn().mockRejectedValue(new Error("audit store unavailable")),
          },
          anchoringIntent: { create: jest.fn() },
        }),
      ),
    };
    const service = new ProofsService(
      prisma as never,
      config as never,
      mockVerificationEventService,
    );

    await expect(service.revokeProof(user, "proof_1")).rejects.toThrow(
      "audit store unavailable",
    );
  });

  describe("getProofAnchoringStatus", () => {
    it("returns the owner's anchoring intents, redacted-only", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: "intent_1",
              operation: "REGISTER",
              status: "FAILED",
              attemptCount: 10,
              lastAttemptAt: new Date("2026-01-01T00:00:00.000Z"),
              nextRetryAt: null,
              lastErrorSafe: "[REDACTED_ADDRESS]: insufficient balance",
              permanentError: true,
              transactionHash: null,
            },
          ]),
        },
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      const result = await service.getProofAnchoringStatus(user, "proof_1");

      expect(prisma.proof.findFirst).toHaveBeenCalledWith({
        where: { id: "proof_1", userId: "user_1" },
        select: { id: true },
      });
      expect(result.proofId).toBe("proof_1");
      expect(result.intents).toHaveLength(1);
      expect(result.intents[0]).toMatchObject({
        id: "intent_1",
        status: "FAILED",
        permanentError: true,
        lastErrorSafe: "[REDACTED_ADDRESS]: insufficient balance",
      });
    });

    it("lets an administrator view anchoring status for a proof they do not own", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      const admin = { ...user, id: "admin_1", role: "ADMIN" };
      await service.getProofAnchoringStatus(admin, "proof_1");

      expect(prisma.proof.findFirst).toHaveBeenCalledWith({
        where: { id: "proof_1" },
        select: { id: true },
      });
    });

    it("throws NotFoundException for a proof the caller cannot see", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue(null) },
        anchoringIntent: { findMany: jest.fn() },
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.getProofAnchoringStatus(user, "someone_elses_proof"),
      ).rejects.toThrow("Proof not found");
      expect(prisma.anchoringIntent.findMany).not.toHaveBeenCalled();
    });
  });

  describe("retryProofAnchoring", () => {
    it("requeues a quarantined intent without resetting its attempt count", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "QUARANTINED",
            permanentError: true,
            attemptCount: 10,
            quarantineDecision: "PENDING",
          }),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
          fn({
            anchoringIntent: {
              update: jest.fn().mockResolvedValue({
                id: "intent_1",
                status: "PENDING",
                attemptCount: 10,
              }),
            },
            auditLog: { create: jest.fn().mockResolvedValue({}) },
          }),
        ),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      const result = await service.retryProofAnchoring(user, "proof_1", "intent_1");

      expect(result).toEqual({
        intentId: "intent_1",
        status: "PENDING",
        attemptCount: 10,
      });
    });

    it("refuses to retry a PENDING intent (already scheduled to retry itself)", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "PENDING",
            permanentError: false,
            attemptCount: 2,
          }),
        },
        $transaction: jest.fn(),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.retryProofAnchoring(user, "proof_1", "intent_1"),
      ).rejects.toThrow(/not eligible for retry/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses to retry a PROCESSING intent (cannot duplicate an in-flight attempt)", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "PROCESSING",
            permanentError: false,
            attemptCount: 3,
          }),
        },
        $transaction: jest.fn(),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.retryProofAnchoring(user, "proof_1", "intent_1"),
      ).rejects.toThrow(/not eligible for retry/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses to retry a CONFIRMED intent (cannot duplicate a completed anchoring)", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "CONFIRMED",
            permanentError: false,
            attemptCount: 1,
          }),
        },
        $transaction: jest.fn(),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.retryProofAnchoring(user, "proof_1", "intent_1"),
      ).rejects.toThrow(/not eligible for retry/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses to redrive a quarantined intent that was already abandoned", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "QUARANTINED",
            permanentError: true,
            attemptCount: 10,
            quarantineDecision: "ABANDONED",
          }),
        },
        $transaction: jest.fn(),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.retryProofAnchoring(user, "proof_1", "intent_1"),
      ).rejects.toThrow(/not eligible for retry/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses a retry for a proof the caller does not own and is not an administrator for", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue(null) },
        anchoringIntent: { findFirst: jest.fn() },
        $transaction: jest.fn(),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.retryProofAnchoring(user, "someone_elses_proof", "intent_1"),
      ).rejects.toThrow("Proof not found");
      expect(prisma.anchoringIntent.findFirst).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when the intent does not belong to the given proof", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: { findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.retryProofAnchoring(user, "proof_1", "wrong_intent"),
      ).rejects.toThrow("Anchoring intent not found for this proof");
    });

    it("fails the whole retry when the audit write fails, leaving the intent unchanged from the caller's perspective", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "QUARANTINED",
            permanentError: true,
            attemptCount: 5,
            quarantineDecision: "PENDING",
          }),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
          fn({
            anchoringIntent: {
              update: jest.fn().mockResolvedValue({
                id: "intent_1",
                status: "PENDING",
                attemptCount: 5,
              }),
            },
            auditLog: {
              create: jest.fn().mockRejectedValue(new Error("audit store unavailable")),
            },
          }),
        ),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.retryProofAnchoring(user, "proof_1", "intent_1"),
      ).rejects.toThrow("audit store unavailable");
    });
  });

  describe("abandonProofAnchoring", () => {
    it("marks a quarantined intent ABANDONED and records who decided it", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "QUARANTINED",
            quarantineDecision: "PENDING",
          }),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
          fn({
            anchoringIntent: {
              update: jest.fn().mockResolvedValue({
                id: "intent_1",
                status: "QUARANTINED",
                quarantineDecision: "ABANDONED",
              }),
            },
            auditLog: { create: jest.fn().mockResolvedValue({}) },
          }),
        ),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      const result = await service.abandonProofAnchoring(user, "proof_1", "intent_1");

      expect(result).toEqual({
        intentId: "intent_1",
        status: "QUARANTINED",
        quarantineDecision: "ABANDONED",
      });
    });

    it("never touches the proof itself: abandoning a REGISTER intent cannot mark an unanchored proof confirmed", async () => {
      const proofUpdate = jest.fn();
      const prisma = {
        proof: {
          findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }),
          update: proofUpdate,
        },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            operation: "REGISTER",
            status: "QUARANTINED",
            quarantineDecision: "PENDING",
          }),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
          fn({
            anchoringIntent: {
              update: jest.fn().mockResolvedValue({
                id: "intent_1",
                status: "QUARANTINED",
                quarantineDecision: "ABANDONED",
              }),
            },
            auditLog: { create: jest.fn().mockResolvedValue({}) },
            proof: { update: proofUpdate },
          }),
        ),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await service.abandonProofAnchoring(user, "proof_1", "intent_1");

      expect(proofUpdate).not.toHaveBeenCalled();
    });

    it("is idempotent: abandoning an already-abandoned intent returns the existing decision without writing again", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "QUARANTINED",
            quarantineDecision: "ABANDONED",
          }),
        },
        $transaction: jest.fn(),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      const result = await service.abandonProofAnchoring(user, "proof_1", "intent_1");

      expect(result).toEqual({
        intentId: "intent_1",
        status: "QUARANTINED",
        quarantineDecision: "ABANDONED",
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses to abandon an intent that is not quarantined", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "PENDING",
            quarantineDecision: "PENDING",
          }),
        },
        $transaction: jest.fn(),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.abandonProofAnchoring(user, "proof_1", "intent_1"),
      ).rejects.toThrow(/not eligible for abandonment/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses to abandon a proof the caller does not own and is not an administrator for", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue(null) },
        anchoringIntent: { findFirst: jest.fn() },
        $transaction: jest.fn(),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.abandonProofAnchoring(user, "someone_elses_proof", "intent_1"),
      ).rejects.toThrow("Proof not found");
      expect(prisma.anchoringIntent.findFirst).not.toHaveBeenCalled();
    });

    it("fails the whole abandonment when the audit write fails", async () => {
      const prisma = {
        proof: { findFirst: jest.fn().mockResolvedValue({ id: "proof_1" }) },
        anchoringIntent: {
          findFirst: jest.fn().mockResolvedValue({
            id: "intent_1",
            proofId: "proof_1",
            status: "QUARANTINED",
            quarantineDecision: "PENDING",
          }),
        },
        $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) =>
          fn({
            anchoringIntent: {
              update: jest.fn().mockResolvedValue({
                id: "intent_1",
                status: "QUARANTINED",
                quarantineDecision: "ABANDONED",
              }),
            },
            auditLog: {
              create: jest.fn().mockRejectedValue(new Error("audit store unavailable")),
            },
          }),
        ),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.abandonProofAnchoring(user, "proof_1", "intent_1"),
      ).rejects.toThrow("audit store unavailable");
    });
  });

  it("uses revoked on-chain status during public verification", async () => {
    const credential = {
      id: "proof_onchain_revoked",
      type: "EarnProofMinimumIncomeCredential",
      schemaVersion: "earnproof.minimum-income.v1",
      issuer: "earnproof-backend",
      subject: { walletHash: "sha256:wallet" },
      claim: {
        operator: "gte",
        thresholdAmount: "100",
        assetCode: "XLM",
        assetIssuer: null,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
        qualifyingPaymentCount: 1,
      },
      privacy: { exactIncomeHidden: true, sourceTransactionsHidden: true },
      issuedAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2027-09-01T00:00:00.000Z",
    };
    const prisma = {
      proof: {
        findUnique: jest.fn().mockResolvedValue({
          id: "proof_onchain_revoked",
          proofType: ProofType.MINIMUM_INCOME,
          schemaVersion: "earnproof.minimum-income.v1",
          status: ProofStatus.ACTIVE,
          network: "testnet",
          assetCode: "XLM",
          assetIssuer: null,
          periodStart: new Date("2026-08-01T00:00:00.000Z"),
          periodEnd: new Date("2026-08-31T23:59:59.000Z"),
          expiresAt: new Date("2027-09-01T00:00:00.000Z"),
          revokedAt: null,
          createdAt: new Date("2026-08-02T00:00:00.000Z"),
          credentialHash: `sha256:${sha256(canonicalize(credential))}`,
          contractTransactionHash: "tx_register",
          user: { walletHash: "sha256:wallet" },
          claim: {
            thresholdEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
            disclosurePolicy: { qualifyingPaymentCount: 1 },
          },
        }),
      },
      verificationEvent: {
        create: jest.fn().mockResolvedValue({ id: "event_1" }),
      },
    };
    const anchoring = {
      getProofStatus: jest.fn().mockResolvedValue({
        checked: true,
        revoked: true,
        valid: false,
      }),
    };
    const service = new ProofsService(
      prisma as never,
      config as never,
      mockVerificationEventService,
      unlimitedQuotas() as never,
      mockAttestationsService,
      anchoring as never,
    );

    const result = await service.verifyProof("proof_onchain_revoked");

    expect(result.result).toBe(VerificationResult.REVOKED);
    expect(result.status).toBe("revoked");
    expect(result.proof?.contractStatus).toEqual({
      checked: true,
      revoked: true,
      valid: false,
    });
  });

  // ---------------------------------------------------------------------------
  // Outbox / anchoring policy tests
  // ---------------------------------------------------------------------------

  describe("anchoring outbox â€” same-transaction intent creation", () => {
    it("writes REGISTER AnchoringIntent inside the proof creation transaction when anchoring is enabled", async () => {
      const capturedIntents: unknown[] = [];
      const prisma = makeCreatePrisma((data) => capturedIntents.push(data));
      const service = new ProofsService(
        prisma as never,
        makeConfig(true) as never, // anchoring enabled
        mockVerificationEventService, unlimitedQuotas() as never,
        mockVerificationEventService,
        mockAttestationsService,
      );

      await service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      });

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]).toMatchObject({
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.PENDING,
      });
    });

    it("does NOT write an AnchoringIntent when anchoring is disabled", async () => {
      const capturedIntents: unknown[] = [];
      const prisma = makeCreatePrisma((data) => capturedIntents.push(data));
      const service = new ProofsService(
        prisma as never,
        makeConfig(false) as never, // anchoring disabled
        mockVerificationEventService,
        unlimitedQuotas() as never,
        mockAttestationsService,
      );

      await service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      });

      expect(capturedIntents).toHaveLength(0);
    });

    it("returns anchoring: pending when anchoring is enabled (not waiting for CLI)", async () => {
      const prisma = makeCreatePrisma();
      const service = new ProofsService(
        prisma as never,
        makeConfig(true) as never,
        mockVerificationEventService,
        unlimitedQuotas() as never,
        mockAttestationsService,
      );

      const result = await service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      });

      expect(result.anchoring).toEqual({ anchored: false, reason: "pending" });
    });

    it("returns anchoring: disabled when anchoring is not enabled", async () => {
      const prisma = makeCreatePrisma();
      const service = new ProofsService(
        prisma as never,
        makeConfig(false) as never,
        mockVerificationEventService,
        unlimitedQuotas() as never,
        mockAttestationsService,
      );

      const result = await service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      });

      expect(result.anchoring).toEqual({ anchored: false, reason: "disabled" });
    });
  });

  describe("required anchoring policy â€” verify endpoint", () => {
    function makeVerifyProof(contractTransactionHash: string | null, credOverrides: Record<string, unknown> = {}) {
      const issuedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const credential = {
        id: "proof_req",
        type: "EarnProofMinimumIncomeCredential",
        schemaVersion: "earnproof.minimum-income.v1",
        issuer: "earnproof-backend",
        subject: { walletHash: "sha256:wallet" },
        claim: {
          operator: "gte",
          thresholdAmount: "100",
          assetCode: "XLM",
          assetIssuer: null,
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-31T23:59:59.000Z",
          qualifyingPaymentCount: 1,
        },
        privacy: { exactIncomeHidden: true, sourceTransactionsHidden: true },
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ...credOverrides,
      };
      return {
        proof: {
          findUnique: jest.fn().mockResolvedValue({
            id: "proof_req",
            proofType: ProofType.MINIMUM_INCOME,
            schemaVersion: "earnproof.minimum-income.v1",
            status: ProofStatus.ACTIVE,
            network: "testnet",
            assetCode: "XLM",
            assetIssuer: null,
            periodStart: new Date("2026-08-01T00:00:00.000Z"),
            periodEnd: new Date("2026-08-31T23:59:59.000Z"),
            expiresAt,
            revokedAt: null,
            createdAt: issuedAt,
            credentialHash: `sha256:${sha256(canonicalize(credential))}`,
            contractTransactionHash,
            user: { walletHash: "sha256:wallet" },
            claim: {
              thresholdEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
              disclosurePolicy: { qualifyingPaymentCount: 1 },
            },
          }),
        },
        verificationEvent: {
          create: jest.fn().mockResolvedValue({ id: "event_1" }),
        },
      };
    }


    it("returns UNVERIFIED_ISSUER when anchoring is required and proof has no contractTransactionHash (anchoring still pending)", async () => {
      const prisma = makeVerifyProof(null); // no tx hash yet
      const service = new ProofsService(
        prisma as never,
        makeConfig(true, true) as never, // enabled + required
        mockVerificationEventService,
        unlimitedQuotas() as never,
        mockAttestationsService,
      );

      const result = await service.verifyProof("proof_req");

      expect(result.result).toBe(VerificationResult.UNVERIFIED_ISSUER);
    });

    it("returns VALID when anchoring is required and proof has a contractTransactionHash (anchored)", async () => {
      const prisma = makeVerifyProof("tx_confirmed");
      const service = new ProofsService(
        prisma as never,
        makeConfig(true, true) as never,
        mockVerificationEventService,
        unlimitedQuotas() as never,
        mockAttestationsService,
      );

      const result = await service.verifyProof("proof_req");

      expect(result.result).toBe(VerificationResult.VALID);
    });

    it("returns VALID (not UNVERIFIED_ISSUER) when anchoring is optional even without contractTransactionHash", async () => {
      const prisma = makeVerifyProof(null);
      // optional: enabled=true, required=false
      const service = new ProofsService(
        prisma as never,
        makeConfig(true, false) as never,
        mockVerificationEventService,
        unlimitedQuotas() as never,
        mockAttestationsService,
      );

      const result = await service.verifyProof("proof_req");

      expect(result.result).toBe(VerificationResult.VALID);
    });

    it("returns VALID when anchoring is fully disabled even without contractTransactionHash", async () => {
      const prisma = makeVerifyProof(null);
      const service = new ProofsService(
        prisma as never,
        makeConfig(false, false) as never,
        mockVerificationEventService,
        unlimitedQuotas() as never,
        mockAttestationsService,
      );

      const result = await service.verifyProof("proof_req");

      expect(result.result).toBe(VerificationResult.VALID);
    });
  });

  // ---------------------------------------------------------------------------

  describe("createIncomeRangeProof", () => {
    function makePayment(overrides: Record<string, unknown> = {}) {
      return {
        id: "payment_1",
        assetCode: "XLM",
        assetIssuer: null,
        amountEncrypted: `redacted:${Buffer.from("1000").toString("base64url")}`,
        classification: PaymentClassification.INCOME,
        isEligible: true,
        occurredAt: new Date("2026-08-01T00:00:00.000Z"),
        ...overrides,
      };
    }

    const baseInput = {
      selectedPaymentIds: ["payment_1"],
      lowerBound: "500",
      upperBound: "1500",
      assetCode: "XLM",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-31T23:59:59.000Z",
    };

    function makeIncomeRangePrisma(
      payments: unknown[],
      captureIntent?: (data: unknown) => void,
    ) {
      return {
        payment: {
          findMany: jest.fn().mockResolvedValue(payments),
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
              proof: {
                create: jest.fn().mockImplementation(({ data }) => ({
                  id: data.id,
                  userId: data.userId,
                  proofType: data.proofType,
                  schemaVersion: data.schemaVersion,
                  status: data.status,
                  network: data.network,
                  assetCode: data.assetCode,
                  assetIssuer: data.assetIssuer,
                  periodStart: data.periodStart,
                  periodEnd: data.periodEnd,
                  expiresAt: data.expiresAt,
                  credentialHash: data.credentialHash,
                  commitment: data.commitment,
                  createdAt: data.createdAt,
                  claim: data.claim.create,
                })),
              },
              anchoringIntent: {
                create: jest.fn().mockImplementation(({ data }) => {
                  captureIntent?.(data);
                  return { id: "intent_1", ...data };
                }),
              },
            };
            return fn(tx);
          }),
      };
    }

    // --- positive -----------------------------------------------------------

    it("issues a proof when the payment sum falls inside the requested range", async () => {
      const prisma = makeIncomeRangePrisma([makePayment()]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      const result = await service.createIncomeRangeProof(user, baseInput);

      expect(result.proofId).toBeDefined();
      expect(result.status).toBe(ProofStatus.ACTIVE);
      expect(result.credential.claim).toMatchObject({
        operator: "range",
        lowerBound: "500",
        upperBound: "1500",
        assetCode: "XLM",
        qualifyingPaymentCount: 1,
      });
      expect(result.credential.type).toBe("EarnProofIncomeRangeCredential");
    });

    it("issues a proof across mixed payments that share the requested asset", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({
          id: "payment_1",
          amountEncrypted: `redacted:${Buffer.from("300").toString("base64url")}`,
        }),
        makePayment({
          id: "payment_2",
          amountEncrypted: `redacted:${Buffer.from("400").toString("base64url")}`,
          occurredAt: new Date("2026-08-15T00:00:00.000Z"),
        }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      const result = await service.createIncomeRangeProof(user, {
        ...baseInput,
        selectedPaymentIds: ["payment_1", "payment_2"],
      });

      expect(result.credential.claim).toMatchObject({
        qualifyingPaymentCount: 2,
      });
    });

    // --- boundary -------------------------------------------------------------

    it("accepts a sum exactly equal to the lowerBound (inclusive)", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({
          amountEncrypted: `redacted:${Buffer.from("500").toString("base64url")}`,
        }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).resolves.toBeDefined();
    });

    it("accepts a sum exactly equal to the upperBound (inclusive)", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({
          amountEncrypted: `redacted:${Buffer.from("1500").toString("base64url")}`,
        }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).resolves.toBeDefined();
    });

    it("rejects an inverted range (lowerBound > upperBound)", async () => {
      const prisma = makeIncomeRangePrisma([makePayment()]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, {
          ...baseInput,
          lowerBound: "1500",
          upperBound: "500",
        }),
      ).rejects.toThrow("lowerBound must be strictly less than upperBound");
    });

    it("rejects a degenerate zero-width range (lowerBound === upperBound)", async () => {
      const prisma = makeIncomeRangePrisma([makePayment()]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, {
          ...baseInput,
          lowerBound: "1000",
          upperBound: "1000",
        }),
      ).rejects.toThrow("lowerBound must be strictly less than upperBound");
    });

    // --- negative ---------------------------------------------------------

    it("rejects when the payment sum is below the lowerBound", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({
          amountEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
        }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("do not fall within the requested income range");
    });

    it("rejects when the payment sum is above the upperBound", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({
          amountEncrypted: `redacted:${Buffer.from("2000").toString("base64url")}`,
        }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("do not fall within the requested income range");
    });

    it("rejects a payment using a different asset than requested", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({ assetCode: "USDC" }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("must use the requested asset");
    });

    it("rejects mixed-asset selected payments (regression)", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({ id: "payment_1", assetCode: "XLM" }),
        makePayment({ id: "payment_2", assetCode: "USDC" }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, {
          ...baseInput,
          selectedPaymentIds: ["payment_1", "payment_2"],
        }),
      ).rejects.toThrow("must use the requested asset");
    });

    it("rejects a payment belonging to another user (ownership check)", async () => {
      // findMany scoped to userId returns fewer rows than requested when a
      // payment id does not resolve for this user.
      const prisma = makeIncomeRangePrisma([]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("One or more selected payments are invalid");
    });

    it("rejects a non-INCOME classified payment", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({ classification: PaymentClassification.EXCLUDED }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("must be eligible income payments");
    });

    it("rejects an ineligible payment", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({ isEligible: false }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("must be eligible income payments");
    });

    it("rejects a payment that occurred outside the requested period", async () => {
      const prisma = makeIncomeRangePrisma([
        makePayment({ occurredAt: new Date("2026-09-15T00:00:00.000Z") }),
      ]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, baseInput),
      ).rejects.toThrow("must fall inside the requested period");
    });

    it("rejects when periodStart is after periodEnd", async () => {
      const prisma = makeIncomeRangePrisma([makePayment()]);
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createIncomeRangeProof(user, {
          ...baseInput,
          periodStart: "2026-08-31T23:59:59.000Z",
          periodEnd: "2026-08-01T00:00:00.000Z",
        }),
      ).rejects.toThrow("periodStart must be before periodEnd");
    });

    // --- privacy regression -------------------------------------------------

    it("never leaks the summed total into the disclosure policy or credential", async () => {
      const capturedClaims: unknown[] = [];
      const prisma = {
        payment: {
          findMany: jest.fn().mockResolvedValue([
            makePayment({
              amountEncrypted: `redacted:${Buffer.from("777").toString("base64url")}`,
            }),
          ]),
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
              proof: {
                create: jest.fn().mockImplementation(({ data }) => {
                  capturedClaims.push(data.claim.create);
                  return {
                    id: data.id,
                    userId: data.userId,
                    proofType: data.proofType,
                    schemaVersion: data.schemaVersion,
                    status: data.status,
                    network: data.network,
                    assetCode: data.assetCode,
                    assetIssuer: data.assetIssuer,
                    periodStart: data.periodStart,
                    periodEnd: data.periodEnd,
                    expiresAt: data.expiresAt,
                    credentialHash: data.credentialHash,
                    commitment: data.commitment,
                    createdAt: data.createdAt,
                    claim: data.claim.create,
                  };
                }),
              },
              anchoringIntent: { create: jest.fn() },
            };
            return fn(tx);
          }),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      const result = await service.createIncomeRangeProof(user, baseInput);

      const serializedClaim = JSON.stringify(capturedClaims[0]);
      const serializedCredentialClaim = JSON.stringify(result.credential.claim);

      // The sum (777) must never appear anywhere in persisted or emitted data.
      expect(serializedClaim).not.toContain("777");
      expect(serializedCredentialClaim).not.toContain("777");
      expect(capturedClaims[0]).toMatchObject({
        operator: "range",
        disclosurePolicy: {
          exactIncomeHidden: true,
          sourceTransactionsHidden: true,
          qualifyingPaymentCount: 1,
          lowerBound: "500",
          upperBound: "1500",
        },
      });
    });

    // --- anchoring parity with createMinimumIncomeProof ---------------------

    it("enqueues a REGISTER anchoring intent identically to createMinimumIncomeProof when anchoring is enabled", async () => {
      const capturedIntents: unknown[] = [];
      const prisma = makeIncomeRangePrisma([makePayment()], (data) =>
        capturedIntents.push(data),
      );
      const service = new ProofsService(
        prisma as never,
        makeConfig(true) as never,
        mockVerificationEventService,
      );

      const result = await service.createIncomeRangeProof(user, baseInput);

      expect(capturedIntents).toHaveLength(1);
      expect(capturedIntents[0]).toMatchObject({
        operation: AnchoringOperation.REGISTER,
        status: AnchoringStatus.PENDING,
      });
      expect(result.anchoring).toEqual({ anchored: false, reason: "pending" });
    });

    it("does not enqueue an anchoring intent when anchoring is disabled", async () => {
      const capturedIntents: unknown[] = [];
      const prisma = makeIncomeRangePrisma([makePayment()], (data) =>
        capturedIntents.push(data),
      );
      const service = new ProofsService(
        prisma as never,
        makeConfig(false) as never,
        mockVerificationEventService,
      );

      const result = await service.createIncomeRangeProof(user, baseInput);

      expect(capturedIntents).toHaveLength(0);
      expect(result.anchoring).toEqual({
        anchored: false,
        reason: "disabled",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // verifyProof — INCOME_RANGE
  // ---------------------------------------------------------------------------

  describe("verifyProof — income range", () => {
    it("rebuilds and verifies an INCOME_RANGE credential without leaking the sum", async () => {
      const credential = {
        id: "proof_range",
        type: "EarnProofIncomeRangeCredential",
        schemaVersion: "earnproof.income-range.v1",
        issuer: "earnproof-backend",
        subject: { walletHash: "sha256:wallet" },
        claim: {
          operator: "range",
          lowerBound: "500",
          upperBound: "1500",
          assetCode: "XLM",
          assetIssuer: null,
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-31T23:59:59.000Z",
          qualifyingPaymentCount: 1,
        },
        privacy: { exactIncomeHidden: true, sourceTransactionsHidden: true },
        issuedAt: "2026-08-02T00:00:00.000Z",
        expiresAt: "2030-10-01T00:00:00.000Z",
      };
      const prisma = {
        proof: {
          findUnique: jest.fn().mockResolvedValue({
            id: "proof_range",
            userId: "user_1",
            proofType: ProofType.INCOME_RANGE,
            schemaVersion: "earnproof.income-range.v1",
            status: ProofStatus.ACTIVE,
            network: "testnet",
            assetCode: "XLM",
            assetIssuer: null,
            periodStart: new Date("2026-08-01T00:00:00.000Z"),
            periodEnd: new Date("2026-08-31T23:59:59.000Z"),
            expiresAt: new Date("2030-10-01T00:00:00.000Z"),
            revokedAt: null,
            createdAt: new Date("2026-08-02T00:00:00.000Z"),
            credentialHash: `sha256:${sha256(canonicalize(credential))}`,
            contractTransactionHash: null,
            user: { walletHash: "sha256:wallet" },
            claim: {
              thresholdEncrypted: null,
              frequency: null,
              disclosurePolicy: {
                qualifyingPaymentCount: 1,
                lowerBound: "500",
                upperBound: "1500",
              },
            },
          }),
        },
        verificationEvent: {
          create: jest.fn().mockResolvedValue({ id: "event_1" }),
        },
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      const result = await service.verifyProof("proof_range");

      expect(result.result).toBe(VerificationResult.VALID);
      expect(result.status).toBe("valid");
      expect(result.credential?.claim).toMatchObject({
        operator: "range",
        lowerBound: "500",
        upperBound: "1500",
      });
    });
  });

  describe("supported-asset policy enforcement at issuance", () => {
    it("persists assetPolicyId and assetPolicySnapshot on the created proof (positive)", async () => {
      const capturedProofData: Record<string, unknown>[] = [];
      const prisma = {
        payment: {
          findMany: jest.fn().mockResolvedValue(singlePayment),
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
              supportedAsset: {
                findFirst: jest.fn().mockResolvedValue(activeSupportedAsset),
              },
              proof: {
                create: jest.fn().mockImplementation(({ data }) => {
                  capturedProofData.push(data);
                  return { ...data, claim: data.claim.create };
                }),
              },
              anchoringIntent: { create: jest.fn() },
            };
            return fn(tx);
          }),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await service.createMinimumIncomeProof(user, {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      });

      expect(capturedProofData).toHaveLength(1);
      expect(capturedProofData[0]).toMatchObject({
        assetPolicyId: "asset_1",
        assetPolicySnapshot: expect.objectContaining({
          supportedAssetId: "asset_1",
          code: "XLM",
          issuer: null,
          network: "testnet",
          status: ResourceStatus.ACTIVE,
          canonicalAssetId: "testnet:native:XLM",
        }),
      });
    });

    it("rejects issuance and writes no proof when the asset is no longer active (negative)", async () => {
      const proofCreate = jest.fn();
      const prisma = {
        payment: {
          findMany: jest.fn().mockResolvedValue(singlePayment),
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
              supportedAsset: {
                // Asset was deactivated between sync and issuance.
                findFirst: jest.fn().mockResolvedValue(null),
              },
              proof: { create: proofCreate },
              anchoringIntent: { create: jest.fn() },
            };
            return fn(tx);
          }),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createMinimumIncomeProof(user, {
          selectedPaymentIds: ["payment_1"],
          thresholdAmount: "100",
          assetCode: "XLM",
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-31T23:59:59.000Z",
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "ASSET_NOT_SUPPORTED" }),
      });
      expect(proofCreate).not.toHaveBeenCalled();
    });

    it("rejects payment-receipt issuance when the asset is no longer active (negative, second issuance path)", async () => {
      const proofCreate = jest.fn();
      const prisma = {
        payment: {
          findFirst: jest.fn().mockResolvedValue({
            operationId: "op_1",
            sourceAddress: "GA",
            assetCode: "XLM",
            assetIssuer: null,
            amountEncrypted: `redacted:${Buffer.from("10").toString("base64url")}`,
            classification: PaymentClassification.INCOME,
            isEligible: true,
            occurredAt: new Date("2026-08-01T00:00:00.000Z"),
          }),
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
              supportedAsset: { findFirst: jest.fn().mockResolvedValue(null) },
              proof: { create: proofCreate },
              anchoringIntent: { create: jest.fn() },
            };
            return fn(tx);
          }),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createPaymentReceiptProof(user, { paymentId: "payment_1" }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "ASSET_NOT_SUPPORTED" }),
      });
      expect(proofCreate).not.toHaveBeenCalled();
    });

    it("keeps stale Payment.isEligible from making a deactivated asset newly eligible for a proof (regression, TOCTOU)", async () => {
      // Payment.isEligible is still true (sync has not rerun since deactivation),
      // but the live registry check inside the transaction is authoritative.
      const proofCreate = jest.fn();
      const prisma = {
        payment: {
          findMany: jest.fn().mockResolvedValue(singlePayment), // isEligible: true (stale)
        },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) => {
            const tx = {
              supportedAsset: { findFirst: jest.fn().mockResolvedValue(null) },
              proof: { create: proofCreate },
              anchoringIntent: { create: jest.fn() },
            };
            return fn(tx);
          }),
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.createMinimumIncomeProof(user, {
          selectedPaymentIds: ["payment_1"],
          thresholdAmount: "100",
          assetCode: "XLM",
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-31T23:59:59.000Z",
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "ASSET_NOT_SUPPORTED" }),
      });
      expect(proofCreate).not.toHaveBeenCalled();
    });

    it("handles concurrent issuance attempts: the request racing a mid-flight deactivation is rejected while the other succeeds", async () => {
      const firstProofCreate = jest.fn().mockImplementation(({ data }) => ({
        ...data,
        claim: data.claim.create,
      }));
      const secondProofCreate = jest.fn();

      const firstPrisma = {
        payment: { findMany: jest.fn().mockResolvedValue(singlePayment) },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) =>
            fn({
              supportedAsset: {
                findFirst: jest.fn().mockResolvedValue(activeSupportedAsset),
              },
              proof: { create: firstProofCreate },
              anchoringIntent: { create: jest.fn() },
            }),
          ),
      };
      const secondPrisma = {
        payment: { findMany: jest.fn().mockResolvedValue(singlePayment) },
        $transaction: jest
          .fn()
          .mockImplementation(async (fn: (tx: unknown) => unknown) =>
            fn({
              supportedAsset: { findFirst: jest.fn().mockResolvedValue(null) },
              proof: { create: secondProofCreate },
              anchoringIntent: { create: jest.fn() },
            }),
          ),
      };

      const serviceOne = new ProofsService(
        firstPrisma as never,
        config as never,
        mockVerificationEventService,
      );
      const serviceTwo = new ProofsService(
        secondPrisma as never,
        config as never,
        mockVerificationEventService,
      );

      const input = {
        selectedPaymentIds: ["payment_1"],
        thresholdAmount: "100",
        assetCode: "XLM",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.000Z",
      };

      const [firstOutcome, secondOutcome] = await Promise.allSettled([
        serviceOne.createMinimumIncomeProof(user, input),
        serviceTwo.createMinimumIncomeProof(user, input),
      ]);

      expect(firstOutcome.status).toBe("fulfilled");
      expect(secondOutcome.status).toBe("rejected");
      if (secondOutcome.status === "rejected") {
        expect(secondOutcome.reason).toMatchObject({
          response: expect.objectContaining({ code: "ASSET_NOT_SUPPORTED" }),
        });
      }
      expect(firstProofCreate).toHaveBeenCalledTimes(1);
      expect(secondProofCreate).not.toHaveBeenCalled();
    });

    it("never consults the live SupportedAsset registry during verification (regression: historical proofs stay verifiable after deactivation)", async () => {
      const credential = {
        id: "proof_after_deactivation",
        type: "EarnProofMinimumIncomeCredential",
        schemaVersion: "earnproof.minimum-income.v1",
        issuer: "earnproof-backend",
        subject: { walletHash: "sha256:wallet" },
        claim: {
          operator: "gte",
          thresholdAmount: "100",
          assetCode: "XLM",
          assetIssuer: null,
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-31T23:59:59.000Z",
          qualifyingPaymentCount: 1,
        },
        privacy: { exactIncomeHidden: true, sourceTransactionsHidden: true },
        issuedAt: "2026-08-02T00:00:00.000Z",
        expiresAt: "2030-08-20T00:00:00.000Z",
      };
      const prisma = {
        proof: {
          findUnique: jest.fn().mockResolvedValue({
            id: "proof_after_deactivation",
            proofType: ProofType.MINIMUM_INCOME,
            schemaVersion: "earnproof.minimum-income.v1",
            status: ProofStatus.ACTIVE,
            network: "testnet",
            assetCode: "XLM",
            assetIssuer: null,
            // The asset this proof was issued against has since been
            // deactivated in SupportedAsset - but that must not matter here.
            assetPolicyId: "asset_1",
            assetPolicySnapshot: {
              supportedAssetId: "asset_1",
              code: "XLM",
              issuer: null,
              network: "testnet",
              status: ResourceStatus.ACTIVE,
              canonicalAssetId: "testnet:native:XLM",
              checkedAt: "2026-08-02T00:00:00.000Z",
            },
            periodStart: new Date("2026-08-01T00:00:00.000Z"),
            periodEnd: new Date("2026-08-31T23:59:59.000Z"),
            expiresAt: new Date("2030-08-20T00:00:00.000Z"),
            revokedAt: null,
            createdAt: new Date("2026-08-02T00:00:00.000Z"),
            credentialHash: `sha256:${sha256(canonicalize(credential))}`,
            contractTransactionHash: null,
            user: { walletHash: "sha256:wallet" },
            claim: {
              thresholdEncrypted: `redacted:${Buffer.from("100").toString("base64url")}`,
              disclosurePolicy: { qualifyingPaymentCount: 1 },
            },
          }),
        },
        verificationEvent: {
          create: jest.fn().mockResolvedValue({ id: "event_1" }),
        },
      };
      const service = new ProofsService(
        prisma as never,
        config as never,
        mockVerificationEventService,
      );

      await expect(
        service.verifyProof("proof_after_deactivation"),
      ).resolves.toMatchObject({ result: VerificationResult.VALID });
    });
  });
});
