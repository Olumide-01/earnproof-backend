import { PrismaClient, Prisma, ProofType, ProofStatus } from "@prisma/client";
import { encryptProtectedAmount } from "../../../src/common/crypto/protected-amount";
import {
  syntheticAmount,
  syntheticCredentialHash,
  syntheticDate,
  syntheticSlug,
  syntheticTransactionHash,
  syntheticWalletAddress,
  syntheticWalletHash,
} from "../../../src/testing/factories/synthetic";

/**
 * Scale fixtures for the performance suite.
 *
 * The integration harness (`test/integration/harness/fixtures.ts`) inserts a
 * handful of rows per test with `prisma.create`, which is the right tool for
 * behavioural assertions. It is the wrong tool here: a query-plan regression
 * — a missing index, an unbounded scan, an N+1 loop — is invisible on a
 * near-empty table because PostgreSQL's planner reasonably prefers a
 * sequential scan when there is nothing to skip. These fixtures exist to
 * make the planner's choice mean something.
 *
 * Design:
 *
 * - **Skewed tenant distribution.** A handful of "heavy" users hold a
 *   disproportionate share of the rows (the pattern a real payroll or
 *   marketplace integration produces), the rest hold a small, varying
 *   amount. A uniform distribution would hide a missing composite index:
 *   `WHERE userId = ? ORDER BY occurredAt` scans fine on a table where every
 *   user has ~40 rows, and only misbehaves once one user has thousands.
 * - **Deep pagination.** Heavy users get enough rows that a page at
 *   offset/cursor depth (the 40th page of 20, say) is a real query against
 *   real intermediate rows, not a one-page table.
 * - **Bulk insert.** `createMany` (backed by multi-row `INSERT`) rather than
 *   a loop of `prisma.create` — seeding thousands of rows through the ORM's
 *   per-call overhead would make the fixture setup itself the slow part of
 *   the suite.
 * - **Synthetic-only values.** Every identifier and address comes from
 *   `src/testing/factories/synthetic.ts`, the same deterministic,
 *   obviously-fake generator the integration suite and demo seed use. No
 *   field here can collide with, or be mistaken for, real user data.
 *
 * Determinism: every builder is seeded from its row index, so the same scale
 * factors always produce byte-identical fixtures. That is what lets the
 * budgets in `budgets.ts` cite an observed baseline — the baseline was
 * measured against exactly this data, not against whatever a random run
 * happened to generate.
 */

export interface ScaleFactors {
  /** Number of organizations (tenants) to create. */
  organizationCount: number;
  /** Number of regular users, spread evenly across organizations via issuers/attestations. */
  regularUserCount: number;
  /** Number of "heavy" users that receive a large, deep-pagination-worthy row count. */
  heavyUserCount: number;
  /** Payments per regular user. */
  paymentsPerRegularUser: number;
  /** Payments per heavy user — sized so offset pagination reaches real depth. */
  paymentsPerHeavyUser: number;
  /** Proofs per regular user. */
  proofsPerRegularUser: number;
  /** Proofs per heavy user. */
  proofsPerHeavyUser: number;
  /** Auth sessions per user (mix of active/expired/revoked). */
  sessionsPerUser: number;
  /** Wallet challenges seeded, split across expired/used/live. */
  walletChallengeCount: number;
  /** Pending webhook deliveries seeded for the retry-sweep job query. */
  pendingWebhookDeliveries: number;
}

/**
 * Default scale.
 *
 * ~4k users, ~180k payments, ~50k proofs, ~40k sessions. Large enough that a
 * missing index produces a sequential scan the planner visibly avoids when
 * the index exists (see `docs/database-performance.md` for the observed
 * plan shapes this was tuned against), small enough that seeding the whole
 * fixture set completes in low single-digit seconds on a local database.
 */
