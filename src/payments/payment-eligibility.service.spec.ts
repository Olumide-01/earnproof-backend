import { NotFoundException } from "@nestjs/common";
import { PaymentClassification, Prisma } from "@prisma/client";
import { PaymentEligibilityService } from "./payment-eligibility.service";

/**
 * Decision recording, re-evaluation, explanation and concurrency, against an
 * in-memory Prisma that enforces the same one-active-decision unique index as
 * the migration and rolls transactions back on error.
 */

type Row = Record<string, any>;

type Journal = Array<() => void>;

class MemoryPrisma {
  payments: Row[] = [];
  assets: Row[] = [{ code: "USDC", issuer: "GASSET", status: "ACTIVE" }];
  trusted: Row[] = [];
  issuers: Row[] = [];
  decisions: Row[] = [];
  private sequence = 0;
  /** Hook run just before a decision insert, to interleave a competing write. */
  beforeCreate?: () => void;

  readonly payment;
  readonly supportedAsset;
  readonly trustedSource;
  readonly paymentEligibilityDecision;

  constructor() {
    ({
      payment: this.payment,
      supportedAsset: this.supportedAsset,
      trustedSource: this.trustedSource,
      paymentEligibilityDecision: this.paymentEligibilityDecision,
    } = this.models());
  }

  /**
   * Runs `fn` against journaled delegates, so a failure undoes exactly this
   * transaction's writes and leaves concurrent transactions' writes intact,
   * as PostgreSQL does.
   */
  $transaction = async <T>(fn: (tx: ReturnType<MemoryPrisma["models"]>) => Promise<T>): Promise<T> => {
    const journal: Journal = [];
    try {
      return await fn(this.models(journal));
    } catch (error) {
      for (const undo of journal.reverse()) undo();
      throw error;
    }
  };

  active(paymentId: string) {
    return this.decisions.filter((d) => d.paymentId === paymentId && d.isActive === true);
  }

  private models(journal?: Journal) {
    const modify = (row: Row, data: Row) => {
      const previous = { ...row };
      journal?.push(() => {
        for (const key of Object.keys(row)) delete row[key];
        Object.assign(row, previous);
      });
      Object.assign(row, data);
    };

    return {
      payment: {
        findMany: async ({ where, take }: { where: Row; take?: number }) =>
          this.payments
            .filter((p) => matches(p, where))
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .slice(0, take ?? Infinity)
            .map((p) => ({ ...p })),
        findFirst: async ({ where }: { where: Row }) => {
          const found = this.payments.find((p) => matches(p, where));
          return found ? { ...found } : null;
        },
        update: async ({ where, data }: { where: Row; data: Row }) => {
          const row = this.payments.find((p) => p.id === where.id) as Row;
          modify(row, data);
          return row;
        },
      },
      supportedAsset: {
        findMany: async () => this.assets.filter((a) => a.status === "ACTIVE"),
      },
      trustedSource: {
        findMany: async ({ where }: { where: Row }) =>
          this.trusted
            .filter((t) => where.userId.in.includes(t.userId) && t.status === where.status)
            .map((t) => ({
              userId: t.userId,
              sourceAddress: t.sourceAddress,
              issuer: t.issuerId
                ? { status: this.issuers.find((i) => i.id === t.issuerId)?.status }
                : null,
            })),
      },
      paymentEligibilityDecision: {
        findMany: async ({ where, take, orderBy }: { where: Row; take?: number; orderBy?: unknown }) => {
          const rows = this.decisions.filter((d) => matches(d, where));
          if (orderBy) rows.sort((a, b) => b.evaluatedAt - a.evaluatedAt || (a.id < b.id ? 1 : -1));
          return rows.slice(0, take ?? Infinity).map((d) => ({ ...d }));
        },
        findFirst: async ({ where }: { where: Row }) => {
          const found = this.decisions.find((d) => matches(d, where));
          return found ? { ...found } : null;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const rows = this.decisions.filter((d) => matches(d, where));
          rows.forEach((row) => modify(row, data));
          return { count: rows.length };
        },
        create: async ({ data }: { data: Row }) => {
          this.beforeCreate?.();
          if (
            data.isActive === true &&
            this.decisions.some((d) => d.paymentId === data.paymentId && d.isActive === true)
          ) {
            throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
              code: "P2002",
              clientVersion: "test",
            });
          }
          const row = {
            id: `decision_${String(++this.sequence).padStart(4, "0")}`,
            supersededAt: null,
            ...data,
          };
          this.decisions.push(row);
          journal?.push(() => {
            this.decisions = this.decisions.filter((d) => d !== row);
          });
          return row;
        },
      },
    };
  }
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if ("in" in condition) return condition.in.includes(row[key]);
      if ("gt" in condition) return row[key] > condition.gt;
    }
    return (row[key] ?? null) === condition;
  });
}

