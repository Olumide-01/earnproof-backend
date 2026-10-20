import { PaymentAddressCipher } from "../common/crypto/payment-address-cipher";
import { deriveAddressKeys } from "../common/crypto/protected-address";
import { MAX_BACKFILL_BATCH_SIZE, PaymentAddressBackfill } from "./payment-address-backfill";

/**
 * The backfill against an in-memory Prisma that evaluates the where clauses it
 * issues (equality, null, `not`, `startsWith`, `gt`, OR, NOT).
 */

const KEY_V0 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const KEY_V1 = "f".repeat(64);
const V0 = new PaymentAddressCipher(deriveAddressKeys(new Map([[0, KEY_V0]])), 0);
const V1 = new PaymentAddressCipher(
  deriveAddressKeys(
    new Map([
      [0, KEY_V0],
      [1, KEY_V1],
    ]),
  ),
  1,
);

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some((c) => matches(row, c));
    if (key === "NOT") return !matches(row, condition as Row);
    const value = row[key] ?? null;
    if (condition === null) return value === null;
    if (typeof condition === "object") {
      if ("startsWith" in condition) return typeof value === "string" && value.startsWith(condition.startsWith);
      if ("gt" in condition) return value > condition.gt;
      if ("not" in condition) return condition.not === null ? value !== null : value !== condition.not;
    }
    return value === condition;
  });
}

function prismaDouble(rows: Row[]) {
  return {
    rows,
    payment: {
      findMany: jest.fn(async ({ where, take }: { where: Row; take: number }) =>
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, take)
          .map((r) => ({ ...r })),
      ),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      count: jest.fn(async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where)).length),
    },
  };
}

function legacy(id: string): Row {
  return {
    id,
    sourceAddress: `GSOURCE${id.toUpperCase()}`,
    destinationAddress: `GDEST${id.toUpperCase()}`,
    sourceAddressEncrypted: null,
    destinationAddressEncrypted: null,
    sourceAddressLookup: null,
  };
}

describe("PaymentAddressBackfill migration", () => {
  it("encrypts, verifies and clears plaintext, then reports nothing left", async () => {
    const prisma = prismaDouble([legacy("p1"), legacy("p2")]);
    const backfill = new PaymentAddressBackfill(prisma as never, V0);

    const result = await backfill.run();

    expect(result).toMatchObject({ scanned: 2, migrated: 2, failed: 0, nextCursor: null });
    for (const row of prisma.rows) {
      expect(row.sourceAddress).toBeNull();
      expect(row.destinationAddress).toBeNull();
      expect(row.sourceAddressEncrypted).toMatch(/^aenc:v0:/);
      expect(row.sourceAddressLookup).toMatch(/^hmac:v0:/);
    }
    expect(V0.reveal({ encrypted: prisma.rows[0].sourceAddressEncrypted, plaintext: null }, "source")).toBe(
      "GSOURCEP1",
    );
    expect(await backfill.verify()).toEqual({
      plaintextRemaining: 0,
      missingCiphertext: 0,
      staleKeyVersion: 0,
    });
  });

  it("makes rows findable by lookup token", async () => {
    const prisma = prismaDouble([legacy("p1")]);
    await new PaymentAddressBackfill(prisma as never, V0).run();

    expect(V0.sourceLookupTokens("GSOURCEP1")).toContain(prisma.rows[0].sourceAddressLookup);
  });

  it("works in bounded batches and resumes from the cursor", async () => {
    const prisma = prismaDouble(["p1", "p2", "p3", "p4", "p5"].map(legacy));
    const backfill = new PaymentAddressBackfill(prisma as never, V0);

    const first = await backfill.runBatch({ batchSize: 2 });
    expect(first).toMatchObject({ scanned: 2, migrated: 2, nextCursor: "p2" });
    expect(prisma.rows.filter((r) => r.sourceAddress !== null)).toHaveLength(3);

    const second = await backfill.runBatch({ batchSize: 2, afterId: first.nextCursor as string });
    const third = await backfill.runBatch({ batchSize: 2, afterId: second.nextCursor as string });
    expect(third).toMatchObject({ scanned: 1, nextCursor: null });
    expect((await backfill.verify()).plaintextRemaining).toBe(0);
  });

  it("stops after maxBatches and reports where to resume", async () => {
    const prisma = prismaDouble(["p1", "p2", "p3"].map(legacy));
    const result = await new PaymentAddressBackfill(prisma as never, V0).run({ batchSize: 1, maxBatches: 2 });

    expect(result).toMatchObject({ batches: 2, migrated: 2, nextCursor: "p2" });
  });

  it("clamps an oversized batch", async () => {
    const prisma = prismaDouble([]);
    await new PaymentAddressBackfill(prisma as never, V0).runBatch({ batchSize: 1_000_000 });
    expect(prisma.payment.findMany.mock.calls[0][0].take).toBe(MAX_BACKFILL_BATCH_SIZE);
  });

  it("is idempotent: a second run touches nothing", async () => {
    const prisma = prismaDouble([legacy("p1")]);
    const backfill = new PaymentAddressBackfill(prisma as never, V0);
    await backfill.run();
    const snapshot = JSON.stringify(prisma.rows);

    const again = await backfill.run();

    expect(again).toMatchObject({ scanned: 0, migrated: 0 });
    expect(JSON.stringify(prisma.rows)).toBe(snapshot);
  });

  it("completes a row that has ciphertext but still holds plaintext", async () => {
    const row: Row = { ...legacy("p1"), ...V0.protect("GSOURCEP1", "GDESTP1") };
    row.sourceAddress = "GSOURCEP1";
    row.destinationAddress = "GDESTP1";
    const prisma = prismaDouble([row]);

    await new PaymentAddressBackfill(prisma as never, V0).run();

    expect(prisma.rows[0]).toMatchObject({ sourceAddress: null, destinationAddress: null });
  });
});

