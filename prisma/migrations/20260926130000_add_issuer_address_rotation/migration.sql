-- Issue #173: issuer Stellar address rotation and contract reconciliation.
--
-- Additive only. Existing issuers start at revision 0 with no rotations and no
-- address history.

-- CreateEnum
CREATE TYPE "IssuerAddressRotationStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- AlterTable
-- IF NOT EXISTS: another in-flight change also introduces Issuer.revision for
-- optimistic concurrency. Both define it identically, so whichever migration
-- runs second leaves the column as it found it.
ALTER TABLE "Issuer" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "IssuerAddressRotation" (
    "id" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "status" "IssuerAddressRotationStatus" NOT NULL DEFAULT 'PENDING',
    "openIssuerKey" TEXT,
    "openTargetKey" TEXT,
    "requestedById" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "transactionHash" TEXT,
    "lastError" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssuerAddressRotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuerAddressHistory" (
    "id" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "stellarAddress" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL,
    "rotationId" TEXT NOT NULL,
    "transactionHash" TEXT,

    CONSTRAINT "IssuerAddressHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IssuerAddressRotation_openIssuerKey_key" ON "IssuerAddressRotation"("openIssuerKey");

-- CreateIndex
CREATE UNIQUE INDEX "IssuerAddressRotation_openTargetKey_key" ON "IssuerAddressRotation"("openTargetKey");

-- CreateIndex
CREATE INDEX "IssuerAddressRotation_issuerId_createdAt_idx" ON "IssuerAddressRotation"("issuerId", "createdAt");

-- CreateIndex
CREATE INDEX "IssuerAddressRotation_status_nextAttemptAt_idx" ON "IssuerAddressRotation"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "IssuerAddressHistory_rotationId_key" ON "IssuerAddressHistory"("rotationId");

-- CreateIndex
CREATE INDEX "IssuerAddressHistory_issuerId_retiredAt_idx" ON "IssuerAddressHistory"("issuerId", "retiredAt");

-- CreateIndex
CREATE INDEX "IssuerAddressHistory_stellarAddress_idx" ON "IssuerAddressHistory"("stellarAddress");

-- AddForeignKey
ALTER TABLE "IssuerAddressRotation" ADD CONSTRAINT "IssuerAddressRotation_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "Issuer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuerAddressHistory" ADD CONSTRAINT "IssuerAddressHistory_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "Issuer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
