-- CreateEnum
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'EXECUTED');

-- CreateEnum
CREATE TYPE "DataResidencyClass" AS ENUM ('PAYMENT_DATA', 'PROOF_DATA', 'AUDIT_DATA', 'BACKUP_DATA', 'QUEUE_DATA');

-- CreateEnum
CREATE TYPE "DataResidencyPolicyStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "SchemaImportStatus" AS ENUM ('UPLOADED', 'DRY_RUN_RUNNING', 'DRY_RUN_COMPLETE', 'APPROVED', 'APPLYING', 'APPLIED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "WebhookCertificateStatus" AS ENUM ('PENDING', 'ACTIVE', 'ROTATING', 'EXPIRED', 'REVOKED');

-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN     "mtlsRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "executionLeaseToken" TEXT,
    "executionLeasedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataResidencyPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dataClass" "DataResidencyClass" NOT NULL,
    "allowedRegions" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DataResidencyPolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersedesId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataResidencyPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataResidencyAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dataClass" "DataResidencyClass" NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataResidencyAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemaImportJob" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "SchemaImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "rowCount" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "canonicalHash" TEXT,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchemaImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemaImportRow" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "schemaKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "normalizedHash" TEXT NOT NULL,
    "conflict" BOOLEAN NOT NULL DEFAULT false,
    "errors" JSONB,

    CONSTRAINT "SchemaImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemaDefinition" (
    "id" TEXT NOT NULL,
    "schemaKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "importJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchemaDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookClientCertificate" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "certificatePem" TEXT NOT NULL,
    "privateKeyEncrypted" TEXT NOT NULL,
    "fingerprintSha256" TEXT NOT NULL,
    "status" "WebhookCertificateStatus" NOT NULL DEFAULT 'PENDING',
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookClientCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_executionLeaseToken_key" ON "ApprovalRequest"("executionLeaseToken");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_expiresAt_idx" ON "ApprovalRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_requestedById_idx" ON "ApprovalRequest"("requestedById");

-- CreateIndex
CREATE INDEX "ApprovalRequest_operationType_status_idx" ON "ApprovalRequest"("operationType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DataResidencyPolicy_supersedesId_key" ON "DataResidencyPolicy"("supersedesId");

-- CreateIndex
CREATE INDEX "DataResidencyPolicy_organizationId_dataClass_status_idx" ON "DataResidencyPolicy"("organizationId", "dataClass", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DataResidencyPolicy_organizationId_dataClass_version_key" ON "DataResidencyPolicy"("organizationId", "dataClass", "version");

-- CreateIndex
CREATE INDEX "DataResidencyAssignment_organizationId_dataClass_region_idx" ON "DataResidencyAssignment"("organizationId", "dataClass", "region");

-- CreateIndex
CREATE UNIQUE INDEX "DataResidencyAssignment_organizationId_dataClass_resourceTy_key" ON "DataResidencyAssignment"("organizationId", "dataClass", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "SchemaImportJob_organizationId_status_idx" ON "SchemaImportJob"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SchemaImportRow_jobId_conflict_idx" ON "SchemaImportRow"("jobId", "conflict");

-- CreateIndex
CREATE UNIQUE INDEX "SchemaImportRow_jobId_rowIndex_key" ON "SchemaImportRow"("jobId", "rowIndex");

-- CreateIndex
CREATE INDEX "SchemaDefinition_schemaKey_idx" ON "SchemaDefinition"("schemaKey");

-- CreateIndex
CREATE UNIQUE INDEX "SchemaDefinition_schemaKey_version_key" ON "SchemaDefinition"("schemaKey", "version");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookClientCertificate_fingerprintSha256_key" ON "WebhookClientCertificate"("fingerprintSha256");

-- CreateIndex
CREATE INDEX "WebhookClientCertificate_webhookId_status_idx" ON "WebhookClientCertificate"("webhookId", "status");

-- CreateIndex
CREATE INDEX "WebhookClientCertificate_notAfter_idx" ON "WebhookClientCertificate"("notAfter");

-- AddForeignKey
ALTER TABLE "DataResidencyPolicy" ADD CONSTRAINT "DataResidencyPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataResidencyAssignment" ADD CONSTRAINT "DataResidencyAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemaImportJob" ADD CONSTRAINT "SchemaImportJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemaImportRow" ADD CONSTRAINT "SchemaImportRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SchemaImportJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookClientCertificate" ADD CONSTRAINT "WebhookClientCertificate_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