describe("PaymentAddressBackfill key rotation", () => {
  it("re-protects rows under the new key version and keeps lookups working", async () => {
    const prisma = prismaDouble([legacy("p1")]);
    await new PaymentAddressBackfill(prisma as never, V0).run();
    const oldToken = prisma.rows[0].sourceAddressLookup;

    // Before re-tokening, a v1 reader still finds the row via its v0 token.
    expect(V1.sourceLookupTokens("GSOURCEP1")).toContain(oldToken);

    const rotation = new PaymentAddressBackfill(prisma as never, V1);
    expect((await rotation.verify()).staleKeyVersion).toBe(1);
    expect(await rotation.run()).toMatchObject({ rotated: 1, migrated: 0 });

    expect(prisma.rows[0].sourceAddressEncrypted).toMatch(/^aenc:v1:/);
    expect(prisma.rows[0].sourceAddressLookup).toMatch(/^hmac:v1:/);
    expect(V1.sourceLookupTokens("GSOURCEP1")).toContain(prisma.rows[0].sourceAddressLookup);
    expect(await rotation.verify()).toEqual({ plaintextRemaining: 0, missingCiphertext: 0, staleKeyVersion: 0 });
  });
});

describe("PaymentAddressBackfill failures", () => {
  it("leaves a row with corrupt ciphertext untouched and counts it", async () => {
    const corrupt = {
      ...legacy("p1"),
      sourceAddress: null,
      destinationAddress: null,
      sourceAddressEncrypted: "aenc:v0:AAAA:BBBB:CCCC",
      destinationAddressEncrypted: "aenc:v0:AAAA:BBBB:CCCC",
      sourceAddressLookup: null,
    };
    const prisma = prismaDouble([corrupt, legacy("p2")]);

    const result = await new PaymentAddressBackfill(prisma as never, V0).run();

    expect(result).toMatchObject({ failed: 1, migrated: 1 });
    expect(prisma.rows[0].sourceAddressEncrypted).toBe("aenc:v0:AAAA:BBBB:CCCC");
  });

  it("refuses a row whose plaintext and ciphertext disagree", async () => {
    const row: Row = { ...legacy("p1"), ...V0.protect("GSOMEONEELSE", "GDESTP1") };
    row.sourceAddress = "GSOURCEP1";
    row.destinationAddress = "GDESTP1";
    const prisma = prismaDouble([row]);

    const result = await new PaymentAddressBackfill(prisma as never, V0).run();

    expect(result).toMatchObject({ failed: 1 });
    expect(prisma.rows[0].sourceAddress).toBe("GSOURCEP1");
  });

  it("counts a key version that is no longer loaded as a failure", async () => {
    const row: Row = { ...legacy("p1"), ...V1.protect("GSOURCEP1", "GDESTP1") };
    const prisma = prismaDouble([row]);

    expect(await new PaymentAddressBackfill(prisma as never, V0).run()).toMatchObject({ failed: 1 });
  });

  it("skips a row that changed after it was read", async () => {
    const prisma = prismaDouble([legacy("p1")]);
    const realUpdate = prisma.payment.updateMany.getMockImplementation()!;
    prisma.payment.updateMany.mockImplementationOnce(async (args) => {
      prisma.rows[0].sourceAddress = "GCHANGED"; // a concurrent sync got there first
      return realUpdate(args);
    });

    const result = await new PaymentAddressBackfill(prisma as never, V0).runBatch();

    expect(result).toMatchObject({ skipped: 1, migrated: 0 });
    expect(prisma.rows[0].sourceAddress).toBe("GCHANGED");
  });

  it("returns counts only, never addresses", async () => {
    const prisma = prismaDouble([legacy("p1")]);
    const backfill = new PaymentAddressBackfill(prisma as never, V0);
    const output = JSON.stringify([await backfill.run(), await backfill.verify()]);

    expect(output).not.toContain("GSOURCE");
    expect(output).not.toContain("GDEST");
  });
});
