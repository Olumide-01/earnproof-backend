-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "rotationFamilyId" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "overlapExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ApiKey_organizationId_rotationFamilyId_idx" ON "ApiKey"("organizationId", "rotationFamilyId");
CREATE INDEX "ApiKey_rotationFamilyId_idx" ON "ApiKey"("rotationFamilyId");
CREATE INDEX "ApiKey_overlapExpiresAt_idx" ON "ApiKey"("overlapExpiresAt");

-- CreateEnum
CREATE TYPE "ApiKeyRotationStatus" AS ENUM ('IN_OVERLAP', 'CUTOVER', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "ApiKeyRotation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "oldKeyId" TEXT NOT NULL,
    "newKeyId" TEXT NOT NULL,
    "overlapExpiresAt" TIMESTAMP(3) NOT NULL,
    "cutoverAt" TIMESTAMP(3),
    "cutoverById" TEXT,
    "status" "ApiKeyRotationStatus" NOT NULL DEFAULT 'IN_OVERLAP',
    "oldKeyUsageCount" INTEGER NOT NULL DEFAULT 0,
    "lastOldKeyUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKeyRotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKeyCutoverReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rotationId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "oldKeyId" TEXT NOT NULL,
    "newKeyId" TEXT NOT NULL,
    "cutoverAt" TIMESTAMP(3) NOT NULL,
    "cutoverType" TEXT NOT NULL,
    "initiatedById" TEXT,
    "oldKeyUsageCount" INTEGER NOT NULL DEFAULT 0,
    "receiptHash" TEXT NOT NULL,
    "receiptData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKeyCutoverReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiKeyRotation_organizationId_familyId_idx" ON "ApiKeyRotation"("organizationId", "familyId");
CREATE INDEX "ApiKeyRotation_organizationId_status_idx" ON "ApiKeyRotation"("organizationId", "status");
CREATE INDEX "ApiKeyRotation_oldKeyId_status_idx" ON "ApiKeyRotation"("oldKeyId", "status");
CREATE INDEX "ApiKeyRotation_newKeyId_status_idx" ON "ApiKeyRotation"("newKeyId", "status");
CREATE INDEX "ApiKeyRotation_overlapExpiresAt_idx" ON "ApiKeyRotation"("overlapExpiresAt");
CREATE UNIQUE INDEX "ApiKeyRotation_oldKeyId_newKeyId_key" ON "ApiKeyRotation"("oldKeyId", "newKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyCutoverReceipt_rotationId_key" ON "ApiKeyCutoverReceipt"("rotationId");
CREATE UNIQUE INDEX "ApiKeyCutoverReceipt_receiptHash_key" ON "ApiKeyCutoverReceipt"("receiptHash");
CREATE INDEX "ApiKeyCutoverReceipt_organizationId_familyId_idx" ON "ApiKeyCutoverReceipt"("organizationId", "familyId");
CREATE INDEX "ApiKeyCutoverReceipt_receiptHash_idx" ON "ApiKeyCutoverReceipt"("receiptHash");

-- AddForeignKey
ALTER TABLE "ApiKeyRotation" ADD CONSTRAINT "ApiKeyRotation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKeyRotation" ADD CONSTRAINT "ApiKeyRotation_oldKeyId_fkey" FOREIGN KEY ("oldKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKeyRotation" ADD CONSTRAINT "ApiKeyRotation_newKeyId_fkey" FOREIGN KEY ("newKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyCutoverReceipt" ADD CONSTRAINT "ApiKeyCutoverReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKeyCutoverReceipt" ADD CONSTRAINT "ApiKeyCutoverReceipt_rotationId_fkey" FOREIGN KEY ("rotationId") REFERENCES "ApiKeyRotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
