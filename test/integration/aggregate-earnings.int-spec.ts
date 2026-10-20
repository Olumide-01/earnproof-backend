import { decryptProtectedAmount } from "../../src/common/crypto/protected-amount";
import { AggregateEarningsCalculator } from "../../src/proofs/aggregate-earnings.calculator";
import {
  AggregationPolicyError,
  MAX_COMPONENT_PAYMENTS,
} from "../../src/proofs/aggregate-earnings.policy";
import { integrationDatabase } from "./harness/database";
import { seedOrganization, seedPayment, seedUser } from "./harness/fixtures";

/**
 * Aggregate-earnings selection against real PostgreSQL.
 *
 * The unit suites prove the policy arithmetic. This suite proves the part only
 * a real database can: that the half-open period is enforced by the query at
 * millisecond precision, that another user's rows can never be selected, that
 * source scopes resolve through real issuer and trusted-source rows, and that
 * the result does not depend on physical row order.
 */

const db = integrationDatabase();

const ASSET = { code: "USDC", issuer: "GSYNTHETICASSETISSUER" };
const START = new Date("2026-03-01T00:00:00.000Z");
const END = new Date("2026-04-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");

function calculator() {
  const keyring = new Map([[0, process.env.PAYMENT_ENCRYPTION_KEY as string]]);
  return new AggregateEarningsCalculator(
    db.prisma,
    (value) => decryptProtectedAmount(value, keyring),
    "integration-digest-secret",
  );
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    assets: [ASSET],
    periodStart: START.toISOString(),
    periodEnd: END.toISOString(),
    sourceScope: "income" as const,
    roundingIncrement: "0.0000001" as const,
    ...overrides,
  };
}

async function income(seed: string, userId: string, amount: string, occurredAt: Date, extra = {}) {
  return seedPayment(db.prisma, seed, userId, {
    amount,
    occurredAt,
    assetCode: ASSET.code,
    assetIssuer: ASSET.issuer,
    classification: "INCOME",
    isEligible: true,
    ...extra,
  });
}

async function reason(promise: Promise<unknown>) {
  const error = await promise.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AggregationPolicyError);
  return (error as AggregationPolicyError).reason;
}

describe("aggregate-earnings period boundaries", () => {
  it("includes periodStart and the last millisecond, and excludes periodEnd", async () => {
    const user = await seedUser(db.prisma, "agg-boundary");
    await income("agg-b-start", user.id, "1", START);
    await income("agg-b-last", user.id, "2", new Date(END.getTime() - 1));
    await income("agg-b-end", user.id, "4", END);
    await income("agg-b-before", user.id, "8", new Date(START.getTime() - 1));

    const result = await calculator().compute(user.id, request(), NOW);

    expect(result).toMatchObject({ disclosedAmount: "3.0000000", paymentCount: 2 });
  });

  it("lets consecutive periods partition payments without double counting", async () => {
    const user = await seedUser(db.prisma, "agg-partition");
    const mid = new Date("2026-03-16T00:00:00.000Z");
    // Each half needs at least two payments to be a valid aggregate.
    await income("agg-p-0", user.id, "16", new Date(START.getTime() + 1_000));
    await income("agg-p-1", user.id, "1", START);
    await income("agg-p-2", user.id, "2", mid);
    await income("agg-p-3", user.id, "4", new Date(mid.getTime() + 1));
    await income("agg-p-4", user.id, "8", new Date(END.getTime() - 1));

    const first = await calculator().compute(user.id, request({ periodEnd: mid.toISOString() }), NOW);
    const second = await calculator().compute(user.id, request({ periodStart: mid.toISOString() }), NOW);
    const whole = await calculator().compute(user.id, request(), NOW);

    expect(first.paymentCount + second.paymentCount).toBe(whole.paymentCount);
    expect(Number(first.disclosedAmount) + Number(second.disclosedAmount)).toBe(
      Number(whole.disclosedAmount),
    );
  });
});

