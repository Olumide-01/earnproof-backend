-- CreateIndex
-- Add compound index on (status, expiresAt) for API key expiration and scheduled revocation queries.
-- This index optimizes the query: WHERE status = 'ACTIVE' AND expiresAt <= CURRENT_TIMESTAMP
-- used by the ApiKeyExpirationJob.
CREATE INDEX "ApiKey_status_expiresAt_idx" ON "ApiKey"("status", "expiresAt");
