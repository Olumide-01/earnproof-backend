-- Tamper-evident hash chain for AuditLog, plus its per-chain append cursor.
--
-- Every AuditLog row is chained to the previous row in the same partition
-- ("chainKey" = organizationId, or the 'SYSTEM' sentinel for records with no
-- organization -- Postgres unique constraints do not deduplicate NULLs, so a
-- literal sentinel is used instead of leaving these rows unpartitioned).
--
-- This migration only performs schema changes (columns, constraints, the new
-- cursor table). It deliberately does NOT attempt to compute chain/hash
-- values for pre-existing rows in raw SQL: the canonical hash input is a
-- deep-key-sorted JSON document over structured `metadata`, which is not
-- something `pgcrypto`'s `digest()` can reproduce byte-for-byte against the
-- application's canonicalization (src/audit/audit-chain.ts) without
-- duplicating that logic in SQL and risking silent drift between the two.
-- Instead, existing rows are left with the column defaults added below
-- (chainKey = 'SYSTEM', sequence = 0, hash = '') and must be backfilled by
-- running the companion script, which reuses the exact same
-- canonicalization/hash code the application uses at write time:
--
--   npx ts-node scripts/migrations/backfill-audit-log-chain.ts
--
-- That script is idempotent (it only processes rows with sequence = 0) and
-- safe to run against an empty table (a no-op). On a fresh database (no
-- pre-existing AuditLog rows) this migration alone is already sufficient --
-- every row created after this migration goes through the chain-writer in
-- PrismaService and is chained at write time.

-- AlterTable: add chain fields to "AuditLog"
ALTER TABLE "AuditLog" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "chainKey" TEXT NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "AuditLog" ADD COLUMN "sequence" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "AuditLog" ADD COLUMN "hashVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AuditLog" ADD COLUMN "prevHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "hash" TEXT NOT NULL DEFAULT '';

-- CreateTable: per-chain append cursor
CREATE TABLE "AuditChainCursor" (
  "chainKey" TEXT NOT NULL,
  "lastSequence" BIGINT NOT NULL DEFAULT 0,
  "lastHash" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AuditChainCursor_pkey" PRIMARY KEY ("chainKey")
);

-- Seed the SYSTEM cursor row so the very first chain-writer call has a row
-- to lock rather than racing its own "insert if missing" branch.
INSERT INTO "AuditChainCursor" ("chainKey", "lastSequence", "lastHash", "updatedAt")
VALUES ('SYSTEM', 0, NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("chainKey") DO NOTHING;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Every pre-existing row defaults to (chainKey='SYSTEM', sequence=0), which
-- the UNIQUE("chainKey","sequence") index created below would reject outright
-- for a table with more than one existing row. To keep this migration safe
-- against a populated table, existing rows are immediately assigned distinct
-- temporary negative sequence numbers here (still unique, still ordered by
-- createdAt/id, and always less than the first real chain-writer sequence
-- value of 1, so they sort before any new record). The backfill script then
-- rewrites each of them, in that same order, to its final positive
-- sequence/prevHash/hash values. Must run before the unique index below.
WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "AuditLog"
)
UPDATE "AuditLog" a
SET "sequence" = (ordered.rn * -1)
FROM ordered
WHERE a."id" = ordered."id" AND a."sequence" = 0;

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_chainKey_sequence_key" ON "AuditLog"("chainKey", "sequence");
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");
