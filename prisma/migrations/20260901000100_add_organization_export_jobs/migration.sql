-- Asynchronous organization data export jobs (issue #200).
-- The encrypted archive lives at a temporary path; only a hash of the
-- single-use download token and an integrity digest are stored.

-- CreateEnum
CREATE TYPE "OrganizationExportStatus" AS ENUM (
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'EXPIRED'
);

-- CreateEnum
CREATE TYPE "OrganizationExportCategory" AS ENUM (
  'ORGANIZATION_PROFILE',
  'ISSUERS',
  'API_KEYS',
  'WEBHOOKS',
  'AUDIT_LOGS'
);

-- CreateTable
CREATE TABLE "OrganizationExportJob" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "categories" "OrganizationExportCategory"[],
  "status" "OrganizationExportStatus" NOT NULL DEFAULT 'QUEUED',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "artifactPath" TEXT,
  "archiveDigest" TEXT,
  "sizeBytes" INTEGER,
  "errorCategory" TEXT,
  "downloadTokenHash" TEXT,
  "downloadExpiresAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OrganizationExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationExportJob_downloadTokenHash_key" ON "OrganizationExportJob"("downloadTokenHash");
CREATE INDEX "OrganizationExportJob_organizationId_requestedAt_idx" ON "OrganizationExportJob"("organizationId", "requestedAt");
CREATE INDEX "OrganizationExportJob_status_expiresAt_idx" ON "OrganizationExportJob"("status", "expiresAt");
CREATE INDEX "OrganizationExportJob_expiresAt_idx" ON "OrganizationExportJob"("expiresAt");
