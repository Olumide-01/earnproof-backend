import { PrismaClient } from "@prisma/client";
import {
  assertSeedAllowed,
  buildDemoScenario,
} from "../src/testing/factories/scenario";
import {
  applyDemoScenario,
  describeSeedDrift,
  expectedScenarioCounts,
  readScenarioCounts,
} from "../src/testing/seed/apply-demo-scenario";

/**
 * Opt-in demo seed.
 *
 * Deliberately separate from `prisma/seed.ts`. That file seeds reference data
 * (supported assets) that every environment legitimately needs; this one writes
 * fabricated users, payments, and proofs, which only a local or disposable
 * environment should ever contain. Keeping them apart means no routine
 * `prisma db seed` can pull demo records in by accident.
 *
 * Run with:
 *   npm run seed:demo
 *
 * Every write is an upsert keyed on a deterministic synthetic id, so re-running
 * converges rather than accumulating duplicates. The run finishes by reading
 * back what is present: a seed interrupted halfway reports the classes that are
 * short rather than exiting quietly, and running it again completes them.
 */
async function main(): Promise<void> {
  // Checked before a client is even constructed: refusing after opening a
  // connection to production would already be later than anyone wants.
  assertSeedAllowed({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    allowOverride: process.env.ALLOW_SYNTHETIC_SEED,
  });

  const prisma = new PrismaClient();
  const scenario = buildDemoScenario("demo");

  try {
    const written = await applyDemoScenario(prisma, scenario);
    console.log("Synthetic demo scenario seeded:", written);

    const drift = describeSeedDrift(
      expectedScenarioCounts(scenario),
      await readScenarioCounts(prisma, scenario),
    );

    if (drift.length > 0) {
      // Reached when rows were removed underneath the seed, or when a previous
      // run failed partway and this one was itself interrupted. Re-running is
      // the repair; exiting non-zero is what stops a script chain continuing on
      // a half-seeded database.
      console.error("Seed is incomplete:");
      for (const line of drift) console.error(`  - ${line}`);
      process.exitCode = 1;
    }

    for (const webhook of scenario.webhooks) {
      await prisma.webhook.upsert({
        where: { id: webhook.id },
        update: { url: webhook.url },
        create: {
          id: webhook.id,
          organizationId: webhook.organizationId,
          url: webhook.url,
          // The schema stores the secret encrypted. The factory's plaintext
          // value is a synthetic placeholder, not a real credential, and is
          // written here only so the column is populated for local use.
          secretEncrypted: webhook.secret,
          events: ["proof.created"],
        },
      });
    }

    for (const delivery of scenario.deliveries) {
      await prisma.webhookDelivery.upsert({
        where: { id: delivery.id },
        update: { status: delivery.status },
        create: {
          id: delivery.id,
          webhookId: delivery.webhookId,
          eventType: delivery.eventType,
          eventId: delivery.eventId,
          payload: delivery.payload as object,
          // Synthetic demo rows: the stored body is what a retry would send.
          schemaVersion: "1",
          payloadBody: JSON.stringify(delivery.payload),
          attempt: delivery.attempt,
          status: delivery.status,
          statusCode: delivery.statusCode,
          failureReason: delivery.failureReason,
          deliveredAt: delivery.deliveredAt,
        },
      });
    }

    const counts = {
      users: scenario.users.length,
      organizations: scenario.organizations.length,
      issuers: scenario.issuers.length,
      payments: scenario.payments.length,
      proofs: scenario.proofs.length,
      webhooks: scenario.webhooks.length,
      deliveries: scenario.deliveries.length,
    };

    console.log("Synthetic demo scenario seeded:", counts);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
