import { PrismaClient } from "@prisma/client";
import {
  LegacyPaymentRow,
  planPaymentIdentityBackfill,
} from "../src/payments/payment-identity-backfill";

/**
 * Backfill the canonical identity (network, transaction hash, operation index)
 * of existing payments (#206).
 *
 * Run with:
 *   STELLAR_NETWORK=<network> npm run backfill:payment-identity
 *
 * The operation index is derived deterministically from each payment's Horizon
 * operation id (a TOID). The network is not recoverable from stored data, so it
 * is supplied by the operator and applied uniformly — a deployment indexes one
 * network. Rows whose id is not a TOID, or whose identity collides with another
 * row, are reported as ambiguous and left untouched: the backfill never guesses.
 *
 * The job is idempotent and restartable: re-running assigns the same identity to
 * the same rows and reports rows already carrying it as unchanged.
 */
async function main(): Promise<void> {
  const network = process.env.STELLAR_NETWORK;
  if (!network) {
    throw new Error(
      "STELLAR_NETWORK must be set to the network these payments belong to",
    );
  }

  const prisma = new PrismaClient();
  const pageSize = 500;

  let processed = 0;
  let updated = 0;
  let unchanged = 0;
  const ambiguous: { id: string; reason: string }[] = [];

  try {
    let cursor: string | undefined;

    for (;;) {
      const rows: LegacyPaymentRow[] = await prisma.payment.findMany({
        take: pageSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        select: {
          id: true,
          operationId: true,
          stellarTransactionHash: true,
          operationIndex: true,
          network: true,
        },
      });
      if (rows.length === 0) break;

      const plan = planPaymentIdentityBackfill(rows, network);
      unchanged += plan.unchanged;
      ambiguous.push(...plan.ambiguous);

      for (const update of plan.updates) {
        await prisma.payment.update({
          where: { id: update.id },
          data: {
            network: update.network,
            operationIndex: update.operationIndex,
          },
        });
        updated += 1;
      }

      processed += rows.length;
      cursor = rows[rows.length - 1].id;
    }

    // Counts and ids only — never payment content — so a terminal scrollback
    // stays free of sensitive data.
    console.log(
      `Backfill complete: processed=${processed} updated=${updated} unchanged=${unchanged} ambiguous=${ambiguous.length}`,
    );
    for (const row of ambiguous) {
      console.warn(`AMBIGUOUS payment ${row.id}: ${row.reason}`);
    }
    if (ambiguous.length > 0) {
      console.warn(
        `${ambiguous.length} row(s) need manual resolution before NOT NULL can be enforced.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