export const DEFAULT_SCALE: ScaleFactors = {
  organizationCount: 25,
  regularUserCount: 4_000,
  heavyUserCount: 5,
  paymentsPerRegularUser: 40,
  paymentsPerHeavyUser: 6_000,
  proofsPerRegularUser: 8,
  proofsPerHeavyUser: 1_200,
  sessionsPerUser: 2,
  walletChallengeCount: 10_000,
  pendingWebhookDeliveries: 5_000,
}
;

/** A reduced scale for fast local iteration; still deep enough to exercise pagination. */
export const SMOKE_SCALE: ScaleFactors = {
  organizationCount: 5,
  regularUserCount: 300,
  heavyUserCount: 2,
  paymentsPerRegularUser: 15,
  paymentsPerHeavyUser: 500,
  proofsPerRegularUser: 4,
  proofsPerHeavyUser: 150,
  sessionsPerUser: 2,
  walletChallengeCount: 800,
  pendingWebhookDeliveries: 400,
};

export interface ScaleFixture {
  /** userId of a heavy user, guaranteed to have deep pagination available. */
  heavyUserIds: string[];
  /** userId of a lightly-loaded user, for contrast assertions. */
  regularUserIds: string[];
  organizationIds: string[];
}

const ENCRYPTION_KEY_FALLBACK =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

