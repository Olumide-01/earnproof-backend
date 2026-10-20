-- Operational metric downsampling with retention tiers (#330).
-- Additive only: three new tables and two enums; no existing table changes.
-- Rollback: drop OperationalMetricWatermark, OperationalMetricRollup,
-- OperationalMetricContribution, then the two enums. No other data depends
-- on these tables.

-- CreateEnum
CREATE TYPE "OperationalMetricTier" AS ENUM ('MINUTE', 'HOUR', 'DAY');

-- CreateEnum
CREATE TYPE "OperationalMetricKind" AS ENUM ('COUNTER', 'HISTOGRAM');

-- CreateTable
CREATE TABLE "OperationalMetricContribution" (
    "id" TEXT NOT NULL,
    "sourceId" VARCHAR(64) NOT NULL,
    "captureSeq" INTEGER NOT NULL,
    "metric" VARCHAR(64) NOT NULL,
    "kind" "OperationalMetricKind" NOT NULL,
    "seriesKey" VARCHAR(512) NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "sum" DOUBLE PRECISION NOT NULL,
    "count" INTEGER,
    "bucketCounts" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalMetricContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalMetricRollup" (
    "id" TEXT NOT NULL,
    "tier" "OperationalMetricTier" NOT NULL,
    "metric" VARCHAR(64) NOT NULL,
    "kind" "OperationalMetricKind" NOT NULL,
    "seriesKey" VARCHAR(512) NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "sum" DOUBLE PRECISION NOT NULL,
    "count" INTEGER,
    "bucketCounts" JSONB,
    "sampleCount" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalMetricRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalMetricWatermark" (
    "tier" "OperationalMetricTier" NOT NULL,
    "rolledThrough" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalMetricWatermark_pkey" PRIMARY KEY ("tier")
);

-- CreateIndex
CREATE INDEX "OperationalMetricContribution_bucketStart_idx" ON "OperationalMetricContribution"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalMetricContribution_sourceId_captureSeq_metric_se_key" ON "OperationalMetricContribution"("sourceId", "captureSeq", "metric", "seriesKey");

-- CreateIndex
CREATE INDEX "OperationalMetricRollup_tier_bucketStart_idx" ON "OperationalMetricRollup"("tier", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalMetricRollup_tier_metric_seriesKey_bucketStart_key" ON "OperationalMetricRollup"("tier", "metric", "seriesKey", "bucketStart");
