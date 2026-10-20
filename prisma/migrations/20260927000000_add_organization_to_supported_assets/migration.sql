-- Add organizationId, decimals, and revision columns to SupportedAsset
-- This enables organization scoping for asset management with role-based access control

-- Add organizationId column (temporarily nullable)
ALTER TABLE "SupportedAsset" ADD COLUMN "organizationId" TEXT;

-- Add decimals column with default value
ALTER TABLE "SupportedAsset" ADD COLUMN "decimals" INTEGER NOT NULL DEFAULT 7;

-- Add revision column for optimistic locking
ALTER TABLE "SupportedAsset" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- Drop the existing unique constraint on assetKey
ALTER TABLE "SupportedAsset" DROP CONSTRAINT IF EXISTS "SupportedAsset_assetKey_key";

-- For existing rows, set organizationId to the first organization's ID (migration safety)
-- In production, this should be reviewed and updated appropriately
UPDATE "SupportedAsset" 
SET "organizationId" = (SELECT "id" FROM "Organization" LIMIT 1)
WHERE "organizationId" IS NULL;

-- Now make organizationId non-nullable
ALTER TABLE "SupportedAsset" ALTER COLUMN "organizationId" SET NOT NULL;

-- Create unique constraint on (organizationId, assetKey) instead of just assetKey
-- This allows the same asset to exist across different organizations
CREATE UNIQUE INDEX "SupportedAsset_organizationId_assetKey_key" 
    ON "SupportedAsset"("organizationId", "assetKey");

-- Create index for efficient filtering by organization and status
CREATE INDEX "SupportedAsset_organizationId_status_idx" 
    ON "SupportedAsset"("organizationId", "status");

-- Add foreign key constraint
ALTER TABLE "SupportedAsset" ADD CONSTRAINT "SupportedAsset_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
