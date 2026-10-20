-- Configuration rollout snapshots and canaries (#329).
-- Additive only: three new tables and three enums; no existing table changes.
-- Snapshots never contain secret values (see docs/config-rollouts.md).
-- Rollback: drop ConfigRolloutEvent, ConfigRollout, ConfigSnapshot, then the
-- three enums.

-- CreateEnum
CREATE TYPE "ConfigSnapshotOrigin" AS ENUM ('CAPTURED', 'IMPORTED');

-- CreateEnum
CREATE TYPE "ConfigRolloutStatus" AS ENUM ('CANARY', 'BLOCKED', 'COMPLETED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ConfigRolloutEventType" AS ENUM ('CREATED', 'GATE_PASSED', 'GATE_FAILED', 'PROMOTED', 'COMPLETED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "ConfigSnapshot" (
    "id" TEXT NOT NULL,
    "environment" VARCHAR(32) NOT NULL,
    "origin" "ConfigSnapshotOrigin" NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "contentHash" VARCHAR(80) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "entries" JSONB NOT NULL,
    "excluded" JSONB NOT NULL,
    "signatureAlg" VARCHAR(32) NOT NULL,
    "signatureKeyId" VARCHAR(64) NOT NULL,
    "signature" VARCHAR(128) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigRollout" (
    "id" TEXT NOT NULL,
    "environment" VARCHAR(32) NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "baselineSnapshotId" TEXT,
    "status" "ConfigRolloutStatus" NOT NULL DEFAULT 'CANARY',
    "stages" INTEGER[],
    "stageIndex" INTEGER NOT NULL DEFAULT 0,
    "stageStartedAt" TIMESTAMP(3) NOT NULL,
    "lastGateEventId" TEXT,
    "lastGatePassed" BOOLEAN,
    "lastGateEvaluatedAt" TIMESTAMP(3),
    "openEnvironmentKey" VARCHAR(32),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfigRollout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigRolloutEvent" (
    "id" TEXT NOT NULL,
    "rolloutId" TEXT NOT NULL,
    "type" "ConfigRolloutEventType" NOT NULL,
    "stageIndex" INTEGER NOT NULL,
    "percent" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfigRolloutEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConfigSnapshot_environment_capturedAt_idx" ON "ConfigSnapshot"("environment", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigSnapshot_environment_contentHash_key" ON "ConfigSnapshot"("environment", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigRollout_openEnvironmentKey_key" ON "ConfigRollout"("openEnvironmentKey");

-- CreateIndex
CREATE INDEX "ConfigRollout_environment_status_idx" ON "ConfigRollout"("environment", "status");

-- CreateIndex
CREATE INDEX "ConfigRolloutEvent_rolloutId_createdAt_idx" ON "ConfigRolloutEvent"("rolloutId", "createdAt");

-- AddForeignKey
ALTER TABLE "ConfigRollout" ADD CONSTRAINT "ConfigRollout_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ConfigSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigRollout" ADD CONSTRAINT "ConfigRollout_baselineSnapshotId_fkey" FOREIGN KEY ("baselineSnapshotId") REFERENCES "ConfigSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigRolloutEvent" ADD CONSTRAINT "ConfigRolloutEvent_rolloutId_fkey" FOREIGN KEY ("rolloutId") REFERENCES "ConfigRollout"("id") ON DELETE CASCADE ON UPDATE CASCADE;
