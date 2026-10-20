import { Prisma, PrismaClient } from "@prisma/client";
import { PaymentAddressCipher } from "../common/crypto/payment-address-cipher";

/** Rows read per batch unless the caller asks for fewer. */
export const DEFAULT_BACKFILL_BATCH_SIZE = 200;
/** Upper bound on one batch, whatever the caller asks for. */
export const MAX_BACKFILL_BATCH_SIZE = 1_000;

export interface BackfillBatchResult {
  scanned: number;
  /** Legacy plaintext rows now encrypted, verified, and cleared. */
  migrated: number;
  /** Encrypted rows re-protected under the active key version. */
  rotated: number;
  /** Rows changed concurrently since they were read; retried on a later run. */
  skipped: number;
  /** Rows whose address could not be recovered. Left untouched. */
  failed: number;
  /** Resume after this id, or `null` when the table has been walked. */
  nextCursor: string | null;
}

export interface BackfillVerification {
  /** Rows still holding a plaintext address. */
  plaintextRemaining: number;
  /** Rows with no ciphertext for one of their addresses. */
  missingCiphertext: number;
  /** Rows protected under a key version other than the active one. */
  staleKeyVersion: number;
}

type BackfillPrisma = Pick<PrismaClient, "payment">;

const SELECT = {
  id: true,
  sourceAddress: true,
  destinationAddress: true,
  sourceAddressEncrypted: true,
  destinationAddressEncrypted: true,
  sourceAddressLookup: true,
} satisfies Prisma.PaymentSelect;

type Row = Prisma.PaymentGetPayload<{ select: typeof SELECT }>;

/**
 * Migrates payment addresses to ciphertext in bounded, resumable batches, and
 * re-protects rows after a key rotation.
 *
 * - **Restartable:** a row is selected only while it still needs work
 *   (plaintext present, ciphertext or token missing, or protected under an
 *   older key version), so a re-run picks up exactly what is left.
 * - **Bounded:** each batch reads at most {@link MAX_BACKFILL_BATCH_SIZE} rows
 *   by id order, and {@link run} stops after `maxBatches`.
 * - **Verified:** a row's plaintext is cleared only in the same update that
 *   writes ciphertext which has just been decrypted back to that plaintext.
 * - **Concurrency-safe:** the update is conditional on the row still holding
 *   the values that were read, so a concurrent sync is never overwritten.
 * - **Private:** results are counts only. No address, ciphertext or token is
 *   logged, returned, or placed in an error.
 */
export class PaymentAddressBackfill {
  constructor(
    private readonly prisma: BackfillPrisma,
    private readonly cipher: PaymentAddressCipher,
  ) {}

