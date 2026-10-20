-- Bounded ledger-range payment backfill jobs (earnproof-backend#177).
-- Additive only: a new enum, a new table and its indexes.

-- CreateEnum
CREATE TYPE "PaymentBackfillStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "PaymentBackfillJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "startLedger" INTEGER NOT NULL,
    "endLedger" INTEGER NOT NULL,
    "status" "PaymentBackfillStatus" NOT NULL DEFAULT 'PENDING',
    "checkpointCursor" TEXT,
    "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
    "recordsSeen" INTEGER NOT NULL DEFAULT 0,
    "paymentsCreated" INTEGER NOT NULL DEFAULT 0,
    "duplicatesSkipped" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "lastErrorSafe" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentBackfillJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentBackfillJob_userId_status_idx" ON "PaymentBackfillJob"("userId", "status");

-- CreateIndex
CREATE INDEX "PaymentBackfillJob_status_leaseExpiresAt_idx" ON "PaymentBackfillJob"("status", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "PaymentBackfillJob" ADD CONSTRAINT "PaymentBackfillJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backstop for the application-side range validation: an inclusive range of
-- at most 120960 ledgers (about one week) starting at or after ledger 2.
ALTER TABLE "PaymentBackfillJob"
ADD CONSTRAINT "PaymentBackfillJob_bounded_range" CHECK (
  "startLedger" >= 2
  AND "endLedger" >= "startLedger"
  AND "endLedger" - "startLedger" < 120960
);
