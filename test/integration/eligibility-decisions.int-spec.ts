import { PaymentEligibilityService } from "../../src/payments/payment-eligibility.service";
import { integrationDatabase } from "./harness/database";
import { seedPayment, seedUser } from "./harness/fixtures";

/**
 * Payment eligibility decisions against real PostgreSQL.
 *
 * The unit suite proves the service's logic against a double. Only a real
 * database can prove the guarantee the issue asks for: that concurrent
 * re-evaluation cannot leave two active decisions for one payment, because
 * the database itself refuses the second one.
 */

const db = integrationDatabase();

async function seedEligiblePayment(seed: string) {
  const user = await seedUser(db.prisma, `${seed}-user`);
  const payment = await seedPayment(db.prisma, seed, user.id, { isEligible: false });
  const asset = await db.prisma.supportedAsset.create({
    data: {
      assetKey: `${payment.row.assetCode}:${payment.row.assetIssuer}`,
      code: payment.row.assetCode,
      issuer: payment.row.assetIssuer,
      network: "testnet",
      status: "ACTIVE",
    },
  });
  return { user, payment: payment.row, asset };
}

function service() {
  return new PaymentEligibilityService(db.prisma as never);
}

function decisionData(paymentId: string, userId: string, isActive: boolean | null) {
  return {
    paymentId,
    userId,
    policyVersion: "payment-eligibility.v1",
    eligible: true,
    factors: {},
    reasonCodes: ["ASSET_SUPPORTED"],
    inputsHash: `sha256:${Math.random()}`,
    trigger: "sync",
    evaluatedAt: new Date(),
    isActive,
  };
}

describe("one active decision per payment", () => {
  it("is enforced by the database, not only by the service", async () => {
    const { user, payment } = await seedEligiblePayment("elig-unique");
    await db.prisma.paymentEligibilityDecision.create({ data: decisionData(payment.id, user.id, true) });

    await expect(
      db.prisma.paymentEligibilityDecision.create({ data: decisionData(payment.id, user.id, true) }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Superseded decisions (NULL) never collide, so history can grow.
    await db.prisma.paymentEligibilityDecision.create({ data: decisionData(payment.id, user.id, null) });
    await db.prisma.paymentEligibilityDecision.create({ data: decisionData(payment.id, user.id, null) });
    expect(await db.prisma.paymentEligibilityDecision.count({ where: { paymentId: payment.id } })).toBe(3);
  });

  it("refuses isActive = false, which would defeat the unique index", async () => {
    const { user, payment } = await seedEligiblePayment("elig-check");

    await expect(
      db.prisma.paymentEligibilityDecision.create({ data: decisionData(payment.id, user.id, false) }),
    ).rejects.toThrow();
  });

  it("leaves exactly one active decision after concurrent re-evaluations", async () => {
    const { user, payment } = await seedEligiblePayment("elig-race");

    await Promise.all(
      Array.from({ length: 8 }, () => service().evaluatePayments(user.id, [payment.id], "sync")),
    );

    expect(
      await db.prisma.paymentEligibilityDecision.count({
        where: { paymentId: payment.id, isActive: true },
      }),
    ).toBe(1);
  });
});

describe("decision history", () => {
  it("keeps superseded decisions auditable after an asset policy change", async () => {
    const { user, payment, asset } = await seedEligiblePayment("elig-history");
    await service().evaluatePayments(user.id, [payment.id], "sync");
    expect((await db.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).isEligible).toBe(true);

    await db.prisma.supportedAsset.update({ where: { id: asset.id }, data: { status: "SUSPENDED" } });
    let cursor: string | null | undefined;
    do {
      const pass = await service().reevaluateBatch({
        trigger: "asset_policy_changed",
        afterId: cursor ?? undefined,
      });
      cursor = pass.nextCursor;
    } while (cursor);

    const decisions = await db.prisma.paymentEligibilityDecision.findMany({
      where: { paymentId: payment.id },
      orderBy: { evaluatedAt: "asc" },
    });
    expect(decisions.map((d) => [d.eligible, d.isActive, d.trigger])).toEqual([
      [true, null, "sync"],
      [false, true, "asset_policy_changed"],
    ]);
    expect(decisions[0].supersededAt).not.toBeNull();
    expect((await db.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).isEligible).toBe(false);
  });

  it("migrates a legacy payment on first explanation and scopes it to the owner", async () => {
    const { user, payment } = await seedEligiblePayment("elig-explain");
    const stranger = await seedUser(db.prisma, "elig-stranger");

    await expect(service().explain(stranger.id, payment.id)).rejects.toMatchObject({ status: 404 });
    expect(await db.prisma.paymentEligibilityDecision.count()).toBe(0);

    const explanation = await service().explain(user.id, payment.id);
    expect(explanation).toMatchObject({
      eligible: true,
      policyVersion: "payment-eligibility.v1",
      trigger: "policy_migration",
    });
    expect(JSON.stringify(explanation)).not.toContain(payment.sourceAddress);
  });
});
