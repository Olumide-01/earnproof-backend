import { Prisma } from "@prisma/client";
import { PaymentsService } from "./payments.service";

function toid(ledger: number, txOrder: number, opIndex: number): string {
  return (
    (BigInt(ledger) << 32n) |
    (BigInt(txOrder) << 12n) |
    BigInt(opIndex)
  ).toString();
}

const config = {
  getOrThrow: jest.fn((key: string) => {
    const values: Record<string, string> = {
      paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      "stellar.network": "testnet",
    };
    return values[key];
  }),
  get: jest.fn((key: string) => {
    if (key === "paymentEncryptionKey") {
      return "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    }
    return undefined;
  }),
};

function normalizedPayment(operationId: string, txHash: string) {
  return {
    operationId,
    operationIndex: null, // service derives from operationId when absent
    stellarTransactionHash: txHash,
    sourceAddress: "GSRC",
    destinationAddress: "GDST",
    assetCode: "XLM",
    assetIssuer: null,
    amount: "10.0000000",
    occurredAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

function buildService(
  payments: ReturnType<typeof normalizedPayment>[],
  upsert = jest.fn().mockResolvedValue({}),
) {
  const stellarService = {
    fetchIncomingPayments: jest.fn().mockResolvedValue(payments),
    fetchTransaction: jest.fn().mockResolvedValue({ memo_type: "none" }),
  };
  const prisma = {
    supportedAsset: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ code: "XLM", issuer: null, network: "testnet" }]),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert,
    },
  };
  const service = new PaymentsService(
    prisma as never,
    stellarService as never,
    config as never,
  );
  return { service, prisma, upsert };
}

describe("PaymentsService.syncPayments canonical identity", () => {
  it("keeps two operations of one transaction distinct via operation index", async () => {
    const tx = "SAME_TX_HASH";
    const { service, upsert } = buildService([
      normalizedPayment(toid(100, 1, 0), tx),
      normalizedPayment(toid(100, 1, 1), tx),
    ]);

    const result = await service.syncPayments({
      id: "user-1",
      walletAddress: "GWALLET",
    });

    expect(result.created).toBe(2);
    const indices = upsert.mock.calls.map(
      (call) => call[0].create.operationIndex,
    );
    expect(indices).toEqual([0, 1]);
    for (const call of upsert.mock.calls) {
      expect(call[0].create.network).toBe("testnet");
    }
  });

  it("reprocesses idempotently: the same operation upserts on operationId", async () => {
    const op = toid(200, 3, 0);
    const { service, upsert } = buildService([normalizedPayment(op, "TXA")]);
    await service.syncPayments({ id: "user-1", walletAddress: "GWALLET" });
    expect(upsert.mock.calls[0][0].where).toEqual({ operationId: op });
    expect(upsert.mock.calls[0][0].update.operationIndex).toBe(0);
  });

  it("counts a conflicting duplicate (P2002) instead of failing the sync", async () => {
    const upsert = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("conflict", {
          code: "P2002",
          clientVersion: "test",
        }),
      );
    const { service } = buildService(
      [
        normalizedPayment(toid(300, 1, 0), "TXA"),
        normalizedPayment(toid(300, 1, 0), "TXA"),
      ],
      upsert,
    );

    const result = await service.syncPayments({
      id: "user-1",
      walletAddress: "GWALLET",
    });

    expect(result.created).toBe(1);
    expect(result.conflicts).toBe(1);
  });

  it("rethrows non-P2002 database errors", async () => {
    const upsert = jest.fn().mockRejectedValue(new Error("connection lost"));
    const { service } = buildService(
      [normalizedPayment(toid(400, 1, 0), "TXA")],
      upsert,
    );
    await expect(
      service.syncPayments({ id: "user-1", walletAddress: "GWALLET" }),
    ).rejects.toThrow("connection lost");
  });
});