function payment(id: string, overrides: Row = {}): Row {
  return {
    id,
    userId: "user_1",
    assetCode: "USDC",
    assetIssuer: "GASSET",
    classification: PaymentClassification.INCOME,
    sourceAddress: "GSENDER",
    isEligible: false,
    memo: { type: "text", value: "Salary for Jane Doe" },
    amountEncrypted: "enc:v0:secret",
    ...overrides,
  };
}

function harness(payments: Row[] = [payment("pay_1")]) {
  const prisma = new MemoryPrisma();
  prisma.payments = payments;
  return { prisma, service: new PaymentEligibilityService(prisma as never) };
}

describe("PaymentEligibilityService recording", () => {
  it("records an active decision and mirrors it onto isEligible", async () => {
    const { prisma, service } = harness();

    await expect(service.evaluatePayments("user_1", ["pay_1"], "sync")).resolves.toBe(1);

    const [decision] = prisma.active("pay_1");
    expect(decision).toMatchObject({
      userId: "user_1",
      policyVersion: "payment-eligibility.v1",
      eligible: true,
      reasonCodes: ["ASSET_SUPPORTED", "CLASSIFICATION_INCOME", "SOURCE_NOT_TRUSTED"],
      trigger: "sync",
      isActive: true,
    });
    expect(prisma.payments[0].isEligible).toBe(true);
  });

  it("writes nothing when inputs are unchanged", async () => {
    const { prisma, service } = harness();
    await service.evaluatePayments("user_1", ["pay_1"], "sync");

    await expect(service.evaluatePayments("user_1", ["pay_1"], "sync")).resolves.toBe(0);
    expect(prisma.decisions).toHaveLength(1);
  });

  it("never evaluates another owner's payment", async () => {
    const { prisma, service } = harness([payment("pay_1"), payment("pay_x", { userId: "user_2" })]);

    await expect(service.evaluatePayments("user_1", ["pay_1", "pay_x"], "sync")).resolves.toBe(1);
    expect(prisma.decisions.map((d) => d.paymentId)).toEqual(["pay_1"]);
  });

  it("keeps no memo, amount or counterparty in the decision", async () => {
    const { prisma, service } = harness();
    await service.evaluatePayments("user_1", ["pay_1"], "sync");

    const serialized = JSON.stringify(prisma.decisions);
    expect(serialized).not.toContain("GSENDER");
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("enc:v0");
  });
});

