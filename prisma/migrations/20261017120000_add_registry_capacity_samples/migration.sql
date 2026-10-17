-- migration-safety: compatibility=additive
-- migration-safety: rollback=drop-table-RegistryCapacitySample

-- CreateEnum
CREATE TYPE "CapacityResourceType" AS ENUM ('ISSUER', 'SCHEMA', 'PROOF', 'STORAGE');
CREATE TYPE "AlertState" AS ENUM ('CLEAR', 'WARNING', 'CRITICAL', 'STALE');

-- CreateTable: RegistryCapacitySample
--
-- Bounded aggregate samples for capacity trend analysis.
-- No private records: only aggregate counts are persisted.
-- The UNIQUE constraint on sampleHash enforces replay detection.
CREATE TABLE "RegistryCapacitySample" (
  "id"           TEXT                  NOT NULL,
  "resourceType" "CapacityResourceType" NOT NULL,
  "count"        BIGINT                NOT NULL,
  "sampleHash"   TEXT                  NOT NULL,
  "sampledAt"    TIMESTAMP(3)          NOT NULL,
  "createdAt"    TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RegistryCapacitySample_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "RegistryCapacitySample_sampleHash_key"
  ON "RegistryCapacitySample"("sampleHash");

CREATE INDEX "RegistryCapacitySample_resourceType_sampledAt_idx"
  ON "RegistryCapacitySample"("resourceType", "sampledAt");

CREATE INDEX "RegistryCapacitySample_sampledAt_idx"
  ON "RegistryCapacitySample"("sampledAt");