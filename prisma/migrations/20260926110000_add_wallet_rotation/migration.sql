-- Issue #171: wallet address rotation with reauthentication.
--
-- Additive only. Existing sessions keep a NULL walletHash and remain valid
-- until they expire or are revoked; sessions issued from now on are bound to
-- the wallet identity that created them.

-- CreateEnum
CREATE TYPE "WalletRotationStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "AuthSession" ADD COLUMN "walletHash" TEXT;

-- CreateTable
CREATE TABLE "WalletRotation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentWalletAddress" TEXT NOT NULL,
    "newWalletAddress" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "currentMessage" TEXT NOT NULL,
    "newMessage" TEXT NOT NULL,
    "networkPassphrase" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" "WalletRotationStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletRotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletRotation_nonceHash_key" ON "WalletRotation"("nonceHash");

-- CreateIndex
CREATE INDEX "WalletRotation_userId_status_idx" ON "WalletRotation"("userId", "status");

-- CreateIndex
CREATE INDEX "WalletRotation_expiresAt_idx" ON "WalletRotation"("expiresAt");

-- AddForeignKey
ALTER TABLE "WalletRotation" ADD CONSTRAINT "WalletRotation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