describe("PaymentEligibilityService re-evaluation", () => {
  it("supersedes the decision when the asset policy changes, keeping history", async () => {
    const { prisma, service } = harness();
    await service.evaluatePayments("user_1", ["pay_1"], "sync");

    prisma.assets[0].status = "SUSPENDED";
    const pass = await service.reevaluateBatch({ trigger: "asset_policy_changed" });

    expect(pass).toEqual({ processed: 1, written: 1, nextCursor: null });
    expect(prisma.active("pay_1")).toHaveLength(1);
    expect(prisma.active("pay_1")[0]).toMatchObject({
      eligible: false,
      reasonCodes: expect.arrayContaining(["ASSET_NOT_SUPPORTED"]),
      trigger: "asset_policy_changed",
    });
    expect(prisma.decisions).toHaveLength(2);
    expect(prisma.decisions[0]).toMatchObject({ isActive: null, supersededAt: expect.any(Date) });
    expect(prisma.payments[0].isEligible).toBe(false);
  });

  it("pages through all payments with a resumable cursor", async () => {
    const { service } = harness([payment("pay_1"), payment("pay_2"), payment("pay_3")]);

    const first = await service.reevaluateBatch({ trigger: "policy_migration", limit: 2 });
    const second = await service.reevaluateBatch({
      trigger: "policy_migration",
      limit: 2,
      afterId: first.nextCursor as string,
    });

    expect(first).toEqual({ processed: 2, written: 2, nextCursor: "pay_2" });
    expect(second).toEqual({ processed: 1, written: 1, nextCursor: null });
  });

  it("reflects a classification change", async () => {
    const { prisma, service } = harness();
    await service.evaluatePayments("user_1", ["pay_1"], "sync");

    prisma.payments[0].classification = PaymentClassification.EXCLUDED;
    await service.evaluatePayments("user_1", ["pay_1"], "classification_changed");

    expect(prisma.active("pay_1")[0]).toMatchObject({
      trigger: "classification_changed",
      reasonCodes: ["ASSET_SUPPORTED", "CLASSIFICATION_EXCLUDED", "SOURCE_NOT_TRUSTED"],
    });
  });

  it("re-evaluates only the owner's payments from a changed trusted source", async () => {
    const { prisma, service } = harness([
      payment("pay_1"),
      payment("pay_2", { sourceAddress: "GOTHER" }),
      payment("pay_x", { userId: "user_2" }),
    ]);
    prisma.issuers.push({ id: "iss_1", status: "ACTIVE" });
    prisma.trusted.push({ userId: "user_1", sourceAddress: "GSENDER", status: "ACTIVE", issuerId: "iss_1" });

    await expect(service.reevaluateSource("user_1", "GSENDER")).resolves.toBe(1);

    expect(prisma.active("pay_1")[0]).toMatchObject({
      trigger: "trusted_source_changed",
      reasonCodes: ["ASSET_SUPPORTED", "CLASSIFICATION_INCOME", "SOURCE_TRUSTED", "SOURCE_ISSUER_VERIFIED"],
    });
    expect(prisma.active("pay_2")).toHaveLength(0);
    expect(prisma.active("pay_x")).toHaveLength(0);
  });

  it("drops SOURCE_TRUSTED once the trusted source is deleted", async () => {
    const { prisma, service } = harness();
    prisma.trusted.push({ userId: "user_1", sourceAddress: "GSENDER", status: "ACTIVE" });
    await service.reevaluateSource("user_1", "GSENDER");

    prisma.trusted[0].status = "DELETED";
    await service.reevaluateSource("user_1", "GSENDER");

    expect(prisma.active("pay_1")[0].reasonCodes).toContain("SOURCE_NOT_TRUSTED");
    expect(prisma.decisions).toHaveLength(2);
  });
});

describe("PaymentEligibilityService concurrency", () => {
  it("never leaves two active decisions when evaluations race", async () => {
    const { prisma, service } = harness();

    await Promise.all(
      Array.from({ length: 5 }, () => service.evaluatePayments("user_1", ["pay_1"], "sync")),
    );

    expect(prisma.active("pay_1")).toHaveLength(1);
    expect(prisma.decisions).toHaveLength(1);
  });

  it("treats losing the unique-index race as a no-op and rolls back its writes", async () => {
    const { prisma, service } = harness();
    // A competing evaluation commits an active decision between this one's
    // in-transaction check and its insert.
    prisma.beforeCreate = () => {
      prisma.beforeCreate = undefined;
      prisma.decisions.push({
        id: "decision_winner",
        paymentId: "pay_1",
        userId: "user_1",
        policyVersion: "payment-eligibility.v1",
        isActive: true,
        evaluatedAt: new Date(),
      });
    };

    await expect(service.evaluatePayments("user_1", ["pay_1"], "sync")).resolves.toBe(0);
    expect(prisma.active("pay_1").map((d) => d.id)).toEqual(["decision_winner"]);
    // The loser's isEligible write was rolled back with its transaction.
    expect(prisma.payments[0].isEligible).toBe(false);
  });

  it("rethrows errors other than a unique violation", async () => {
    const { prisma, service } = harness();
    prisma.beforeCreate = () => {
      throw new Error("connection reset");
    };

    await expect(service.evaluatePayments("user_1", ["pay_1"], "sync")).rejects.toThrow("connection reset");
    expect(prisma.decisions).toHaveLength(0);
  });
});

