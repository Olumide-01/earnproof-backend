-- Create enum types for encryption key rewrap and retirement job tracking
CREATE TYPE "EncryptionKeyRewrapStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "EncryptionKeyRetirementStatus" AS ENUM ('PENDING', 'GUARDING', 'SAFE_TO_RETIRE', 'FAILED');

-- Create table for tracking encryption key rewrap jobs
CREATE TABLE "EncryptionKeyRewrapIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceKeyVersion" INTEGER NOT NULL,
    "targetKeyVersion" INTEGER NOT NULL,
    "status" "EncryptionKeyRewrapStatus" NOT NULL DEFAULT 'PENDING',
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "totalCount" INTEGER,
    "lastProcessedPaymentId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "lastErrorSafe" TEXT,
    "permanentError" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EncryptionKeyRewrapIntent_sourceKeyVersion_targetKeyVersion_key" UNIQUE("sourceKeyVersion", "targetKeyVersion")
);

-- Create index for polling
CREATE INDEX "EncryptionKeyRewrapIntent_nextRetryAt_idx" ON "EncryptionKeyRewrapIntent"("nextRetryAt");
CREATE INDEX "EncryptionKeyRewrapIntent_status_idx" ON "EncryptionKeyRewrapIntent"("status");

-- Create table for tracking encryption key retirement jobs
CREATE TABLE "EncryptionKeyRetirementIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyVersion" INTEGER NOT NULL UNIQUE,
    "status" "EncryptionKeyRetirementStatus" NOT NULL DEFAULT 'PENDING',
    "dependentPaymentCount" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "lastErrorSafe" TEXT,
    "permanentError" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Create index for polling
CREATE INDEX "EncryptionKeyRetirementIntent_nextRetryAt_idx" ON "EncryptionKeyRetirementIntent"("nextRetryAt");
CREATE INDEX "EncryptionKeyRetirementIntent_status_idx" ON "EncryptionKeyRetirementIntent"("status");
