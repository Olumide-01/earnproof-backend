-- CreateEnum
CREATE TYPE "CheckpointHealthClassification" AS ENUM ('NORMAL_LAG', 'STALLED_INGESTION', 'HORIZON_OUTAGE', 'RATE_LIMITING', 'REORGANIZATION_RECOVERY');

-- CreateEnum
CREATE TYPE "ReminderDeliveryStatus" AS ENUM ('SCHEDULED', 'ENQUEUED', 'DELIVERED', 'CANCELLED');

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "correlationId" TEXT,
ADD COLUMN "parentId" TEXT;

-- CreateTable
CREATE TABLE "PaymentCheckpointHealthSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "network" TEXT NOT NULL,
    "walletAddressHash" TEXT NOT NULL,
    "ledgerSequence" INTEGER NOT NULL,
    "latestKnownLedger" INTEGER NOT NULL,
    "ledgerLag" INTEGER NOT NULL,
    "classification" "CheckpointHealthClassification" NOT NULL DEFAULT 'NORMAL_LAG',
    "pagingToken" TEXT NOT NULL,
    "isStalled" BOOLEAN NOT NULL DEFAULT false,
    "isReorganizing" BOOLEAN NOT NULL DEFAULT false,
    "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastRecoveredAt" TIMESTAMP(3),
    "metadata" JSONB,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentCheckpointHealthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProofExpirationReminderPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "leadTimeHours" INTEGER[] DEFAULT ARRAY[24, 72, 168]::INTEGER[],
    "optedOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProofExpirationReminderPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProofExpirationReminderDelivery" (
    "id" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "windowHours" INTEGER NOT NULL,
    "targetDate" TIMESTAMP(3) NOT NULL,
    "status" "ReminderDeliveryStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "notificationRecord" JSONB,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProofExpirationReminderDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_correlationId_idx" ON "AuditLog"("organizationId", "correlationId");
CREATE INDEX "AuditLog_parentId_idx" ON "AuditLog"("parentId");

-- CreateIndex
CREATE INDEX "PaymentCheckpointHealthSnapshot_userId_recordedAt_idx" ON "PaymentCheckpointHealthSnapshot"("userId", "recordedAt");
CREATE INDEX "PaymentCheckpointHealthSnapshot_network_classification_idx" ON "PaymentCheckpointHealthSnapshot"("network", "classification");
CREATE INDEX "PaymentCheckpointHealthSnapshot_organizationId_recordedAt_idx" ON "PaymentCheckpointHealthSnapshot"("organizationId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProofExpirationReminderPreference_userId_key" ON "ProofExpirationReminderPreference"("userId");
CREATE INDEX "ProofExpirationReminderPreference_userId_enabled_idx" ON "ProofExpirationReminderPreference"("userId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ProofExpirationReminderDelivery_proofId_windowHours_key" ON "ProofExpirationReminderDelivery"("proofId", "windowHours");
CREATE INDEX "ProofExpirationReminderDelivery_status_scheduledFor_idx" ON "ProofExpirationReminderDelivery"("status", "scheduledFor");
CREATE INDEX "ProofExpirationReminderDelivery_userId_status_idx" ON "ProofExpirationReminderDelivery"("userId", "status");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AuditLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentCheckpointHealthSnapshot" ADD CONSTRAINT "PaymentCheckpointHealthSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentCheckpointHealthSnapshot" ADD CONSTRAINT "PaymentCheckpointHealthSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofExpirationReminderPreference" ADD CONSTRAINT "ProofExpirationReminderPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofExpirationReminderDelivery" ADD CONSTRAINT "ProofExpirationReminderDelivery_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProofExpirationReminderDelivery" ADD CONSTRAINT "ProofExpirationReminderDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
