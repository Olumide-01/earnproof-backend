import { openAdminConnection } from "./admin";
import { integrationConfig } from "./config";
import { applyMigrations, migrationDirectoryNames } from "./migrate";
import { PrismaClient } from "@prisma/client";
import { withDeadline } from "./bounded";

/**
 * Builds the template database, once per run, before any worker starts.
 *
 * The template is dropped and recreated rather than reused. Reuse would make
 * the suite depend on the state a previous run happened to leave behind — the
 * exact non-determinism this harness exists to remove — and would hide a
 * migration that only applies cleanly to a database that already has the
 * previous version of the schema.
 */
export default async function globalSetup(): Promise<void> {
  const config = integrationConfig();
  const started = Date.now();

  const admin = await openAdminConnection(config);

  try {
    // Any worker database left by an interrupted run holds a session on the
    // template and would block the clone below.
    for (const stale of await admin.listDatabases(config.workerPrefix)) {
      await admin.drop(stale);
    }

    await admin.drop(config.templateName);
    await admin.create(config.templateName);
  } finally {
    await admin.close();
  }

  await applyMigrations(config.templateUrl, config);
  await assertMigrationsRecorded(config.templateUrl, config.adminTimeoutMs);

  process.stdout.write(
    `\nIntegration harness: template database migrated in ${Date.now() - started}ms ` +
      `(${migrationDirectoryNames().length} migrations)\n`,
  );
}

/**
 * Confirms the ledger records every migration as finished.
 *
 * `migrate deploy` exits 0 when there is nothing to do, so a misconfigured
 * migrations directory — empty, or pointed at the wrong path — produces a
 * successful command against an empty database. Checking the ledger turns that
 * into a failure at setup instead of a hundred "relation does not exist" errors
 * in unrelated tests.
 */
async function assertMigrationsRecorded(
  templateUrl: string,
  timeoutMs: number,
): Promise<void> {
  const expected = migrationDirectoryNames();
  const client = new PrismaClient({ datasourceUrl: templateUrl });

  try {
    await withDeadline("Connecting to the template database", timeoutMs, () =>
      client.$connect(),
    );

    const rows = await withDeadline(
      "Reading the migration ledger",
      timeoutMs,
      () =>
        client.$queryRaw<Array<{ migration_name: string }>>`
          SELECT migration_name
            FROM _prisma_migrations
           WHERE finished_at IS NOT NULL
             AND rolled_back_at IS NULL
        `,
    );

    const applied = new Set(
      (rows as Array<{ migration_name: string }>).map((row) => row.migration_name),
    );
    const missing = expected.filter((name) => !applied.has(name));

    if (missing.length > 0) {
      throw new Error(
        `prisma migrate deploy reported success but ${missing.length} migration(s) ` +
          `are not recorded as applied: ${missing.join(", ")}`,
      );
    }
  } finally {
    await withDeadline("Disconnecting from the template database", timeoutMs, () =>
      client.$disconnect(),
    );
  }
}
