-- Replay-protection nonce store for signed API requests.
-- Each row represents a nonce consumed within the active clock window.
-- Rows auto-expire (expiresAt); a periodic sweep deletes old rows.
-- NEVER stores IP addresses, request bodies, path parameters, or user agents.
CREATE TABLE "RequestNonce" (
  "id"        TEXT         NOT NULL,
  -- SHA-256 of (keyId || ":" || rawNonce) so raw nonces are never persisted.
  "nonceHash" TEXT         NOT NULL,
  "apiKeyId"  TEXT         NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RequestNonce_pkey" PRIMARY KEY ("id")
);

-- Unique constraint drives the INSERT … ON CONFLICT DO NOTHING replay check.
CREATE UNIQUE INDEX "RequestNonce_nonceHash_key" ON "RequestNonce"("nonceHash");

-- Support expired-row sweep and per-key cleanup.
CREATE INDEX "RequestNonce_apiKeyId_expiresAt_idx" ON "RequestNonce"("apiKeyId", "expiresAt");
CREATE INDEX "RequestNonce_expiresAt_idx"           ON "RequestNonce"("expiresAt");