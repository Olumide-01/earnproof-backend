import { PrismaClient, Prisma, ProofType, WebhookDeliveryStatus } from "@prisma/client";
import { encryptProtectedAmount } from "../../../src/common/crypto/protected-amount";
import {
  buildDelivery,
  buildOrganization,
  buildPayment,
  buildProof,
  buildUser,
  buildWebhook,
  PaymentInput,
  ProofInput,
  UserInput,
  WebhookDeliveryInput,
} from "../../../src/testing/factories";

/**
 * Persistence helpers over the existing synthetic factories.
 *
 * The factories in `src/testing/factories` already produce deterministic,
 * unmistakably-fake values and are the single source of truth for what test
 * data looks like. What they deliberately do *not* do is touch a database, or
 * encrypt anything — `buildPayment` exposes a plaintext `amount` for assertions
 * and refuses to write it, because a factory that wrote plaintext into an
 * encrypted column would train contributors to bypass the privacy boundary.
 *
 * These helpers close that gap for integration tests: they take a built fixture
 * and insert it through the same encryption the application uses, so a row
 * written by a test is indistinguishable from a row written by the service.
 */

/**
 * The key the worker environment configures, as a version-0 keyring. Read
 * lazily so a test may override it. Only PAYMENT_ENCRYPTION_KEY (implicit
 * version 0) is configured in the integration environment, matching what
 * PaymentEncryptionKeyringService resolves to when no versioned
 * PAYMENT_ENCRYPTION_KEY_V* vars are set.
 */
function encryptionKeyring(): Map<number, string> {
  const key = process.env.PAYMENT_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      "PAYMENT_ENCRYPTION_KEY is not set; the integration environment should have defaulted it",
    );
  }
  return new Map([[0, key]]);
}

export async function seedUser(
  prisma: PrismaClient,
  seed: string | number,
  overrides: Partial<UserInput> = {},
) {
  const user = buildUser(seed, overrides);
  return prisma.user.create({
    data: {
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
      status: user.status,
    },
  });
}

export async function seedOrganization(
  prisma: PrismaClient,
  seed: string | number,
  createdById: string,
) {
  const organization = buildOrganization(seed, createdById);
  return prisma.organization.create({
    data: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      website: organization.website,
      status: organization.status,
      createdById,
    },
  });
}

/**
 * Inserts a payment, encrypting the amount on the way in.
 *
 * The plaintext amount is returned alongside the row so a test can assert on it
 * without decrypting, and without the plaintext ever reaching the database.
 */
export async function seedPayment(
  prisma: PrismaClient,
  seed: string | number,
  userId: string,
  overrides: Partial<PaymentInput> = {},
) {
  const payment = buildPayment(seed, userId, overrides);

  const row = await prisma.payment.create({
    data: {
      id: payment.id,
      userId,
      stellarTransactionHash: payment.stellarTransactionHash,
      operationId: payment.operationId,
      sourceAddress: payment.sourceAddress,
      destinationAddress: payment.destinationAddress,
      assetCode: payment.assetCode,
      assetIssuer: payment.assetIssuer,
      amountEncrypted: encryptProtectedAmount(payment.amount, encryptionKeyring(), 0),
      occurredAt: payment.occurredAt,
      classification: payment.classification,
      isEligible: payment.isEligible,
    },
  });

  return { row, amount: payment.amount };
}

/**
 * Seeds an ACTIVE SupportedAsset row for the "testnet" network (the
 * integration environment's configured `STELLAR_NETWORK`).
 *
 * Proof issuance re-validates asset eligibility against this live registry
 * inside the write transaction, so any integration test that issues a proof
 * for a given asset must seed a matching row here first.
 */
export async function seedSupportedAsset(
  prisma: PrismaClient,
  seed: string | number,
  overrides: { code: string; issuer?: string | null; status?: string } = {
    code: "USDC",
  },
) {
  const code = overrides.code;
  const issuer = overrides.issuer ?? null;
  const status = overrides.status ?? "ACTIVE";
  const assetKey = `testnet:${issuer ? "issued" : "native"}:${code}${
    issuer ? `:${issuer}` : ""
  }:${seed}`;

  return prisma.supportedAsset.upsert({
    where: { assetKey },
    create: {
      assetKey,
      code,
      issuer,
      network: "testnet",
      status: status as never,
    },
    update: {
      status: status as never,
    },
  });
}

