import { ConfigService } from "@nestjs/config";
import { HorizonClient } from "../stellar/horizon-client";
import { StellarService } from "../stellar/stellar.service";
import {
  RecordingSleep,
  ScriptedHorizonTransport,
  loadHorizonFixtures,
} from "../testing/horizon/scripted-horizon-transport";
import { PaymentFinalityService } from "./payment-finality.service";
import { PaymentsService } from "./payments.service";

/**
 * Payment synchronisation driven by scripted Horizon faults.
 *
 * `payments.service.spec.ts` covers the sync logic against a hand-written
 * `fetchIncomingPayments` stub. This file runs the same service against the
 * *real* `StellarService` and the *real* pagination client, with only the
 * transport replaced — so the properties asserted here (a payment is written
 * once no matter how many times Horizon returns it; a memo is consistent for
 * every payment sharing a transaction) hold across the whole path rather than
 * across a mock's return value.
 *
 * Nothing here reaches the network or the clock.
 */

const fixtures = loadHorizonFixtures();
const ACCOUNT = fixtures.account;

const config = {
  getOrThrow: jest.fn((key: string) => {
    const values: Record<string, string> = {
      paymentEncryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      "stellar.horizonUrl": fixtures.horizonUrl,
      "stellar.network": "stellar-testnet",
    };
    return values[key];
  }),
} as unknown as ConfigService;

/** Decodes a stored (encrypted, version-2) memo back to its normalized form. */
function decoded(memo: unknown) {
  return decodeStoredMemo(
    memo as never,
    new PaymentEncryptionKeyringService(config),
  );
}

/** Prisma double recording the writes the sync performs. */
function prismaDouble(existingOperationIds: string[] = []) {
  const upserts: Array<{ operationId: string; memo: unknown }> = [];

  return {
    upserts,
    // No wallet has a checkpoint yet, so every sync here is an initial one.
    // The fixtures' synthetic paging tokens encode no real ledger, so no
    // checkpoint is established and Horizon is never asked for a ledger.
    paymentSyncCheckpoint: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    supportedAsset: {
      findMany: jest.fn().mockResolvedValue([
        { code: "XLM", issuer: null, network: "stellar-testnet" },
        { code: "USDC", issuer: fixtures.assetIssuer, network: "stellar-testnet" },
      ]),
    },
    payment: {
      // syncPayments batches the "does this already exist" check into a
      // single findMany ahead of its loop (see payments.service.ts) rather
      // than one findUnique per incoming payment; the double mirrors that
      // shape by filtering the requested operationIds down to the known set.
      findMany: jest.fn(
        ({ where }: { where: { operationId: { in: string[] } } }) =>
          Promise.resolve(
            where.operationId.in
              .filter((operationId) => existingOperationIds.includes(operationId))
              .map((operationId) => ({ operationId })),
          ),
      ),
      count: jest.fn().mockResolvedValue(0),
      upsert: jest.fn((args: { where: { operationId: string }; create: { memo: unknown } }) => {
        upserts.push({
          operationId: args.where.operationId,
          memo: args.create.memo,
        });
        return Promise.resolve({ id: `payment_${args.where.operationId}` });
      }),
    },
  };
}

/**
 * Builds the real service stack over a scripted Horizon.
 *
 * `fetchTransaction` still uses `fetch` directly — it is outside this issue's
 * scope — so the memo lookups are stubbed at the global, and the assertions
 * below check how many times that happened.
 */
function buildStack(scenarioId: string, memo: unknown = { memo_type: "text", memo: "Invoice 42" }) {
  const transport = new ScriptedHorizonTransport(scenarioId);
  const horizon = new HorizonClient({
    horizonUrl: fixtures.horizonUrl,
    transport,
    sleep: new RecordingSleep().sleep,
  });
  const stellar = new StellarService(config, horizon);

  const transactionFetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => memo,
  });
  global.fetch = transactionFetch as never;

  return { transport, stellar, transactionFetch };
}

