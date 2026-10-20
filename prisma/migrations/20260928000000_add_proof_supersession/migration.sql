-- Proof renewal / supersession chain (earnproof-backend#182).
-- Additive only: nullable columns, so existing rows need no backfill.
ALTER TABLE "Proof" ADD COLUMN     "renewalRequestHash" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersedesId" TEXT;

-- A predecessor can have at most one successor: concurrent renewals race on
-- this index and exactly one wins, which is what prevents forked chains.
CREATE UNIQUE INDEX "Proof_supersedesId_key" ON "Proof"("supersedesId");

-- AddForeignKey
ALTER TABLE "Proof" ADD CONSTRAINT "Proof_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "Proof"("id") ON DELETE SET NULL ON UPDATE CASCADE;
