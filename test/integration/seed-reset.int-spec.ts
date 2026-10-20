import { StrKey } from "@stellar/stellar-base";
import { buildDemoScenario } from "../../src/testing/factories/scenario";
import {
  applyDemoScenario,
  describeSeedDrift,
  expectedScenarioCounts,
  readScenarioCounts,
} from "../../src/testing/seed/apply-demo-scenario";
import { resetDatabase } from "../../src/testing/reset/database-reset";
import { integrationDatabase } from "./harness/database";

/**
 * Seed and reset tooling against real PostgreSQL.
 *
 * The unit suite proves the factories are deterministic and that the guards
 * refuse the environments they should. Neither of those touches a database, and
 * the properties that matter most here are properties of the database:
 *
 * - whether the fixtures satisfy the schema's constraints at all;
 * - whether seeding twice converges rather than duplicating or colliding;
 * - whether an interrupted seed leaves a state that is detectable and that a
 *   second run repairs;
 * - whether the reset actually empties everything, including tables added by a
 *   migration that nobody remembered to list.
 *
 * A mocked client answers "yes" to all of these regardless of the truth, which
 * is why this file exists.
 */

const db = integrationDatabase();

/** Tables the reset must leave alone. */
const PRESERVED = "_prisma_migrations";

describe("demo seed", () => {
  it("writes a scenario that satisfies the schema", async () => {
    const scenario = buildDemoScenario("integration");

    const written = await applyDemoScenario(db.prisma, scenario);

    expect(written).toEqual(expectedScenarioCounts(scenario));
    expect(
      describeSeedDrift(
        expectedScenarioCounts(scenario),
        await readScenarioCounts(db.prisma, scenario),
      ),
    ).toEqual([]);
  });

  it("converges when run repeatedly", async () => {
    const scenario = buildDemoScenario("integration");

    await applyDemoScenario(db.prisma, scenario);
    const afterFirst = await snapshot();

    await applyDemoScenario(db.prisma, scenario);
    await applyDemoScenario(db.prisma, scenario);
    const afterThird = await snapshot();

    // Not merely "the same counts": the same rows, with the same identifiers
    // and the same states. A seed that replaced rows with equivalent ones would
    // pass a count check and still make every downstream test order-dependent.
    expect(afterThird).toEqual(afterFirst);
  });

  it("produces the documented state for a given seed", async () => {
    // The scenario is the contract `docs/test-data.md` describes: one of every
    // awkward lifecycle state, so a contributor never hand-builds them.
    const scenario = buildDemoScenario("integration");
    await applyDemoScenario(db.prisma, scenario);

    const proofStatuses = await db.prisma.proof.findMany({
      where: { id: { in: scenario.proofs.map((proof) => proof.id) } },
      select: { status: true },
    });
    const keyStatuses = await db.prisma.apiKey.findMany({
      where: { id: { in: scenario.apiKeys.map((key) => key.id) } },
      select: { status: true, expiresAt: true },
    });

    expect(new Set(proofStatuses.map((row) => row.status))).toEqual(
      new Set(["ACTIVE", "EXPIRED", "REVOKED"]),
    );
    expect(keyStatuses.filter((row) => row.status === "REVOKED")).toHaveLength(1);
    expect(keyStatuses.filter((row) => row.expiresAt !== null)).toHaveLength(1);
  });

  it("satisfies every foreign key in the database, not just in the fixture", async () => {
    const scenario = buildDemoScenario("integration");
    await applyDemoScenario(db.prisma, scenario);

    // Resolved through the relations rather than by comparing ids: this fails
    // if a row was written with an id that happens to look right but does not
    // resolve, which is exactly what a fixture built by hand gets wrong.
    const proofs = await db.prisma.proof.findMany({
      where: { id: { in: scenario.proofs.map((proof) => proof.id) } },
      include: { user: { select: { id: true } } },
    });
    const deliveries = await db.prisma.webhookDelivery.findMany({
      where: { id: { in: scenario.deliveries.map((d) => d.id) } },
      include: { webhook: { select: { organizationId: true } } },
    });
    const intents = await db.prisma.anchoringIntent.findMany({
      where: { id: { in: scenario.anchoringIntents.map((i) => i.id) } },
      include: { proof: { select: { id: true } } },
    });

    expect(proofs.every((proof) => proof.user !== null)).toBe(true);
    expect(deliveries.every((d) => d.webhook.organizationId.length > 0)).toBe(true);
    expect(intents.every((intent) => intent.proof !== null)).toBe(true);
  });

  it("writes no value that could be mistaken for real data", async () => {
    const scenario = buildDemoScenario("integration");
    await applyDemoScenario(db.prisma, scenario);

    const users = await db.prisma.user.findMany({
      where: { id: { in: scenario.users.map((user) => user.id) } },
      select: { walletAddress: true },
    });
    const payments = await db.prisma.payment.findMany({
      where: { id: { in: scenario.payments.map((payment) => payment.id) } },
      select: { sourceAddress: true, amountEncrypted: true },
    });
    const webhooks = await db.prisma.webhook.findMany({
      where: { id: { in: scenario.webhooks.map((webhook) => webhook.id) } },
      select: { url: true },
    });

    for (const { walletAddress } of users) {
      // Stellar-shaped but not a valid address: it fails the checksum, so it
      // can never address a real account, and it carries a grep-able marker so
      // a copy of it in a log or an issue is recognisable as fixture data.
      expect(StrKey.isValidEd25519PublicKey(walletAddress)).toBe(false);
      expect(walletAddress).toContain("SYNTHETIC");
    }

    for (const payment of payments) {
      expect(StrKey.isValidEd25519PublicKey(payment.sourceAddress ?? "")).toBe(false);
      // The plaintext amount is never persisted: the column stays empty rather
      // than being filled with a value that bypasses the encryption boundary.
      expect(payment.amountEncrypted ?? "").toBe("");
    }

    for (const webhook of webhooks) {
      // `.invalid` can never resolve, so a delivery from a seeded webhook
      // cannot reach anything real.
      expect(webhook.url).toMatch(/\.invalid(\/|$)/);
    }
  });
});

