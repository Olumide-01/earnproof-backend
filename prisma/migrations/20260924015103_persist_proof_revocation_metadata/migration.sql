-- CreateEnum
CREATE TYPE "RevocationActorType" AS ENUM ('OWNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "RevocationReasonCode" AS ENUM ('OWNER_REQUESTED', 'DATA_CORRECTION', 'FRAUD_SUSPECTED', 'COMPLIANCE_HOLD', 'DUPLICATE_PROOF', 'OTHER');

-- AlterTable
ALTER TABLE "Proof" ADD COLUMN     "revocationEvidenceHash" TEXT,
ADD COLUMN     "revocationReasonCode" "RevocationReasonCode",
ADD COLUMN     "revocationReasonPrivate" TEXT,
ADD COLUMN     "revokedById" TEXT,
ADD COLUMN     "revokedByType" "RevocationActorType";