  async runBatch(options: { afterId?: string; batchSize?: number } = {}): Promise<BackfillBatchResult> {
    const batchSize = Math.min(
      Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE)),
      MAX_BACKFILL_BATCH_SIZE,
    );
    const rows = await this.prisma.payment.findMany({
      where: {
        ...(options.afterId ? { id: { gt: options.afterId } } : {}),
        OR: this.needsWork(),
      },
      select: SELECT,
      orderBy: { id: "asc" },
      take: batchSize,
    });

    const result: BackfillBatchResult = {
      scanned: rows.length,
      migrated: 0,
      rotated: 0,
      skipped: 0,
      failed: 0,
      nextCursor: rows.length === batchSize ? rows[rows.length - 1].id : null,
    };

    for (const row of rows) {
      const outcome = await this.migrateRow(row);
      result[outcome] += 1;
    }
    return result;
  }

  /** Runs batches until the table is walked or `maxBatches` is reached. */
  async run(options: { batchSize?: number; maxBatches?: number; afterId?: string } = {}) {
    const maxBatches = Math.max(1, Math.trunc(options.maxBatches ?? 50));
    const totals = { batches: 0, scanned: 0, migrated: 0, rotated: 0, skipped: 0, failed: 0 };
    let cursor = options.afterId;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await this.runBatch({ afterId: cursor, batchSize: options.batchSize });
      totals.batches += 1;
      totals.scanned += result.scanned;
      totals.migrated += result.migrated;
      totals.rotated += result.rotated;
      totals.skipped += result.skipped;
      totals.failed += result.failed;
      if (!result.nextCursor) return { ...totals, nextCursor: null };
      cursor = result.nextCursor;
    }
    return { ...totals, nextCursor: cursor ?? null };
  }

  /** Counts that must all be zero before the plaintext columns are dropped. */
  async verify(): Promise<BackfillVerification> {
    const active = this.activePrefixes();
    const [plaintextRemaining, missingCiphertext, staleKeyVersion] = await Promise.all([
      this.prisma.payment.count({
        where: { OR: [{ sourceAddress: { not: null } }, { destinationAddress: { not: null } }] },
      }),
      this.prisma.payment.count({
        where: {
          OR: [
            { sourceAddressEncrypted: null },
            { destinationAddressEncrypted: null },
            { sourceAddressLookup: null },
          ],
        },
      }),
      this.prisma.payment.count({
        where: {
          sourceAddressEncrypted: { not: null },
          destinationAddressEncrypted: { not: null },
          sourceAddressLookup: { not: null },
          OR: [
            { NOT: { sourceAddressEncrypted: { startsWith: active.ciphertext } } },
            { NOT: { destinationAddressEncrypted: { startsWith: active.ciphertext } } },
            { NOT: { sourceAddressLookup: { startsWith: active.token } } },
          ],
        },
      }),
    ]);
    return { plaintextRemaining, missingCiphertext, staleKeyVersion };
  }

  private async migrateRow(row: Row): Promise<"migrated" | "rotated" | "skipped" | "failed"> {
    let source: string;
    let destination: string;
    try {
      source = this.cipher.reveal(
        { encrypted: row.sourceAddressEncrypted, plaintext: row.sourceAddress },
        "source",
      );
      destination = this.cipher.reveal(
        { encrypted: row.destinationAddressEncrypted, plaintext: row.destinationAddress },
        "destination",
      );
    } catch {
      return "failed";
    }

    // Plaintext and ciphertext disagreeing means one of them is corrupt;
    // neither is trusted, and the row is left for an operator.
    if (
      (row.sourceAddress && row.sourceAddressEncrypted && row.sourceAddress !== source) ||
      (row.destinationAddress &&
        row.destinationAddressEncrypted &&
        row.destinationAddress !== destination)
    ) {
      return "failed";
    }

    const columns = this.cipher.protect(source, destination);
    const verified =
      this.cipher.reveal({ encrypted: columns.sourceAddressEncrypted, plaintext: null }, "source") ===
        source &&
      this.cipher.reveal(
        { encrypted: columns.destinationAddressEncrypted, plaintext: null },
        "destination",
      ) === destination;
    if (!verified) return "failed";

    const updated = await this.prisma.payment.updateMany({
      where: {
        id: row.id,
        sourceAddress: row.sourceAddress,
        destinationAddress: row.destinationAddress,
        sourceAddressEncrypted: row.sourceAddressEncrypted,
        destinationAddressEncrypted: row.destinationAddressEncrypted,
        sourceAddressLookup: row.sourceAddressLookup,
      },
      data: columns,
    });
    if (updated.count === 0) return "skipped";
    return row.sourceAddress || row.destinationAddress ? "migrated" : "rotated";
  }

  private needsWork(): Prisma.PaymentWhereInput[] {
    const active = this.activePrefixes();
    return [
      { sourceAddress: { not: null } },
      { destinationAddress: { not: null } },
      { sourceAddressEncrypted: null },
      { destinationAddressEncrypted: null },
      { sourceAddressLookup: null },
      { NOT: { sourceAddressEncrypted: { startsWith: active.ciphertext } } },
      { NOT: { destinationAddressEncrypted: { startsWith: active.ciphertext } } },
      { NOT: { sourceAddressLookup: { startsWith: active.token } } },
    ];
  }

  private activePrefixes() {
    return {
      ciphertext: `aenc:v${this.cipher.writeVersion}:`,
      token: `hmac:v${this.cipher.writeVersion}:`,
    };
  }
}