describe("aggregate-earnings numeric boundaries", () => {
  it("sums seven-decimal amounts exactly", async () => {
    const user = await seedUser(db.prisma, "agg-exact");
    await income("agg-e-1", user.id, "0.0000001", new Date("2026-03-02T00:00:00.000Z"));
    await income("agg-e-2", user.id, "922337203685.4775807", new Date("2026-03-03T00:00:00.000Z"));

    const result = await calculator().compute(user.id, request(), NOW);

    expect(result.disclosedAmount).toBe("922337203685.4775808");
  });

  it("floors to the requested increment", async () => {
    const user = await seedUser(db.prisma, "agg-floor");
    await income("agg-f-1", user.id, "999.9999999", new Date("2026-03-02T00:00:00.000Z"));
    await income("agg-f-2", user.id, "0.5", new Date("2026-03-03T00:00:00.000Z"));

    const result = await calculator().compute(user.id, request({ roundingIncrement: "100" }), NOW);

    expect(result.disclosedAmount).toBe("1000.0000000");
  });

  it("refuses more payments than the cap rather than truncating", async () => {
    const user = await seedUser(db.prisma, "agg-cap");
    await Promise.all(
      Array.from({ length: MAX_COMPONENT_PAYMENTS + 1 }, (_, i) =>
        income(`agg-cap-${i}`, user.id, "1", new Date(START.getTime() + i * 1000)),
      ),
    );

    expect(await reason(calculator().compute(user.id, request(), NOW))).toBe("limit_exceeded");
  });
});

describe("aggregate-earnings ownership and determinism", () => {
  it("never selects another user's payments", async () => {
    const owner = await seedUser(db.prisma, "agg-owner");
    const other = await seedUser(db.prisma, "agg-other");
    await income("agg-o-1", owner.id, "10", new Date("2026-03-02T00:00:00.000Z"));
    await income("agg-o-2", owner.id, "20", new Date("2026-03-03T00:00:00.000Z"));
    await income("agg-x-1", other.id, "1000", new Date("2026-03-02T00:00:00.000Z"));

    const result = await calculator().compute(owner.id, request(), NOW);

    expect(result).toMatchObject({ disclosedAmount: "30.0000000", paymentCount: 2 });
  });

  it("produces the same result regardless of insertion order", async () => {
    const amounts = ["10.1", "20.02", "30.003", "40.0004"];
    const forwardUser = await seedUser(db.prisma, "agg-forward");
    const reverseUser = await seedUser(db.prisma, "agg-reverse");
    for (const [i, amount] of amounts.entries()) {
      await income(`agg-fw-${i}`, forwardUser.id, amount, new Date("2026-03-10T00:00:00.000Z"));
    }
    for (const [i, amount] of [...amounts.entries()].reverse()) {
      await income(`agg-rv-${i}`, reverseUser.id, amount, new Date("2026-03-10T00:00:00.000Z"));
    }

    const forward = await calculator().compute(forwardUser.id, request(), NOW);
    const reverse = await calculator().compute(reverseUser.id, request(), NOW);

    expect(forward.disclosedAmount).toBe(reverse.disclosedAmount);
    expect(forward.disclosedAmount).toBe("100.1234000");
  });
});

describe("aggregate-earnings source scopes", () => {
  it("resolves verified issuers and trusted sources through real rows", async () => {
    const user = await seedUser(db.prisma, "agg-scope");
    const organization = await seedOrganization(db.prisma, "agg-scope-org", user.id);
    const issuer = await db.prisma.issuer.create({
      data: { organizationId: organization.id, stellarAddress: "GAGGSCOPEISSUER", status: "ACTIVE" },
    });
    await db.prisma.issuer.create({
      data: { organizationId: organization.id, stellarAddress: "GAGGSCOPESUSPENDED", status: "SUSPENDED" },
    });
    await db.prisma.trustedSource.create({
      data: { userId: user.id, sourceAddress: "GAGGSCOPETRUSTED", sourceType: "employer" },
    });

    const day = (d: number) => new Date(Date.UTC(2026, 2, d));
    await income("agg-s-i1", user.id, "100", day(2), { sourceAddress: "GAGGSCOPEISSUER" });
    await income("agg-s-i2", user.id, "200", day(3), { sourceAddress: "GAGGSCOPEISSUER" });
    await income("agg-s-s1", user.id, "400", day(4), { sourceAddress: "GAGGSCOPESUSPENDED" });
    await income("agg-s-t1", user.id, "800", day(5), { sourceAddress: "GAGGSCOPETRUSTED" });
    await income("agg-s-t2", user.id, "1600", day(6), { sourceAddress: "GAGGSCOPETRUSTED" });

    const issuers = await calculator().compute(user.id, request({ sourceScope: "verified_issuers" }), NOW);
    const named = await calculator().compute(
      user.id,
      request({ sourceScope: "verified_issuers", issuerIds: [issuer.id] }),
      NOW,
    );
    const trusted = await calculator().compute(user.id, request({ sourceScope: "trusted_sources" }), NOW);
    const all = await calculator().compute(user.id, request(), NOW);

    expect(issuers.disclosedAmount).toBe("300.0000000");
    expect(named.disclosedAmount).toBe("300.0000000");
    expect(trusted.disclosedAmount).toBe("2400.0000000");
    expect(all.disclosedAmount).toBe("3100.0000000");
  });
});