describe("partial seed failure", () => {
  it("is detectable, and repaired by re-running", async () => {
    const scenario = buildDemoScenario("integration");
    await applyDemoScenario(db.prisma, scenario);

    // Stands in for a run interrupted after the users and organizations were
    // written: the graph is a prefix of itself, with nothing dangling.
    const removed = scenario.deliveries.map((delivery) => delivery.id);
    await db.prisma.webhookDelivery.deleteMany({ where: { id: { in: removed } } });
    // The expired proof, chosen because no anchoring intent references it: the
    // point of the test is a missing row, not a foreign-key refusal.
    await db.prisma.proof.deleteMany({
      where: { id: scenario.proofs[1].id },
    });

    const drift = describeSeedDrift(
      expectedScenarioCounts(scenario),
      await readScenarioCounts(db.prisma, scenario),
    );

    expect(drift).toEqual([
      "proofs: expected 4, found 3",
      `deliveries: expected ${removed.length}, found 0`,
    ]);

    await applyDemoScenario(db.prisma, scenario);

    expect(
      describeSeedDrift(
        expectedScenarioCounts(scenario),
        await readScenarioCounts(db.prisma, scenario),
      ),
    ).toEqual([]);
  });

  it("does not leave dangling references when a later class fails", async () => {
    const scenario = buildDemoScenario("integration");

    // A proof whose user does not exist is rejected by the database, which is
    // the property that makes an interrupted run safe: the failure is loud, and
    // the rows already written are still consistent.
    await expect(
      applyDemoScenario(db.prisma, {
        ...scenario,
        users: [],
        organizations: [],
      }),
    ).rejects.toThrow();

    expect(await db.prisma.proof.count()).toBe(0);
  });
});

