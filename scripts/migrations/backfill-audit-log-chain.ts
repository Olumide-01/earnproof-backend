/**
 * Backfills chain/hash fields for AuditLog rows that predate the tamper-
 * evidence chain (migration 20260901000000_audit_log_hash_chain).
 *
 * That migration adds the chain columns and, for any pre-existing rows,
 * assigns them distinct temporary negative `sequence` values (ordered by
 * createdAt, id) purely so the new UNIQUE(chainKey, sequence) index does not
 * reject a populated table. This script is what actually computes each
 * row's real positive sequence, prevHash and hash -- using the exact same
 * canonicalization/hash code the application uses at write time
 * (src/audit/audit-chain.ts) -- so a backfilled chain verifies with the same
 * AuditVerificationService used for chains written after the migration.
 *
 * All pre-existing rows have no organizationId, so they are bucketed into
 * the SYSTEM chain, in createdAt/id order (the same order the migration used
 * to assign temporary negative sequences), starting at sequence 1.
 *
 * Idempotent: only rows with sequence <= 0 (the migration's temporary
 * marker) are processed; running this twice is a no-op the second time.
 * Safe against an empty table (nothing to do).
 *
 * Run with: npx ts-node scripts/migrations/backfill-audit-log-chain.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  computeAuditHash,
  CURRENT_HASH_VERSION,
  SYSTEM_CHAIN_KEY,
} from "../../src/audit/audit-chain";

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const total = await backfillSystemChain(prisma);
    console.log(`Backfilled ${total} AuditLog record(s) into the SYSTEM chain.`);
  } finally {
    await prisma.$disconnect();
  }
}

export async function backfillSystemChain(
  prisma: PrismaClient,
): Promise<number> {
  const cursor = await prisma.auditChainCursor.findUnique({
    where: { chainKey: SYSTEM_CHAIN_KEY },
  });

  let sequence = cursor?.lastSequence ?? BigInt(0);
  let prevHash = cursor?.lastHash ?? null;
  let processed = 0;

  while (true) {
    const rows = await prisma.auditLog.findMany({
      where: { chainKey: SYSTEM_CHAIN_KEY, sequence: { lte: 0 } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: BATCH_SIZE,
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      sequence += BigInt(1);

      const hash = computeAuditHash(
        prevHash,
        {
          chainKey: SYSTEM_CHAIN_KEY,
          sequence,
          hashVersion: CURRENT_HASH_VERSION,
          actorType: row.actorType,
          actorId: row.actorId,
          action: row.action,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          metadata: row.metadata,
          createdAt: row.createdAt,
        },
        CURRENT_HASH_VERSION,
      );

      await prisma.auditLog.update({
        where: { id: row.id },
        data: {
          sequence,
          hashVersion: CURRENT_HASH_VERSION,
          prevHash,
          hash,
        },
      });

      prevHash = hash;
      processed += 1;
    }

    if (rows.length < BATCH_SIZE) break;
  }

  if (processed > 0) {
    await prisma.auditChainCursor.upsert({
      where: { chainKey: SYSTEM_CHAIN_KEY },
      create: { chainKey: SYSTEM_CHAIN_KEY, lastSequence: sequence, lastHash: prevHash },
      update: { lastSequence: sequence, lastHash: prevHash },
    });
  }

  return processed;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Audit log chain backfill failed:", error);
    process.exitCode = 1;
  });
}
