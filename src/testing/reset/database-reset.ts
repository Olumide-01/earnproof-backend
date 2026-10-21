import { PrismaClient } from "@prisma/client";

/**
 * Destructive database reset, and the guards that stand in front of it.
 *
 * Seeding writes fabricated rows; a reset removes real ones. The failure mode
 * is therefore worse and irreversible, so the guard here is deliberately
 * stricter than the seed guard in
 * [`scenario.ts`](../factories/scenario.ts): as well as refusing production and
 * refusing an unrecognised host, it requires the operator to name the database
 * they are about to empty.
 *
 * Naming the target is the check that catches the accident the other rules
 * cannot. `NODE_ENV` and the host say what *kind* of environment this is; only
 * the database name says *which* one, and the realistic accident is a correct
 * command aimed at the wrong database — a shell that still holds staging's
 * `DATABASE_URL`, a `.env` loaded from the wrong directory.
 */

/** Raised when a destructive reset is attempted against a protected target. */
export class DestructiveResetRefusedError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to reset the database: ${reason}. ` +
        "Reset is only permitted against a local or disposable database.",
    );
    this.name = "DestructiveResetRefusedError";
  }
}

export interface ResetEnvironment {
  nodeEnv?: string;
  databaseUrl?: string;
  /** Must equal the target database name. The confirmation guard. */
  confirmDatabase?: string;
  /** `"true"` permits a host that is not recognised as local. */
  allowOverride?: string;
}

/** Hosts a disposable database is expected to live on. */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
  "postgres",
  "db",
]);

/**
 * The database name from a connection URL, or `undefined` if there is none.
 *
 * Never returns any other part of the URL: a refusal message built from this
 * must not be able to print the password, which is the mistake that turns a
 * safety message into a credential leak.
 */
export function databaseNameFromUrl(databaseUrl: string): string | undefined {
  try {
    const path = new URL(databaseUrl).pathname.replace(/^\//, "");
    return path === "" ? undefined : decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

/**
 * Decide whether a destructive reset is permitted.
 *
 * Fails closed on every uncertain input, in this order:
 *
 * 1. `NODE_ENV=production` refuses, and no override lifts it.
 * 2. A missing or unparseable `DATABASE_URL` refuses — an unknown target cannot
 *    be a safe one.
 * 3. A database whose name does not contain `test`, `dev` or `local` refuses
 *    unless the host override is set, so a production-shaped name on a laptop
 *    still stops.
 * 4. A host that is not recognised as local refuses unless the override is set.
 * 5. The confirmation must equal the target database name.
 *
 * The confirmation is checked last on purpose: the operator should be told the
 * target is refused outright before being asked to type its name.
 */
export function assertResetAllowed(env: ResetEnvironment): void {
  const nodeEnv = (env.nodeEnv ?? "").trim().toLowerCase();
  if (nodeEnv === "production") {
    throw new DestructiveResetRefusedError("NODE_ENV is production");
  }

  const databaseUrl = (env.databaseUrl ?? "").trim();
  if (databaseUrl === "") {
    throw new DestructiveResetRefusedError("DATABASE_URL is not set");
  }

  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new DestructiveResetRefusedError("DATABASE_URL could not be parsed");
  }

  const databaseName = databaseNameFromUrl(databaseUrl);
  if (!databaseName) {
    throw new DestructiveResetRefusedError("DATABASE_URL names no database");
  }

  const overridden = env.allowOverride === "true";
  const disposableName = /(^|[_-])(test|dev|development|local)([_-]|$)/i.test(
    databaseName,
  );

  if (!disposableName && !overridden) {
    throw new DestructiveResetRefusedError(
      `database "${databaseName}" is not named as a test, dev or local database. ` +
        "Set ALLOW_DESTRUCTIVE_RESET=true to override for a disposable environment",
    );
  }

  if (!LOCAL_HOSTS.has(host) && !overridden) {
    throw new DestructiveResetRefusedError(
      `database host "${host}" is not recognised as local. ` +
        "Set ALLOW_DESTRUCTIVE_RESET=true to override for a disposable environment",
    );
  }

  const confirmation = (env.confirmDatabase ?? "").trim();
  if (confirmation === "") {
    throw new DestructiveResetRefusedError(
      `no confirmation given. Set CONFIRM_RESET="${databaseName}" to proceed`,
    );
  }

  if (confirmation !== databaseName) {
    throw new DestructiveResetRefusedError(
      `confirmation "${confirmation}" does not name the target database`,
    );
  }
}

/** Tables the reset must never touch: Prisma's own migration ledger. */
const PRESERVED_TABLES = new Set(["_prisma_migrations"]);

export interface ResetResult {
  /** Tables emptied, in the order the statement named them. */
  readonly tables: string[];
  /** Rows counted immediately before the truncate, per table. */
  readonly rowsBefore: Record<string, number>;
}

/**
 * Empties every application table.
 *
 * One `TRUNCATE a, b, c CASCADE` rather than a statement per table: the locks
 * are taken in a single step, so it cannot deadlock against itself, and it does
 * not care about foreign-key order — which would otherwise have to be
 * maintained by hand every time a relation is added. This mirrors the
 * integration harness, whose reset is the same shape for the same reasons.
 *
 * The table list is read from the database rather than from `schema.prisma`, so
 * a table added by a migration is emptied without anyone updating this file.
 *
 * Counting before truncating is what makes a partial or unexpected state
 * visible: the caller reports what it destroyed, so a reset that removed far
 * more than expected is noticed at the time rather than during the next
 * investigation.
 */
export async function resetDatabase(
  prisma: PrismaClient,
): Promise<ResetResult> {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  const tables = rows
    .map((row) => row.tablename)
    .filter((name) => !PRESERVED_TABLES.has(name))
    .sort();

  if (tables.length === 0) {
    return { tables: [], rowsBefore: {} };
  }

  const rowsBefore: Record<string, number> = {};
  for (const table of tables) {
    const [{ count }] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "public"."${table}"`,
    );
    rowsBefore[table] = Number(count);
  }

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables
      .map((name) => `"public"."${name}"`)
      .join(", ")} RESTART IDENTITY CASCADE`,
  );

  return { tables, rowsBefore };
}
