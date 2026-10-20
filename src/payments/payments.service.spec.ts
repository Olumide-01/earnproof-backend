import { PaymentClassification, ResourceStatus } from "@prisma/client";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { PaymentsService } from "./payments.service";
import { unlimitedQuotas } from "../testing/quotas";

/**
 * Finality stub for tests about the write path. Checkpoint behaviour has its own
 * suite (payment-finality.service.spec.ts); here every sync is an initial one.
 */
function finalityStub() {
  return {
    plan: jest.fn().mockResolvedValue({ mode: "initial" }),
    readOptions: jest.fn().mockReturnValue({}),
    inspect: jest.fn().mockReturnValue(null),
    replacements: jest.fn().mockReturnValue(new Set()),
    settle: jest.fn().mockResolvedValue({
      status: "unverified",
      heldPayments: 0,
      orphanedPayments: 0,
    }),
  };
}

/** The read result shape `readIncomingPayments` resolves with. */
function readOf(payments: unknown[]) {
  return { payments, stopReason: "exhausted", lastCursor: null };
}

describe("PaymentsService", () => {
  const config = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "stellar.network": "stellar-testnet",
      };
      return values[key];
    }),
  };
  const keyring = () => new PaymentEncryptionKeyringService(config as never);

  it("syncs incoming payments idempotently", async () => {
    const prisma = {
      supportedAsset: {
        findMany: jest.fn().mockResolvedValue([
          { code: "XLM", issuer: null, network: "stellar-testnet" },
        ]),
      },
      payment: {
        // syncPayments batches the existence check into one findMany ahead
        // of its loop; an empty result means nothing pre-exists, i.e. every
        // incoming payment is a create.
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({ id: "payment_1" }),
      },
    };
    const stellar = {
      readIncomingPayments: jest.fn().mockResolvedValue(
        readOf([
          {
            operationId: "op_1",
            stellarTransactionHash: "tx_1",
            sourceAddress: "GA",
            destinationAddress: "GB",
            assetCode: "XLM",
            assetIssuer: null,
            amount: "10",
            occurredAt: new Date("2026-07-13T00:00:00Z"),
          },
        ]),
      ),
      fetchTransaction: jest.fn().mockResolvedValue({
        memo_type: "text",
        memo: "Salary June",
      }),
    };
    const service = new PaymentsService(
      prisma as never,
      stellar as never,
      config as never,
      unlimitedQuotas() as never,
      finalityStub() as never,
    );

    await expect(
      service.syncPayments({ id: "user_1", walletAddress: "GB" }),
    ).resolves.toEqual({
      totalFetched: 1,
      created: 1,
      updated: 0,
      skipped: 0,
      enrichmentErrors: 0,
      finality: { status: "unverified", heldPayments: 0, orphanedPayments: 0 },
      conflicts: 0,
    });

    expect(prisma.supportedAsset.findMany).toHaveBeenCalledWith({
      where: { status: ResourceStatus.ACTIVE, network: "stellar-testnet" },
      select: { code: true, issuer: true, network: true },
    });
    expect(prisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          classification: PaymentClassification.UNKNOWN,
          isEligible: true,
          amountEncrypted: expect.stringMatching(/^enc:v0:/),
          memo: {
            version: 2,
            type: "text",
            ciphertext: expect.stringMatching(/^enc:v0:/),
          },
        }),
      }),
    );
    const stored = prisma.payment.upsert.mock.calls[0][0].create.memo;
    expect(JSON.stringify(stored)).not.toContain("Salary June");
    expect(decodeStoredMemo(stored, keyring())).toEqual({
      type: "text",
      value: "Salary June",
      truncated: false,
    });
  });

  it("deduplicates transaction memo lookups within one sync", async () => {
    const payments = ["op_1", "op_2"].map((operationId) => ({
      operationId,
      stellarTransactionHash: "shared_tx",
      sourceAddress: "GA",
      destinationAddress: "GB",
      assetCode: "XLM",
      assetIssuer: null,
      amount: "10",
      occurredAt: new Date("2026-07-13T00:00:00Z"),
    }));
    const prisma = {
      supportedAsset: { findMany: jest.fn().mockResolvedValue([]) },
      payment: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const stellar = {
      readIncomingPayments: jest.fn().mockResolvedValue(readOf(payments)),
      fetchTransaction: jest
        .fn()
        .mockResolvedValue({ memo_type: "id", memo: "42" }),
    };
    const service = new PaymentsService(
      prisma as never,
      stellar as never,
      config as never,
      unlimitedQuotas() as never,
      finalityStub() as never,
    );

    const result = await service.syncPayments({
      id: "user_1",
      walletAddress: "GB",
    });

    expect(stellar.fetchTransaction).toHaveBeenCalledTimes(1);
    expect(result.enrichmentErrors).toBe(0);
    expect(prisma.payment.upsert).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a Horizon response error", new Error("Horizon returned 503")],
    ["a network error", new TypeError("fetch failed")],
    ["a missing transaction", null],
  ])("continues syncing after %s", async (_label, transactionResult) => {
    const prisma = {
      supportedAsset: { findMany: jest.fn().mockResolvedValue([]) },
      payment: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const stellar = {
      readIncomingPayments: jest.fn().mockResolvedValue(
        readOf([
          {
            operationId: "op_1",
            stellarTransactionHash: "tx_1",
            sourceAddress: "GA",
            destinationAddress: "GB",
            assetCode: "XLM",
            assetIssuer: null,
            amount: "10",
            occurredAt: new Date("2026-07-13T00:00:00Z"),
          },
        ]),
      ),
      fetchTransaction:
        transactionResult instanceof Error
          ? jest.fn().mockRejectedValue(transactionResult)
          : jest.fn().mockResolvedValue(transactionResult),
    };
    const service = new PaymentsService(
      prisma as never,
      stellar as never,
      config as never,
      unlimitedQuotas() as never,
      finalityStub() as never,
    );

    await expect(
      service.syncPayments({ id: "user_1", walletAddress: "GB" }),
    ).resolves.toMatchObject({ created: 1, enrichmentErrors: 1 });
    expect(prisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          memo: { version: 2, type: "none" },
        }),
      }),
    );
  });

  it("updates classification and records an audit log", async () => {
    const prisma = {
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          id: "payment_1",
          classification: PaymentClassification.UNKNOWN,
          assetCode: "XLM",
          assetIssuer: null,
          isEligible: true,
        }),
        update: jest.fn().mockResolvedValue({
          id: "payment_1",
          classification: PaymentClassification.INCOME,
        }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: "audit_1" }),
      },
    };
    const service = new PaymentsService(
      prisma as never,
      {} as never,
      config as never,
      unlimitedQuotas() as never,
      {} as never,
    );

    await expect(
      service.updateClassification(
        { id: "user_1" },
        "payment_1",
        PaymentClassification.INCOME,
      ),
    ).resolves.toMatchObject({
      id: "payment_1",
      classification: PaymentClassification.INCOME,
    });

    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: "payment_1" },
      data: {
        classification: PaymentClassification.INCOME,
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "payment.classification.updated",
          actorId: "user_1",
        }),
      }),
    );
  });

  it("exposes memo context only through the owner payment DTO", async () => {
    const payment = {
      id: "payment_1",
      userId: "user_1",
      operationId: "op_1",
      stellarTransactionHash: "tx_1",
      sourceAddress: "GA",
      destinationAddress: "GB",
      assetCode: "XLM",
      assetIssuer: null,
      amountEncrypted: "enc:v1:private",
      occurredAt: new Date("2026-07-13T00:00:00Z"),
      memo: encodeStoredMemo(
        { memo: { type: "text", value: "Salary June", truncated: false } },
        keyring(),
      ) as unknown,
      classification: PaymentClassification.INCOME,
      isEligible: true,
      createdAt: new Date("2026-07-13T00:00:00Z"),
      updatedAt: new Date("2026-07-13T00:00:00Z"),
    };
    const prisma = {
      payment: {
        findMany: jest.fn().mockResolvedValue([payment]),
        findFirst: jest.fn().mockResolvedValue(payment),
      },
    };
    const service = new PaymentsService(
      prisma as never,
      {} as never,
      config as never,
      unlimitedQuotas() as never,
      {} as never,
    );

    const { data } = await service.listPayments("user_1", {});
    const [listed] = data;
    const detail = await service.getPayment("user_1", "payment_1");

    const expected = { type: "text", value: "Salary June", truncated: false };
    expect(listed.memoContext).toEqual(expected);
    expect(detail.memoContext).toEqual(expected);
    expect(listed).not.toHaveProperty("memo");
    expect(listed).not.toHaveProperty("amountEncrypted");
    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { id: "payment_1", userId: "user_1" },
    });
  });

  it("does not make unsupported assets eligible during classification", async () => {
    const prisma = {
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          id: "payment_unsupported",
          classification: PaymentClassification.UNKNOWN,
          assetCode: "FAKE",
          assetIssuer: "GISSUER",
          isEligible: false,
        }),
        update: jest.fn().mockResolvedValue({
          id: "payment_unsupported",
          classification: PaymentClassification.INCOME,
          isEligible: false,
        }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: "audit_2" }),
      },
    };
    const service = new PaymentsService(
      prisma as never,
      {} as never,
      config as never,
      unlimitedQuotas() as never,
      {} as never,
    );

    const updated = await service.updateClassification(
      { id: "user_1" },
      "payment_unsupported",
      PaymentClassification.INCOME,
    );

    expect(updated).toMatchObject({
      classification: PaymentClassification.INCOME,
      isEligible: false,
    });
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: "payment_unsupported" },
      data: {
        classification: PaymentClassification.INCOME,
      },
    });
  });

  it("does not grant eligibility from a SupportedAsset row seeded for a different network", async () => {
    // Same code/issuer (native, no issuer) but active only on "public" -
    // this deployment runs on "stellar-testnet" and must not borrow the
    // other network's policy.
    const prisma = {
      supportedAsset: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: "payment_1" }),
      },
    };
    const stellar = {
      fetchIncomingPayments: jest.fn().mockResolvedValue([
        {
          operationId: "op_1",
          stellarTransactionHash: "tx_1",
          sourceAddress: "GA",
          destinationAddress: "GB",
          assetCode: "XLM",
          assetIssuer: null,
          amount: "10",
          occurredAt: new Date("2026-07-13T00:00:00Z"),
        },
      ]),
      fetchTransaction: jest.fn().mockResolvedValue({ type: "none" }),
    };
    const service = new PaymentsService(
      prisma as never,
      stellar as never,
      config as never,
    );

    await service.syncPayments({ id: "user_1", walletAddress: "GB" });

    expect(prisma.supportedAsset.findMany).toHaveBeenCalledWith({
      where: { status: ResourceStatus.ACTIVE, network: "stellar-testnet" },
      select: { code: true, issuer: true, network: true },
    });
    expect(prisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ isEligible: false }),
      }),
    );
  });

  it("flips isEligible to false on the next sync after the asset is deactivated", async () => {
    // First sync: asset is ACTIVE, payment becomes eligible.
    const activePrisma = {
      supportedAsset: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { code: "USDC", issuer: "GISSUER1", network: "stellar-testnet" },
          ]),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: "payment_1" }),
      },
    };
    const stellar = {
      fetchIncomingPayments: jest.fn().mockResolvedValue([
        {
          operationId: "op_1",
          stellarTransactionHash: "tx_1",
          sourceAddress: "GA",
          destinationAddress: "GB",
          assetCode: "USDC",
          assetIssuer: "GISSUER1",
          amount: "10",
          occurredAt: new Date("2026-07-13T00:00:00Z"),
        },
      ]),
      fetchTransaction: jest.fn().mockResolvedValue({ type: "none" }),
    };
    const service = new PaymentsService(
      activePrisma as never,
      stellar as never,
      config as never,
    );

    await service.syncPayments({ id: "user_1", walletAddress: "GB" });
    expect(activePrisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ isEligible: true }),
      }),
    );

    // Asset gets deactivated (no longer returned by the ACTIVE-status query).
    // Second sync of the same payment must flip it to ineligible.
    const deactivatedPrisma = {
      supportedAsset: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue({ id: "payment_1" }),
        upsert: jest.fn().mockResolvedValue({ id: "payment_1" }),
      },
    };
    const serviceAfterDeactivation = new PaymentsService(
      deactivatedPrisma as never,
      stellar as never,
      config as never,
    );

    await serviceAfterDeactivation.syncPayments({
      id: "user_1",
      walletAddress: "GB",
    });

    expect(deactivatedPrisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ isEligible: false }),
      }),
    );
  });
});
