-- CreateTable SecretRetrievalReceipt
-- Persists evidence that a one-time secret (API key, webhook signing secret, or export token)
-- was revealed to a user or client, without storing the secret itself.
-- 
-- Design:
-- - secretType: Type of secret revealed (api_key | webhook | export)
-- - resourceId: ID of the resource (API key ID, webhook ID, export job ID)
-- - resourceReference: Human-readable identifier (e.g., API key prefix, webhook URL) for user reference
-- - recipientId: Who received the secret (user ID, API key prefix, or null for capability URLs)
-- - deliveryChannel: How the secret was delivered (http_response | download_url | email)
-- - revealedAt: Exact timestamp when the secret was revealed
-- - acknowledgementHash: SHA-256(resourceId | secretType | revealedAt | orgSalt) for audit proof
--   This hash cannot be reversed to recover the secret; it's purely evidence of revelation
-- - status: Lifecycle status (ACTIVE | EXPIRED | REVOKED)
-- - expiresAt: When the receipt itself expires (independent of secret expiry)
-- - metadata: JSON for optional context (IP, user agent, reason, etc.)
-- - hash/hashVersion/prevHash: Audit chain fields (like AuditLog pattern)
-- 
-- Constraints:
-- - Unique on (organizationId, resourceId, secretType, revealedAt) to prevent duplicates
-- - Indexes for org+secret lookups and expiry cleanup
-- 
-- Atomicity:
-- - Receipt creation always occurs in the same transaction as secret creation
-- - Successful secret reveal → successful receipt creation (or entire transaction fails)

CREATE TABLE "SecretRetrievalReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "secretType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceReference" TEXT,
    "recipientId" TEXT,
    "deliveryChannel" TEXT NOT NULL DEFAULT 'http_response',
    "revealedAt" TIMESTAMP(3) NOT NULL,
    "acknowledgementHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "hashVersion" INTEGER NOT NULL DEFAULT 1,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretRetrievalReceipt_pkey" PRIMARY KEY ("id")
);

-- Unique constraint to prevent duplicate receipts for the same secret revelation
-- (organizationId, resourceId, secretType, revealedAt) uniquely identifies a secret revelation
CREATE UNIQUE INDEX "SecretRetrievalReceipt_organizationId_resourceId_secretType_revealedAt_key" 
    ON "SecretRetrievalReceipt"("organizationId", "resourceId", "secretType", "revealedAt");

-- Index for organization + secret type + resource lookups (common query pattern)
CREATE INDEX "SecretRetrievalReceipt_organizationId_secretType_resourceId_idx" 
    ON "SecretRetrievalReceipt"("organizationId", "secretType", "resourceId");

-- Index for expiry cleanup (find expired receipts)
CREATE INDEX "SecretRetrievalReceipt_organizationId_status_expiresAt_idx" 
    ON "SecretRetrievalReceipt"("organizationId", "status", "expiresAt");

-- Index for organization timeline queries
CREATE INDEX "SecretRetrievalReceipt_organizationId_createdAt_idx" 
    ON "SecretRetrievalReceipt"("organizationId", "createdAt");

-- Add foreign key to Organization
ALTER TABLE "SecretRetrievalReceipt" ADD CONSTRAINT "SecretRetrievalReceipt_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