export async function seedProof(
  prisma: PrismaClient,
  seed: string | number,
  userId: string,
  overrides: Partial<ProofInput> = {},
) {
  const proof = buildProof(seed, userId, overrides);

  return prisma.proof.create({
    data: {
      id: proof.id,
      userId,
      proofType: proof.proofType as ProofType,
      schemaVersion: proof.schemaVersion,
      status: proof.status,
      network: proof.network,
      assetCode: proof.assetCode,
      expiresAt: proof.expiresAt,
      credentialHash: proof.credentialHash,
      contractTransactionHash: proof.contractTransactionHash,
      revokedAt: proof.revokedAt,
    },
  });
}

export async function seedWebhook(
  prisma: PrismaClient,
  seed: string | number,
  organizationId: string,
  events: string[] = ["proof.created", "proof.revoked"],
) {
  const webhook = buildWebhook(seed, organizationId);

  return prisma.webhook.create({
    data: {
      id: webhook.id,
      organizationId,
      url: webhook.url,
      // The application stores the signing secret encrypted, never in plain
      // text, and the delivery worker decrypts it with the same key.
      secretEncrypted: encryptProtectedAmount(webhook.secret, encryptionKeyring(), 0),
      events: events as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function seedDelivery(
  prisma: PrismaClient,
  seed: string | number,
  webhookId: string,
  overrides: Partial<WebhookDeliveryInput> = {},
) {
  const delivery = buildDelivery(seed, webhookId, overrides);

  return prisma.webhookDelivery.create({
    data: {
      id: delivery.id,
      webhookId,
      eventType: delivery.eventType,
      eventId: delivery.eventId,
      payload: delivery.payload as Prisma.InputJsonValue,
      attempt: delivery.attempt,
      status: delivery.status as WebhookDeliveryStatus,
      statusCode: delivery.statusCode,
      failureReason: delivery.failureReason,
      deliveredAt: delivery.deliveredAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Constraint assertions
// ---------------------------------------------------------------------------

/** PostgreSQL unique-violation, as surfaced by Prisma. */
const UNIQUE_VIOLATION = "P2002";

/** PostgreSQL foreign-key violation, as surfaced by Prisma. */
const FOREIGN_KEY_VIOLATION = "P2003";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return errorCode(error) === UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return errorCode(error) === FOREIGN_KEY_VIOLATION;
}

/**
 * The columns PostgreSQL named in a unique violation.
 *
 * Asserting on the target rather than on "some error was thrown" is what makes
 * a constraint test meaningful: without it, a test passes when the write fails
 * for an entirely unrelated reason.
 */
export function violatedTarget(error: unknown): string[] {
  const meta =
    typeof error === "object" && error !== null && "meta" in error
      ? (error as { meta?: { target?: unknown } }).meta
      : undefined;

  const target = meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") return [target];
  return [];
}

/**
 * Partitions settled promises, which is how a concurrency test states its
 * expectation: N writers raced, exactly one committed.
 */
export async function race<T>(
  operations: Array<Promise<T>>,
): Promise<{ fulfilled: Awaited<T>[]; rejected: unknown[] }> {
  const results = await Promise.allSettled(operations);

  const fulfilled: Awaited<T>[] = [];
  const rejected: unknown[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      fulfilled.push(result.value);
    } else {
      rejected.push(result.reason);
    }
  }

  return { fulfilled, rejected };
}

/**
 * Exact row count for every application table.
 *
 * Used to assert that isolation actually happened. The counts must be exact:
 * `pg_stat_user_tables.n_live_tup` is an estimate maintained by the statistics
 * collector, so it lags a `TRUNCATE` and would report a clean database as dirty
 * (or, worse, a dirty one as clean). `query_to_xml` runs a real `count(*)`
 * against each table from a single statement, which keeps this one round trip
 * instead of one per table.
 */
export async function tableCounts(
  prisma: PrismaClient,
): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string; row_count: bigint }>>`
    SELECT relname AS table_name,
           (xpath(
              '/row/count/text()',
              query_to_xml(
                format('SELECT count(*) AS count FROM %I.%I', schemaname, relname),
                false, true, ''
              )
            ))[1]::text::bigint AS row_count
      FROM pg_stat_user_tables
     WHERE schemaname = 'public'
       AND relname <> '_prisma_migrations'
  `;

  return Object.fromEntries(rows.map((row) => [row.table_name, Number(row.row_count)]));
}

/** Names of tables that still hold rows. Empty means the database is clean. */
export async function nonEmptyTables(prisma: PrismaClient): Promise<string[]> {
  const counts = await tableCounts(prisma);
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name]) => name)
    .sort();
}
