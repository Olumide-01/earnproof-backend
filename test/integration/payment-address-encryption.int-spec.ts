import { PaymentAddressCipher } from "../../src/common/crypto/payment-address-cipher";
import { deriveAddressKeys } from "../../src/common/crypto/protected-address";
import { PaymentAddressBackfill } from "../../src/payments/payment-address-backfill";
import { integrationDatabase } from "./harness/database";
import { seedPayment, seedUser } from "./harness/fixtures";

/**
 * Payment address encryption against real PostgreSQL.
 *
 * The fixture factory writes plaintext addresses, so every seeded payment is a
 * legacy row: exactly what the backfill must migrate. These tests prove, on the
 * real schema, that plaintext is gone afterwards, that equality lookups work
 * through the token index, that key rotation keeps them working, and that a
 * corrupt row is left alone.
 */

const db = integrationDatabase();

const ROTATED_KEY = "e".repeat(64);

function cipher(version: 0 | 1 = 0) {
  const roots = new Map<number, string>([[0, process.env.PAYMENT_ENCRYPTION_KEY as string]]);
  if (version === 1) roots.set(1, ROTATED_KEY);
  return new PaymentAddressCipher(deriveAddressKeys(roots), version);
}

async function seedLegacy(seed: string, userId: string, sourceAddress?: string) {
  const payment = await seedPayment(db.prisma, seed, userId, sourceAddress ? { sourceAddress } : {});
  return payment.row;
}

async function plaintextRows(): Promise<number> {
  const [{ count }] = await db.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*)::bigint AS count FROM "Payment" WHERE "sourceAddress" IS NOT NULL OR "destinationAddress" IS NOT NULL`,
  );
  return Number(count);
}

describe("address backfill on the real schema", () => {
  it("removes plaintext only after writing verified ciphertext", async () => {
    const user = await seedUser(db.prisma, "addr-migrate");
    const rows = await Promise.all(["a", "b", "c"].map((s) => seedLegacy(`addr-migrate-${s}`, user.id)));
    expect(await plaintextRows()).toBe(3);

    const backfill = new PaymentAddressBackfill(db.prisma, cipher());
    const run = await backfill.run({ batchSize: 2 });

    expect(run).toMatchObject({ migrated: 3, failed: 0 });
    expect(await plaintextRows()).toBe(0);
    expect(await backfill.verify()).toEqual({ plaintextRemaining: 0, missingCiphertext: 0, staleKeyVersion: 0 });

    const stored = await db.prisma.payment.findUniqueOrThrow({ where: { id: rows[0].id } });
    expect(stored.sourceAddressEncrypted).toMatch(/^aenc:v0:/);
    expect(
      cipher().reveal({ encrypted: stored.sourceAddressEncrypted, plaintext: null }, "source"),
    ).toBe(rows[0].sourceAddress);
    expect(
      cipher().reveal({ encrypted: stored.destinationAddressEncrypted, plaintext: null }, "destination"),
    ).toBe(rows[0].destinationAddress);
  });

  it("leaves no plaintext address anywhere in the row", async () => {
    const user = await seedUser(db.prisma, "addr-scan");
    const row = await seedLegacy("addr-scan-a", user.id);
    await new PaymentAddressBackfill(db.prisma, cipher()).run();

    const [{ count }] = await db.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "Payment" p WHERE row_to_json(p)::text LIKE '%' || $1 || '%'`,
      row.sourceAddress,
    );
    expect(Number(count)).toBe(0);
  });

  it("supports the sender equality query through the lookup index, per owner", async () => {
    const sender = "GSYNTHETICSHAREDSENDERADDRESS".padEnd(56, "X");
    const alice = await seedUser(db.prisma, "addr-lookup-alice");
    const bob = await seedUser(db.prisma, "addr-lookup-bob");
    await seedLegacy("addr-lookup-a1", alice.id, sender);
    await seedLegacy("addr-lookup-a2", alice.id);
    await seedLegacy("addr-lookup-b1", bob.id, sender);
    await new PaymentAddressBackfill(db.prisma, cipher()).run();

    const aliceFromSender = await db.prisma.payment.findMany({
      where: { userId: alice.id, sourceAddressLookup: { in: cipher().sourceLookupTokens(sender) } },
      select: { operationId: true },
    });

    expect(aliceFromSender.map((p) => p.operationId)).toEqual(["synthetic-op-addr-lookup-a1"]);
  });

  it("keeps lookups working across a key rotation and re-protects every row", async () => {
    const sender = "GSYNTHETICROTATIONSENDER".padEnd(56, "X");
    const user = await seedUser(db.prisma, "addr-rotate");
    await seedLegacy("addr-rotate-a", user.id, sender);
    await new PaymentAddressBackfill(db.prisma, cipher(0)).run();

    const rotated = cipher(1);
    const findBySender = () =>
      db.prisma.payment.count({ where: { sourceAddressLookup: { in: rotated.sourceLookupTokens(sender) } } });

    // New key active, rows still on v0: still found.
    expect(await findBySender()).toBe(1);
    const rotation = new PaymentAddressBackfill(db.prisma, rotated);
    expect((await rotation.verify()).staleKeyVersion).toBe(1);

    expect(await rotation.run()).toMatchObject({ rotated: 1 });
    expect(await findBySender()).toBe(1);
    expect(await rotation.verify()).toEqual({ plaintextRemaining: 0, missingCiphertext: 0, staleKeyVersion: 0 });
  });

  it("leaves a corrupt row untouched and still migrates the rest", async () => {
    const user = await seedUser(db.prisma, "addr-corrupt");
    const bad = await seedLegacy("addr-corrupt-a", user.id);
    await seedLegacy("addr-corrupt-b", user.id);
    await db.prisma.payment.update({
      where: { id: bad.id },
      data: { sourceAddress: null, sourceAddressEncrypted: "aenc:v0:AAAA:BBBB:CCCC" },
    });

    const run = await new PaymentAddressBackfill(db.prisma, cipher()).run();

    expect(run).toMatchObject({ failed: 1, migrated: 1 });
    const untouched = await db.prisma.payment.findUniqueOrThrow({ where: { id: bad.id } });
    expect(untouched.sourceAddressEncrypted).toBe("aenc:v0:AAAA:BBBB:CCCC");
    expect(untouched.destinationAddress).toBe(bad.destinationAddress);
  });
});