describe("PaymentEligibilityService explanation", () => {
  it("explains the active decision with reasons, usage and history", async () => {
    const { prisma, service } = harness();
    await service.evaluatePayments("user_1", ["pay_1"], "sync");
    prisma.payments[0].classification = PaymentClassification.UNKNOWN;
    await service.evaluatePayments("user_1", ["pay_1"], "classification_changed");

    const explanation = await service.explain("user_1", "pay_1");

    expect(explanation).toMatchObject({
      paymentId: "pay_1",
      eligible: true,
      policyVersion: "payment-eligibility.v1",
      trigger: "classification_changed",
      factors: {
        assetSupported: true,
        classification: "UNKNOWN",
        sourceTrusted: false,
        sourceIssuerVerified: false,
      },
      reasons: [
        { code: "ASSET_SUPPORTED", effect: "allow", message: expect.any(String) },
        { code: "CLASSIFICATION_NOT_INCOME", effect: "info", message: expect.any(String) },
        { code: "SOURCE_NOT_TRUSTED", effect: "info", message: expect.any(String) },
      ],
      usage: { paymentReceipt: true, incomeProofs: false },
    });
    expect(explanation.history.map((h) => h.trigger)).toEqual(["classification_changed", "sync"]);
    expect(explanation.history[1].supersededAt).toBeInstanceOf(Date);
  });

  it("evaluates a legacy payment that has no decision yet", async () => {
    const { prisma, service } = harness();

    const explanation = await service.explain("user_1", "pay_1");

    expect(explanation.trigger).toBe("policy_migration");
    expect(prisma.active("pay_1")).toHaveLength(1);
  });

  it("migrates a decision made under an older policy version", async () => {
    const { prisma, service } = harness();
    prisma.decisions.push({
      id: "decision_legacy",
      paymentId: "pay_1",
      userId: "user_1",
      policyVersion: "payment-eligibility.v0",
      eligible: true,
      factors: { assetSupported: true },
      reasonCodes: ["LEGACY_ASSET_CHECK"],
      inputsHash: "sha256:legacy",
      trigger: "sync",
      evaluatedAt: new Date("2026-01-01T00:00:00.000Z"),
      isActive: true,
    });

    const explanation = await service.explain("user_1", "pay_1");

    expect(explanation.policyVersion).toBe("payment-eligibility.v1");
    expect(explanation.trigger).toBe("policy_migration");
    expect(explanation.history.map((h) => h.policyVersion)).toEqual([
      "payment-eligibility.v1",
      "payment-eligibility.v0",
    ]);
    expect(prisma.decisions.find((d) => d.id === "decision_legacy")).toMatchObject({
      isActive: null,
      supersededAt: expect.any(Date),
    });
  });

  it("answers 404 for another owner's payment without evaluating it", async () => {
    const { prisma, service } = harness([payment("pay_x", { userId: "user_2" })]);

    await expect(service.explain("user_1", "pay_x")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.decisions).toHaveLength(0);
  });

  it("answers 404 for an unknown payment", async () => {
    const { service } = harness([]);
    await expect(service.explain("user_1", "missing")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("does not disclose memo, amount or sender", async () => {
    const { service } = harness();
    const serialized = JSON.stringify(await service.explain("user_1", "pay_1"));

    expect(serialized).not.toContain("GSENDER");
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("enc:v0");
  });
});
