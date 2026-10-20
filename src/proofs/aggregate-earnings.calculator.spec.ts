import { AggregateEarningsCalculator, AggregateEarningsRequest } from "./aggregate-earnings.calculator";
import { AggregationPolicyError, MAX_COMPONENT_PAYMENTS } from "./aggregate-earnings.policy";

/**
 * The calculator's database contract: what it asks for and what it does with
 * the answer. Policy arithmetic is covered in aggregate-earnings.policy.spec.ts.
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ASSET = { code: "USDC", issuer: "GISSUER" };

type Row = {
  operationId: string;
  amountEncrypted: string | null;
  occurredAt: Date;
  assetCode: string;
  assetIssuer: string | null;
};

function row(operationId: string, amount: string | null, day = 10): Row {
  return {
    operationId,
    amountEncrypted: amount === null ? null : `enc:${amount}`,
    occurredAt: new Date(Date.UTC(2026, 4, day)),
    assetCode: ASSET.code,
    assetIssuer: ASSET.issuer,
  };
}

function prismaDouble(rows: Row[], extras: { trusted?: string[]; issuers?: Array<{ id: string; stellarAddress: string }> } = {}) {
  return {
    payment: { findMany: jest.fn().mockResolvedValue(rows) },
    trustedSource: {
      findMany: jest
        .fn()
        .mockResolvedValue((extras.trusted ?? []).map((sourceAddress) => ({ sourceAddress }))),
    },
    issuer: {
      findMany: jest.fn(({ where }: { where: { id?: { in: string[] } } }) =>
        Promise.resolve(
          (extras.issuers ?? []).filter((issuer) => !where.id || where.id.in.includes(issuer.id)),
        ),
      ),
    },
  };
}

const decrypt = (value: string) => {
  if (!value.startsWith("enc:")) throw new Error("bad ciphertext");
  return value.slice(4);
};

function request(overrides: Partial<AggregateEarningsRequest> = {}): AggregateEarningsRequest {
  return {
    assets: [ASSET],
    periodStart: "2026-05-01T00:00:00.000Z",
    periodEnd: "2026-06-01T00:00:00.000Z",
    sourceScope: "income",
    roundingIncrement: "1",
    ...overrides,
  };
}

async function reason(promise: Promise<unknown>) {
  const error = await promise.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AggregationPolicyError);
  return (error as AggregationPolicyError).reason;
}

describe("AggregateEarningsCalculator", () => {
  it("queries only the caller's eligible income, half-open and bounded", async () => {
    const prisma = prismaDouble([row("op-1", "10"), row("op-2", "20.5")]);
    const calculator = new AggregateEarningsCalculator(prisma as never, decrypt, "secret");

    const result = await calculator.compute("user_1", request(), NOW);

    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        classification: "INCOME",
        isEligible: true,
        assetCode: "USDC",
        assetIssuer: "GISSUER",
        occurredAt: {
          gte: new Date("2026-05-01T00:00:00.000Z"),
          lt: new Date("2026-06-01T00:00:00.000Z"),
        },
      },
      select: expect.any(Object),
      orderBy: [{ occurredAt: "asc" }, { operationId: "asc" }],
      take: MAX_COMPONENT_PAYMENTS + 1,
    });
    expect(result).toMatchObject({
      disclosedAmount: "30.0000000",
      paymentCount: 2,
      policyVersion: "earnproof.aggregate-earnings.policy.v1",
      sourceScope: "income",
    });
  });

  it("produces the same result and digest for any row order", async () => {
    const rows = [row("op-3", "7.25"), row("op-1", "10"), row("op-2", "20.5")];
    const forward = await new AggregateEarningsCalculator(prismaDouble(rows) as never, decrypt, "secret")
      .compute("user_1", request(), NOW);
    const reversed = await new AggregateEarningsCalculator(
      prismaDouble([...rows].reverse()) as never,
      decrypt,
      "secret",
    ).compute("user_1", request(), NOW);

    expect(reversed).toEqual(forward);
  });

  it("keeps the digest private: keyed, and free of ids and amounts", async () => {
    const rows = [row("op-secret-1", "1234.5"), row("op-secret-2", "10")];
    const a = await new AggregateEarningsCalculator(prismaDouble(rows) as never, decrypt, "secret-a")
      .compute("user_1", request(), NOW);
    const b = await new AggregateEarningsCalculator(prismaDouble(rows) as never, decrypt, "secret-b")
      .compute("user_1", request(), NOW);

    expect(a.inputsDigest).toMatch(/^hmac-sha256:[A-Za-z0-9_-]+$/);
    expect(a.inputsDigest).not.toBe(b.inputsDigest);
    expect(a.inputsDigest).not.toContain("op-secret");
    expect(a.inputsDigest).not.toContain("1234");
  });

  it("changes the digest when a component amount changes", async () => {
    const one = await new AggregateEarningsCalculator(
      prismaDouble([row("op-1", "10"), row("op-2", "20")]) as never,
      decrypt,
      "secret",
    ).compute("user_1", request(), NOW);
    const other = await new AggregateEarningsCalculator(
      prismaDouble([row("op-1", "10"), row("op-2", "20.0000001")]) as never,
      decrypt,
      "secret",
    ).compute("user_1", request(), NOW);

    // Both floor to 30, but the inputs differ, and the audit digest must say so.
    expect(one.disclosedAmount).toBe(other.disclosedAmount);
    expect(one.inputsDigest).not.toBe(other.inputsDigest);
  });

  it("refuses the aggregate when an amount cannot be decrypted", async () => {
    const prisma = prismaDouble([row("op-1", "10"), { ...row("op-2", "5"), amountEncrypted: "garbage" }]);
    expect(
      await reason(new AggregateEarningsCalculator(prisma as never, decrypt, "s").compute("user_1", request(), NOW)),
    ).toBe("amount_unavailable");
  });

  it("refuses a missing ciphertext", async () => {
    const prisma = prismaDouble([row("op-1", "10"), row("op-2", null)]);
    expect(
      await reason(new AggregateEarningsCalculator(prisma as never, decrypt, "s").compute("user_1", request(), NOW)),
    ).toBe("amount_unavailable");
  });

  it("detects more rows than the cap instead of truncating", async () => {
    const rows = Array.from({ length: MAX_COMPONENT_PAYMENTS + 1 }, (_, i) => row(`op-${i}`, "1"));
    expect(
      await reason(
        new AggregateEarningsCalculator(prismaDouble(rows) as never, decrypt, "s").compute("user_1", request(), NOW),
      ),
    ).toBe("limit_exceeded");
  });

  it("validates asset and period before touching the database", async () => {
    const prisma = prismaDouble([]);
    const calculator = new AggregateEarningsCalculator(prisma as never, decrypt, "s");

    expect(
      await reason(calculator.compute("user_1", request({ assets: [ASSET, { code: "XLM", issuer: null }] }), NOW)),
    ).toBe("cross_asset_unsupported");
    expect(
      await reason(calculator.compute("user_1", request({ periodEnd: "2026-06-01T00:00:00.001Z" }), NOW)),
    ).toBe("future_period");
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  describe("source scopes", () => {
    it("restricts to the caller's active trusted sources", async () => {
      const prisma = prismaDouble([row("op-1", "10"), row("op-2", "20")], {
        trusted: ["GSOURCE_B", "GSOURCE_A", "GSOURCE_A"],
      });
      await new AggregateEarningsCalculator(prisma as never, decrypt, "s").compute(
        "user_1",
        request({ sourceScope: "trusted_sources" }),
        NOW,
      );

      expect(prisma.trustedSource.findMany).toHaveBeenCalledWith({
        where: { userId: "user_1", status: "ACTIVE" },
        select: { sourceAddress: true },
      });
      expect(prisma.payment.findMany.mock.calls[0][0].where).toMatchObject({
        userId: "user_1",
        sourceAddress: { in: ["GSOURCE_A", "GSOURCE_B"] },
      });
    });

    it("refuses a trusted-source scope with no trusted sources", async () => {
      const prisma = prismaDouble([row("op-1", "10"), row("op-2", "20")]);
      expect(
        await reason(
          new AggregateEarningsCalculator(prisma as never, decrypt, "s").compute(
            "user_1",
            request({ sourceScope: "trusted_sources" }),
            NOW,
          ),
        ),
      ).toBe("insufficient_payments");
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });

    it("restricts to active registered issuers", async () => {
      const prisma = prismaDouble([row("op-1", "10"), row("op-2", "20")], {
        issuers: [
          { id: "iss_1", stellarAddress: "GISS_1" },
          { id: "iss_2", stellarAddress: "GISS_2" },
        ],
      });
      await new AggregateEarningsCalculator(prisma as never, decrypt, "s").compute(
        "user_1",
        request({ sourceScope: "verified_issuers", issuerIds: ["iss_2"] }),
        NOW,
      );

      expect(prisma.issuer.findMany).toHaveBeenCalledWith({
        where: { status: "ACTIVE", id: { in: ["iss_2"] } },
        select: { id: true, stellarAddress: true },
      });
      expect(prisma.payment.findMany.mock.calls[0][0].where.sourceAddress).toEqual({
        in: ["GISS_2"],
      });
    });

    it("refuses an unknown or inactive issuer", async () => {
      const prisma = prismaDouble([], { issuers: [{ id: "iss_1", stellarAddress: "GISS_1" }] });
      expect(
        await reason(
          new AggregateEarningsCalculator(prisma as never, decrypt, "s").compute(
            "user_1",
            request({ sourceScope: "verified_issuers", issuerIds: ["iss_1", "iss_missing"] }),
            NOW,
          ),
        ),
      ).toBe("invalid_source");
    });
  });
});
