-- CreateEnum
CREATE TYPE "ApiKeyEndpointCategory" AS ENUM ('PROOF', 'PAYMENT', 'CREDENTIAL', 'ORGANIZATION', 'AUTH_CONTEXT', 'OTHER');

-- CreateEnum
CREATE TYPE "ApiKeyUsageOutcome" AS ENUM ('SUCCESS', 'FORBIDDEN', 'ERROR');

-- CreateTable
-- Privacy-safe per-key, per-category, per-outcome usage summary.
-- Incremented atomically via raw SQL upsert. Never stores IP addresses,
-- request bodies, path parameters, or user-agent strings.
-- lastUsedAt is rounded to the nearest minute to prevent per-request timing reconstruction.
-- revokedSummaryFrozenAt is set once on revocation; rows are not updated after that.
CREATE TABLE "ApiKeyUsageSummary" (
  "id"                     TEXT         NOT NULL,
  "apiKeyId"               TEXT         NOT NULL,
  "category"               "ApiKeyEndpointCategory" NOT NULL,
  "outcome"                "ApiKeyUsageOutcome"      NOT NULL,
  "requestCount"           BIGINT       NOT NULL DEFAULT 0,
  "lastUsedAt"             TIMESTAMP(3),
  "revokedSummaryFrozenAt" TIMESTAMP(3),
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ApiKeyUsageSummary_pkey" PRIMARY KEY ("id")
);

-- Unique bucket: one row per (key x category x outcome). Target of the atomic upsert.
CREATE UNIQUE INDEX "ApiKeyUsageSummary_apiKeyId_category_outcome_key"
  ON "ApiKeyUsageSummary"("apiKeyId", "category", "outcome");

-- Support listing all buckets for a key (the common dashboard query).
CREATE INDEX "ApiKeyUsageSummary_apiKeyId_idx"
  ON "ApiKeyUsageSummary"("apiKeyId");

-- Support inactivity sweeps.
CREATE INDEX "ApiKeyUsageSummary_lastUsedAt_idx"
  ON "ApiKeyUsageSummary"("lastUsedAt");

-- Cascading delete keeps summaries consistent with key lifecycle.
ALTER TABLE "ApiKeyUsageSummary"
  ADD CONSTRAINT "ApiKeyUsageSummary_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