function encryptionKey(): string {
  return process.env.PAYMENT_ENCRYPTION_KEY ?? ENCRYPTION_KEY_FALLBACK;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Batches `createMany` calls; PostgreSQL parameter limits make one giant insert unsafe. */
async function insertInBatches<T>(
  rows: T[],
  batchSize: number,
  insert: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (const batch of chunk(rows, batchSize)) {
    await insert(batch);
  }
}

/**
 * Populates the current database with scale fixtures.
 *
 * Assumes an empty (or already-truncated) database; the performance harness
 * truncates before seeding, matching the integration harness's per-test
 * isolation model.
 */
export async function seedScaleFixture(
  prisma: PrismaClient,
  scale: ScaleFactors = DEFAULT_SCALE,
): Promise<ScaleFixture> {
  const key = encryptionKey();

  // ---------------------------------------------------------------------
  // Organizations (tenants) and the admin users that create them.
  // ---------------------------------------------------------------------
  const orgOwnerIds: string[] = [];
  const organizationRows: Prisma.OrganizationCreateManyInput[] = [];
  const orgOwnerRows: Prisma.UserCreateManyInput[] = [];

  for (let i = 0; i < scale.organizationCount; i += 1) {
    const ownerId = `synthetic_perf_org_owner_${i}`;
    orgOwnerIds.push(ownerId);
    orgOwnerRows.push({
      id: ownerId,
      walletAddress: syntheticWalletAddress(`perf-org-owner-${i}`),
      walletHash: syntheticWalletHash(`perf-org-owner-${i}`),
      role: "ISSUER",
      status: "ACTIVE",
    });
    organizationRows.push({
      id: `synthetic_perf_org_${i}`,
      name: `Synthetic Perf Org ${i}`,
      slug: syntheticSlug(`perf-org-${i}`),
      website: null,
      status: "ACTIVE",
      createdById: ownerId,
    });
  }

  await prisma.user.createMany({ data: orgOwnerRows });
  await prisma.organization.createMany({ data: organizationRows });
  const organizationIds = organizationRows.map((row) => row.id as string);

  // ---------------------------------------------------------------------
  // Users: heavy (whale) users plus a large pool of regular users, assigned
  // round-robin across organizations by index so tenant distribution is
  // skewed exactly like a real deployment — a few big tenants' users mixed
  // among many small ones, rather than one row per tenant.
  // ---------------------------------------------------------------------
  const heavyUserIds: string[] = [];
  const regularUserIds: string[] = [];
  const userRows: Prisma.UserCreateManyInput[] = [];

  for (let i = 0; i < scale.heavyUserCount; i += 1) {
    const id = `synthetic_perf_heavy_user_${i}`;
    heavyUserIds.push(id);
    userRows.push({
      id,
      walletAddress: syntheticWalletAddress(`perf-heavy-${i}`),
      walletHash: syntheticWalletHash(`perf-heavy-${i}`),
      role: "WORKER",
      status: "ACTIVE",
    });
  }

  for (let i = 0; i < scale.regularUserCount; i += 1) {
    const id = `synthetic_perf_regular_user_${i}`;
    regularUserIds.push(id);
    userRows.push({
      id,
      walletAddress: syntheticWalletAddress(`perf-regular-${i}`),
      walletHash: syntheticWalletHash(`perf-regular-${i}`),
      role: "WORKER",
      status: "ACTIVE",
    });
  }

  await insertInBatches(userRows, 1_000, (batch) =>
    prisma.user.createMany({ data: batch }),
  );

  // ---------------------------------------------------------------------
  // Payments — the bulk of the row volume, and what pagination-depth queries
  // (payments.service.ts#listPayments) run against.
  // ---------------------------------------------------------------------
  const paymentRows: Prisma.PaymentCreateManyInput[] = [];

  const buildPaymentRows = (
    userId: string,
    count: number,
    namespace: string,
  ) => {
    for (let i = 0; i < count; i += 1) {
      const seed = `${namespace}-${i}`;
      paymentRows.push({
        id: `synthetic_perf_payment_${namespace}_${i}`,
        userId,
        stellarTransactionHash: syntheticTransactionHash(seed),
        operationId: `synthetic-perf-op-${namespace}-${i}`,
        sourceAddress: syntheticWalletAddress(`src-${seed}`),
        destinationAddress: syntheticWalletAddress(`dst-${seed}`),
        assetCode: i % 5 === 0 ? "XLM" : "USDC",
        assetIssuer: syntheticWalletAddress(`asset-${seed}`),
        amountEncrypted: encryptProtectedAmount(syntheticAmount(seed), new Map([[0, key]]), 0),
        // Spread over ~2 years so ORDER BY occurredAt DESC has real variety.
        occurredAt: syntheticDate(-(i % 730)),
        classification: i % 4 === 0 ? "INCOME" : "UNKNOWN",
        isEligible: i % 4 === 0,
      });
    }
  };

  heavyUserIds.forEach((userId, index) =>
    buildPaymentRows(userId, scale.paymentsPerHeavyUser, `heavy-${index}`),
  );
  regularUserIds.forEach((userId, index) =>
    buildPaymentRows(userId, scale.paymentsPerRegularUser, `regular-${index}`),
  );

  await insertInBatches(paymentRows, 5_000, (batch) =>
    prisma.payment.createMany({ data: batch }),
  );

  // ---------------------------------------------------------------------
  // Proofs — cursor-paginated list query (proofs.service.ts#listProofs).
  // ---------------------------------------------------------------------
  const proofRows: Prisma.ProofCreateManyInput[] = [];
  const proofTypes: ProofType[] = [
    "MINIMUM_INCOME",
    "RECURRING_INCOME",
    "PAYMENT_RECEIPT",
  ];

  const buildProofRows = (userId: string, count: number, namespace: string) => {
    for (let i = 0; i < count; i += 1) {
      const seed = `${namespace}-${i}`;
      const status: ProofStatus = i % 11 === 0 ? "REVOKED" : "ACTIVE";
      proofRows.push({
        id: `synthetic_perf_proof_${namespace}_${i}`,
        userId,
        proofType: proofTypes[i % proofTypes.length],
        schemaVersion: "1.0.0",
        status,
        network: "stellar-testnet",
        assetCode: "USDC",
        expiresAt: syntheticDate(90),
        credentialHash: syntheticCredentialHash(`perf-${seed}`),
        contractTransactionHash: syntheticTransactionHash(`perf-anchor-${seed}`),
        revokedAt: status === "REVOKED" ? syntheticDate(-1) : null,
        createdAt: syntheticDate(-(i % 730)),
      });
    }
  };

  heavyUserIds.forEach((userId, index) =>
    buildProofRows(userId, scale.proofsPerHeavyUser, `heavy-${index}`),
  );
  regularUserIds.forEach((userId, index) =>
    buildProofRows(userId, scale.proofsPerRegularUser, `regular-${index}`),
  );

  await insertInBatches(proofRows, 5_000, (batch) =>
    prisma.proof.createMany({ data: batch }),
  );

  // ---------------------------------------------------------------------
  // Auth sessions — session.service.ts#validate looks up by tokenHash.
  // ---------------------------------------------------------------------
  const sessionRows: Prisma.AuthSessionCreateManyInput[] = [];
  const allUserIds = [...heavyUserIds, ...regularUserIds];

  allUserIds.forEach((userId, userIndex) => {
    for (let i = 0; i < scale.sessionsPerUser; i += 1) {
      const seed = `${userIndex}-${i}`;
      const expired = i % 3 === 0;
      sessionRows.push({
        id: `synthetic_perf_session_${seed}`,
        tokenHash: `sha256:synthetic-perf-session-${seed}`,
        userId,
        expiresAt: expired ? syntheticDate(-1) : syntheticDate(30),
        revokedAt: i % 5 === 0 ? syntheticDate(-2) : null,
      });
    }
  });

  await insertInBatches(sessionRows, 5_000, (batch) =>
    prisma.authSession.createMany({ data: batch }),
  );

  // ---------------------------------------------------------------------
  // Wallet challenges — auth.service.ts challenge lookup by walletAddress,
  // and cleanup.job.ts's expiry sweep.
  // ---------------------------------------------------------------------
  const challengeRows: Prisma.WalletChallengeCreateManyInput[] = [];
  for (let i = 0; i < scale.walletChallengeCount; i += 1) {
    const seed = `challenge-${i}`;
    const isExpired = i % 3 === 0;
    const isUsed = i % 3 === 1;
    challengeRows.push({
      id: `synthetic_perf_challenge_${i}`,
      walletAddress: syntheticWalletAddress(seed),
      nonceHash: `sha256:synthetic-perf-nonce-${i}`,
      message: `Synthetic challenge message ${i}`,
      expiresAt: isExpired ? syntheticDate(-1) : syntheticDate(1),
      usedAt: isUsed ? syntheticDate(-1) : null,
    });
  }

  await insertInBatches(challengeRows, 5_000, (batch) =>
    prisma.walletChallenge.createMany({ data: batch }),
  );

  // ---------------------------------------------------------------------
  // Webhooks + pending deliveries — webhook-delivery.service.ts#onModuleInit
  // sweeps `status = PENDING` at startup; this is the "job" query fixture.
  // ---------------------------------------------------------------------
  const webhookRows: Prisma.WebhookCreateManyInput[] = organizationIds.map(
    (organizationId, index) => ({
      id: `synthetic_perf_webhook_${index}`,
      organizationId,
      url: `https://synthetic-perf-${index}.example.invalid/hooks`,
      secretEncrypted: encryptProtectedAmount(
        `synthetic-perf-secret-${index}`,
        new Map([[0, key]]),
        0,
      ),
      events: ["proof.created", "proof.revoked"] as unknown as Prisma.InputJsonValue,
    }),
  );
  await prisma.webhook.createMany({ data: webhookRows });

  const deliveryRows: Prisma.WebhookDeliveryCreateManyInput[] = [];
  for (let i = 0; i < scale.pendingWebhookDeliveries; i += 1) {
    const webhookRow = webhookRows[i % webhookRows.length];
    if (!webhookRow) continue;
    const webhookId = webhookRow.id as string;
    deliveryRows.push({
      id: `synthetic_perf_delivery_${i}`,
      webhookId,
      eventType: "proof.created",
      eventId: `synthetic_perf_event_${i}`,
      payload: { synthetic: true, seed: i } as unknown as Prisma.InputJsonValue,
      attempt: (i % 5) + 1,
      status: "PENDING",
      nextRetryAt: syntheticDate(i % 7),
    });
  }
  await insertInBatches(deliveryRows, 5_000, (batch) =>
    prisma.webhookDelivery.createMany({ data: batch }),
  );

  return { heavyUserIds, regularUserIds, organizationIds };
}