/** The real sync and finality services over a Prisma double. */
function syncService(prisma: ReturnType<typeof prismaDouble>, stellar: StellarService) {
  return new PaymentsService(
    prisma as never,
    stellar,
    config,
    // Finality settings are optional; an empty config selects their defaults.
    new PaymentFinalityService(prisma as never, stellar, {
      get: () => undefined,
    } as unknown as ConfigService),
  );
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Payment uniqueness
// ---------------------------------------------------------------------------

describe("payment uniqueness across overlapping pages", () => {
  it("writes each operation once when Horizon replays records", async () => {
    const { stellar } = buildStack("overlapping-pages");
    const prisma = prismaDouble();
    const service = syncService(prisma, stellar);

    const result = await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    // Six records arrived across two pages; two were repeats.
    expect(result.totalFetched).toBe(4);
    expect(prisma.payment.upsert).toHaveBeenCalledTimes(4);

    const operationIds = prisma.upserts.map((upsert) => upsert.operationId);
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it("writes nothing new when a whole page is replayed", async () => {
    const { stellar } = buildStack("fully-replayed-page");
    const prisma = prismaDouble();
    const service = syncService(prisma, stellar);

    const result = await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    expect(result.totalFetched).toBe(2);
    expect(prisma.payment.upsert).toHaveBeenCalledTimes(2);
  });

  it("reports a re-sync as updates rather than creations", async () => {
    // Idempotence is what makes a retried sync safe. The second run must
    // converge on the same rows, not duplicate them.
    const { stellar } = buildStack("single-page");
    const known = ["synthetic-op-000000", "synthetic-op-000001", "synthetic-op-000002"];
    const prisma = prismaDouble(known);
    const service = syncService(prisma, stellar);

    const result = await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    expect(result).toMatchObject({ totalFetched: 3, created: 0, updated: 3 });
  });

  it("skips records for assets that are not supported", async () => {
    const { stellar } = buildStack("single-page");
    const prisma = prismaDouble();
    prisma.supportedAsset.findMany.mockResolvedValue([
      { code: "XLM", issuer: null, network: "stellar-testnet" },
    ]);
    const service = syncService(prisma, stellar);

    const result = await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    // The fixture alternates native and USDC records; only the native ones are
    // eligible once USDC is removed from the supported list.
    expect(result.totalFetched).toBe(3);
    expect(result.skipped).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Memo consistency
// ---------------------------------------------------------------------------

describe("memo consistency", () => {
  it("applies the same normalized memo to every payment in a transaction", async () => {
    const { stellar } = buildStack("single-page");
    const prisma = prismaDouble();
    const service = syncService(prisma, stellar);

    await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    for (const upsert of prisma.upserts) {
      expect(upsert.memo).toMatchObject({ version: 2, type: "text" });
      expect(JSON.stringify(upsert.memo)).not.toContain("Invoice 42");
      expect(decoded(upsert.memo)).toEqual({
        type: "text",
        value: "Invoice 42",
        truncated: false,
      });
    }
  });

  it("looks a transaction up once even when its payments span pages", async () => {
    // The fixture's records each have their own transaction hash, so the cache
    // is exercised by the count matching the distinct hashes rather than the
    // record count.
    const { stellar, transactionFetch } = buildStack("overlapping-pages");
    const prisma = prismaDouble();
    const service = syncService(prisma, stellar);

    await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    expect(transactionFetch).toHaveBeenCalledTimes(4);
  });

  it("normalizes a memo the same way regardless of retries on the page", async () => {
    // The page succeeds only on the third attempt. A memo derived from retry
    // state rather than from the record would differ here.
    const { stellar } = buildStack("server-error-mid-walk");
    const prisma = prismaDouble();
    const service = syncService(prisma, stellar);

    await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    // Each transaction's memo is encrypted with a fresh IV, so the comparison
    // is on the decoded value rather than on the stored ciphertext.
    const memos = prisma.upserts.map((upsert) =>
      JSON.stringify(decoded(upsert.memo)),
    );
    expect(new Set(memos).size).toBe(1);
  });

  it("records an absent memo as type none rather than omitting the field", async () => {
    const { stellar } = buildStack("single-page", { memo_type: "none" });
    const prisma = prismaDouble();
    const service = syncService(prisma, stellar);

    await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    for (const upsert of prisma.upserts) {
      expect(upsert.memo).toEqual({ version: 2, type: "none" });
    }
  });

  it("counts an enrichment failure without abandoning the sync", async () => {
    const { stellar } = buildStack("single-page");
    global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed")) as never;

    const prisma = prismaDouble();
    const service = syncService(prisma, stellar);

    const result = await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    // A memo lookup is enrichment, not the payment itself: losing it must not
    // lose the payment.
    expect(result.enrichmentErrors).toBeGreaterThan(0);
    expect(result.totalFetched).toBe(3);
    expect(prisma.payment.upsert).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Faults surfacing through the sync
// ---------------------------------------------------------------------------

describe("faults reaching the sync", () => {
  it("recovers from a transient Horizon failure without the caller noticing", async () => {
    const { stellar } = buildStack("server-error-then-ok");
    const prisma = prismaDouble();
    const service = syncService(prisma, stellar);

    const result = await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    expect(result.totalFetched).toBe(2);
  });

  it("surfaces an exhausted retry budget as a dependency error", async () => {
    const { stellar } = buildStack("rate-limited-exhausted");
    const prisma = prismaDouble();
    const service = syncService(prisma, stellar);

    await expect(
      service.syncPayments({ id: "user_1", walletAddress: ACCOUNT }),
    ).rejects.toMatchObject({ status: 503 });

    // Nothing partial was written.
    expect(prisma.payment.upsert).not.toHaveBeenCalled();
  });

  it("syncs the valid records from a page that also contained invalid ones", async () => {
    const { stellar } = buildStack("malformed-records");
    const prisma = prismaDouble();
    const service = syncService(prisma, stellar);

    const result = await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    // Six of the eight records are permanently invalid. Dropping the whole page
    // because of them would lose two real payments.
    expect(result.totalFetched).toBe(2);
    expect(prisma.payment.upsert).toHaveBeenCalledTimes(2);
  });

  it("does not write payments addressed to another account", async () => {
    const { stellar } = buildStack("non-payment-records");
    const prisma = prismaDouble();
    const service = syncService(prisma, stellar);

    const result = await service.syncPayments({ id: "user_1", walletAddress: ACCOUNT });

    expect(result.totalFetched).toBe(1);
    expect(prisma.upserts[0].operationId).toBe("synthetic-op-000000");
  });
});
