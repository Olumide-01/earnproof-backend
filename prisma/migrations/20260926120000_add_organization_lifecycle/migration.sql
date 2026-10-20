-- Issue #172: organization archival and deletion workflow.
--
-- Additive only. Every existing organization has NULL in all four columns,
-- which is the "live" lifecycle state: nothing about current behaviour changes
-- until an administrator archives an organization.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "legalHoldAt" TIMESTAMP(3),
ADD COLUMN     "legalHoldReference" VARCHAR(64);

-- CreateIndex
CREATE INDEX "Organization_archivedAt_idx" ON "Organization"("archivedAt");
