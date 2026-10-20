-- CreateEnum for SharingOutcome
CREATE TYPE "SharingOutcome" AS ENUM ('ACCEPTED', 'REJECTED', 'EXPIRED', 'REVOKED', 'REPLAYED', 'TOKEN_GENERATED', 'EXPIRED_TOKEN', 'INVALID_TOKEN', 'PROOF_NOT_FOUND', 'PROOF_INACTIVE', 'SUCCESS', 'ERROR');

-- CreateEnum for PolicyType
CREATE TYPE "PolicyType" AS ENUM ('PRIVACY_POLICY', 'TERMS_OF_SERVICE');

-- CreateEnum for PolicyStatus
CREATE TYPE "PolicyStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- CreateEnum for ConsentAction
CREATE TYPE "ConsentAction" AS ENUM ('ACCEPT', 'WITHDRAW');

-- CreateTable ApiKeyQuota
-- API key quota configuration per scope for fine-grained rate limiting.
-- Supports unlimited (null limit), disabled (0 limit), and finite quotas.
CREATE TABLE "ApiKeyQuota" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "scope" "ApiKeyScope" NOT NULL,
    "quotaLimit" INTEGER,
    "windowSeconds" INTEGER NOT NULL DEFAULT 3600,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKeyQuota_pkey" PRIMARY KEY ("id")
);

-- CreateTable ProofSharingEvent  
-- Privacy-safe proof sharing access events without storing raw tokens or verifier identities.
-- Retention is independent from general verification events.
CREATE TABLE "ProofSharingEvent" (
    "id" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "outcome" "SharingOutcome" NOT NULL,
    "purpose" TEXT,
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProofSharingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable PolicyVersion
-- Immutable policy versions with content hash commitments.
-- Each published version has a unique content hash for tamper detection.
CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL,
    "policyType" "PolicyType" NOT NULL,
    "version" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" "PolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable ConsentRecord
-- Immutable consent acceptance and withdrawal history.
-- Preserves audit trail of policy version acceptance by authenticated users.
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "policyType" "PolicyType" NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "action" "ConsentAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable DisclosureReceipt
-- Signed proof disclosure consent receipts.
-- Stores receipt metadata and cryptographic commitments without duplicating proof data.
CREATE TABLE "DisclosureReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "receiptHash" TEXT NOT NULL,
    "signatureData" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisclosureReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex for ApiKeyQuota per scope
CREATE UNIQUE INDEX "ApiKeyQuota_apiKeyId_scope_key" ON "ApiKeyQuota"("apiKeyId", "scope");

-- CreateIndex for ApiKeyQuota lookups
CREATE INDEX "ApiKeyQuota_apiKeyId_idx" ON "ApiKeyQuota"("apiKeyId");

-- CreateIndex for ProofSharingEvent organization and proof queries
CREATE INDEX "ProofSharingEvent_organizationId_proofId_createdAt_idx" ON "ProofSharingEvent"("organizationId", "proofId", "createdAt");

-- CreateIndex for ProofSharingEvent proof queries
CREATE INDEX "ProofSharingEvent_proofId_createdAt_idx" ON "ProofSharingEvent"("proofId", "createdAt");

-- CreateIndex for ProofSharingEvent retention cleanup
CREATE INDEX "ProofSharingEvent_expiresAt_idx" ON "ProofSharingEvent"("expiresAt");

-- CreateUniqueIndex for PolicyVersion type and version
CREATE UNIQUE INDEX "PolicyVersion_policyType_version_key" ON "PolicyVersion"("policyType", "version");

-- CreateIndex for PolicyVersion status queries
CREATE INDEX "PolicyVersion_policyType_status_idx" ON "PolicyVersion"("policyType", "status");

-- CreateIndex for PolicyVersion published queries
CREATE INDEX "PolicyVersion_policyType_publishedAt_idx" ON "PolicyVersion"("policyType", "publishedAt");

-- CreateIndex for ConsentRecord user policy queries
CREATE INDEX "ConsentRecord_userId_policyType_createdAt_idx" ON "ConsentRecord"("userId", "policyType", "createdAt");

-- CreateIndex for ConsentRecord organization queries
CREATE INDEX "ConsentRecord_organizationId_userId_idx" ON "ConsentRecord"("organizationId", "userId");

-- CreateIndex for ConsentRecord user policy action history
CREATE INDEX "ConsentRecord_userId_policyType_action_createdAt_idx" ON "ConsentRecord"("userId", "policyType", "action", "createdAt");

-- CreateUniqueIndex for DisclosureReceipt hash
CREATE UNIQUE INDEX "DisclosureReceipt_receiptHash_key" ON "DisclosureReceipt"("receiptHash");

-- CreateIndex for DisclosureReceipt organization queries
CREATE INDEX "DisclosureReceipt_organizationId_proofId_idx" ON "DisclosureReceipt"("organizationId", "proofId");

-- CreateIndex for DisclosureReceipt organization timeline
CREATE INDEX "DisclosureReceipt_organizationId_createdAt_idx" ON "DisclosureReceipt"("organizationId", "createdAt");

-- CreateIndex for DisclosureReceipt expiration cleanup
CREATE INDEX "DisclosureReceipt_expiresAt_idx" ON "DisclosureReceipt"("expiresAt");

-- AddForeignKey for ApiKeyQuota to ApiKey
ALTER TABLE "ApiKeyQuota" ADD CONSTRAINT "ApiKeyQuota_apiKeyId_fkey" 
    FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for ProofSharingEvent to Proof
ALTER TABLE "ProofSharingEvent" ADD CONSTRAINT "ProofSharingEvent_proofId_fkey" 
    FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for ProofSharingEvent to Organization
ALTER TABLE "ProofSharingEvent" ADD CONSTRAINT "ProofSharingEvent_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for ConsentRecord to User
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_userId_fkey" 
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for ConsentRecord to Organization
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for DisclosureReceipt to Organization
ALTER TABLE "DisclosureReceipt" ADD CONSTRAINT "DisclosureReceipt_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for DisclosureReceipt to Proof
ALTER TABLE "DisclosureReceipt" ADD CONSTRAINT "DisclosureReceipt_proofId_fkey" 
    FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE CASCADE ON UPDATE CASCADE;