-- CreateEnum
CREATE TYPE "QuarantineReasonCode" AS ENUM ('POISON_INPUT', 'CHAIN_REJECTED', 'MAX_ATTEMPTS_EXCEEDED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "QuarantineDecision" AS ENUM ('PENDING', 'REDRIVEN', 'ABANDONED');

-- AlterEnum
ALTER TYPE "AnchoringStatus" ADD VALUE 'QUARANTINED';

-- AlterTable
ALTER TABLE "AnchoringIntent" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "quarantineDecision" "QuarantineDecision" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "quarantineReasonCode" "QuarantineReasonCode",
ADD COLUMN     "quarantinedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AnchoringIntent_status_quarantineDecision_idx" ON "AnchoringIntent"("status", "quarantineDecision");