describe("database reset", () => {
  it("empties every application table and reports what it removed", async () => {
    const scenario = buildDemoScenario("integration");
    await applyDemoScenario(db.prisma, scenario);

    const { tables, rowsBefore } = await resetDatabase(db.prisma);

    expect(tables).toContain("User");
    expect(tables).not.toContain(PRESERVED);
    expect(rowsBefore["User"]).toBe(scenario.users.length);

    const counts = await readScenarioCounts(db.prisma, scenario);
    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
  });

  it("leaves the schema and the migration ledger in place", async () => {
    await resetDatabase(db.prisma);

    // Truncate, not drop: the database must be immediately re-seedable, and a
    // reset that lost the migration ledger would make the next `migrate` replay
    // everything against a populated schema.
    const migrations = await db.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "public"."${PRESERVED}"`,
    );

    expect(Number(migrations[0].count)).toBeGreaterThan(0);
  });

  it("is repeatable, and leaves a database that seeds cleanly again", async () => {
    const scenario = buildDemoScenario("integration");
    await applyDemoScenario(db.prisma, scenario);

    await resetDatabase(db.prisma);
    const second = await resetDatabase(db.prisma);

    // The second reset finds nothing, which is what makes the operation safe to
    // retry after an interrupted run.
    expect(Object.values(second.rowsBefore).every((count) => count === 0)).toBe(
      true,
    );

    await applyDemoScenario(db.prisma, scenario);
    expect(
      describeSeedDrift(
        expectedScenarioCounts(scenario),
        await readScenarioCounts(db.prisma, scenario),
      ),
    ).toEqual([]);
  });

  it("covers tables the code never names", async () => {
    // The table list is read from the database rather than from a hand-written
    // constant, so a table added by a migration is emptied without anyone
    // updating the reset. Asserted against the live schema.
    const rows = await db.prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    const expected = rows
      .map((row) => row.tablename)
      .filter((name) => name !== PRESERVED)
      .sort();

    const { tables } = await resetDatabase(db.prisma);

    expect(tables).toEqual(expected);
  });
});

/** Identifier-and-state snapshot of everything the scenario writes. */
async function snapshot() {
  const [users, organizations, issuers, payments, proofs, apiKeys, webhooks, deliveries, intents] =
    await Promise.all([
      db.prisma.user.findMany({
        orderBy: { id: "asc" },
        select: { id: true, walletAddress: true, role: true, status: true },
      }),
      db.prisma.organization.findMany({
        orderBy: { id: "asc" },
        select: { id: true, slug: true, status: true },
      }),
      db.prisma.issuer.findMany({
        orderBy: { id: "asc" },
        select: { id: true, stellarAddress: true, status: true },
      }),
      db.prisma.payment.findMany({
        orderBy: { id: "asc" },
        select: { id: true, userId: true, classification: true, isEligible: true },
      }),
      db.prisma.proof.findMany({
        orderBy: { id: "asc" },
        select: { id: true, userId: true, status: true, credentialHash: true },
      }),
      db.prisma.apiKey.findMany({
        orderBy: { id: "asc" },
        select: { id: true, prefix: true, status: true },
      }),
      db.prisma.webhook.findMany({
        orderBy: { id: "asc" },
        select: { id: true, url: true, events: true },
      }),
      db.prisma.webhookDelivery.findMany({
        orderBy: { id: "asc" },
        select: { id: true, webhookId: true, status: true, attempt: true },
      }),
      db.prisma.anchoringIntent.findMany({
        orderBy: { id: "asc" },
        select: { id: true, proofId: true, operation: true, status: true },
      }),
    ]);

  return {
    users,
    organizations,
    issuers,
    payments,
    proofs,
    apiKeys,
    webhooks,
    deliveries,
    intents,
  };
}
