-- Horizon checkpoint finality and ledger reorganisation handling.
-- Additive only: every new Payment column is nullable, so rows synced before
-- this migration keep working and are simply outside finality tracking.

-- CreateEnum
CREATE TYPE "PaymentSyncCheckpointStatus" AS ENUM ('VERIFIED', 'DIVERGED');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "pagingToken" TEXT;
ALTER TABLE "Payment" ADD COLUMN "ledgerSequence" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "finalityHoldAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "finalityHoldReason" TEXT;

-- CreateTable
CREATE TABLE "PaymentSyncCheckpoint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pagingToken" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "ledgerSequence" INTEGER NOT NULL,
    "ledgerHash" TEXT NOT NULL,
    "status" "PaymentSyncCheckpointStatus" NOT NULL DEFAULT 'VERIFIED',
    "divergenceReason" TEXT,
    "divergedAt" TIMESTAMP(3),
    "reconciliationCursor" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentSyncCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_userId_ledgerSequence_idx" ON "Payment"("userId", "ledgerSequence");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSyncCheckpoint_userId_key" ON "PaymentSyncCheckpoint"("userId");

-- CreateIndex
CREATE INDEX "PaymentSyncCheckpoint_status_idx" ON "PaymentSyncCheckpoint"("status");

-- AddForeignKey
ALTER TABLE "PaymentSyncCheckpoint" ADD CONSTRAINT "PaymentSyncCheckpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
