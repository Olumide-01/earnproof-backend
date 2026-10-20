-- #160: per-organization operational quotas.
--
-- Fixed-window counters for rate-style quotas. Count-style quotas (active API
-- keys, webhooks) are derived from their own tables under an organization row
-- lock and need no storage here.

CREATE TABLE "OrganizationQuotaUsage" (
    "organizationId" TEXT NOT NULL,
    "quota"          TEXT NOT NULL,
    "windowStart"    TIMESTAMP(3) NOT NULL,
    "count"          INTEGER NOT NULL DEFAULT 0,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizationQuotaUsage_pkey" PRIMARY KEY ("organizationId", "quota", "windowStart"),
    CONSTRAINT "OrganizationQuotaUsage_count_check" CHECK ("count" >= 0)
);

ALTER TABLE "OrganizationQuotaUsage"
    ADD CONSTRAINT "OrganizationQuotaUsage_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "OrganizationQuotaUsage_windowStart_idx" ON "OrganizationQuotaUsage"("windowStart");
