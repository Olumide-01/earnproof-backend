-- Payment account rotation and checkpoint handoff (#321).
-- Additive only. PaymentBackfillJob.accountId is nullable: existing jobs keep
-- NULL and continue to scan the user's wallet, exactly as before. Users with
-- no PaymentMonitoredAccount row keep their wallet as the monitored account.
-- Rollback: drop PaymentMonitoredAccount and PaymentAccountRotation, the two
-- enums, and the PaymentBackfillJob.accountId column (only rotation-created
-- jobs use it).

-- CreateEnum
CREATE TYPE "PaymentAccountRotationStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'ACTIVATED', 'ROLLED_BACK', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentMonitoredAccountStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- AlterTable
ALTER TABLE "PaymentBackfillJob" ADD COLUMN     "accountId" VARCHAR(56);

-- CreateTable
CREATE TABLE "PaymentAccountRotation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" VARCHAR(32) NOT NULL,
    "networkPassphrase" VARCHAR(128) NOT NULL,
    "fromAccountId" VARCHAR(56) NOT NULL,
    "toAccountId" VARCHAR(56) NOT NULL,
    "status" "PaymentAccountRotationStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "challengeMessage" TEXT NOT NULL,
    "nonceHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "backfillFromLedger" INTEGER,
    "finalPagingToken" TEXT,
    "finalOperationId" TEXT,
    "finalTransactionHash" TEXT,
    "finalLedgerSequence" INTEGER,
    "finalLedgerHash" TEXT,
    "finalVerifiedAt" TIMESTAMP(3),
    "backfillStartLedger" INTEGER,
    "backfillEndLedger" INTEGER,
    "backfillJobId" TEXT,
    "fromEpochId" TEXT,
    "toEpochId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "rollbackDeadline" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "rollbackReason" VARCHAR(64),
    "failureReason" VARCHAR(64),
    "openUserKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAccountRotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMonitoredAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" VARCHAR(32) NOT NULL,
    "accountId" VARCHAR(56) NOT NULL,
    "status" "PaymentMonitoredAccountStatus" NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "rotationId" TEXT,
    "activeUserKey" TEXT,
    "activeAccountKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMonitoredAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAccountRotation_openUserKey_key" ON "PaymentAccountRotation"("openUserKey");

-- CreateIndex
CREATE INDEX "PaymentAccountRotation_userId_createdAt_idx" ON "PaymentAccountRotation"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMonitoredAccount_activeUserKey_key" ON "PaymentMonitoredAccount"("activeUserKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMonitoredAccount_activeAccountKey_key" ON "PaymentMonitoredAccount"("activeAccountKey");

-- CreateIndex
CREATE INDEX "PaymentMonitoredAccount_userId_network_activatedAt_idx" ON "PaymentMonitoredAccount"("userId", "network", "activatedAt");

-- AddForeignKey
ALTER TABLE "PaymentAccountRotation" ADD CONSTRAINT "PaymentAccountRotation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMonitoredAccount" ADD CONSTRAINT "PaymentMonitoredAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
