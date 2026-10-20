-- Durable execution history for background jobs (issue #201).
-- Stores job identity, lease owner, timing, a single terminal outcome, and a
-- bounded error category. NEVER stores job payloads or secrets.

-- CreateEnum
CREATE TYPE "JobExecutionOutcome" AS ENUM (
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'CRASHED',
  'TIMED_OUT'
);

-- CreateTable
CREATE TABLE "JobExecution" (
  "id" TEXT NOT NULL,
  "jobName" TEXT NOT NULL,
  "jobVersion" TEXT NOT NULL,
  "leaseOwner" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "outcome" "JobExecutionOutcome",
  "errorCategory" TEXT,
  "originalExecutionId" TEXT,
  "retainUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "JobExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobExecution_jobName_startedAt_idx" ON "JobExecution"("jobName", "startedAt");
CREATE INDEX "JobExecution_outcome_idx" ON "JobExecution"("outcome");
CREATE INDEX "JobExecution_retainUntil_idx" ON "JobExecution"("retainUntil");
CREATE INDEX "JobExecution_originalExecutionId_idx" ON "JobExecution"("originalExecutionId");
CREATE INDEX "JobExecution_finishedAt_startedAt_idx" ON "JobExecution"("finishedAt", "startedAt");

-- AddForeignKey
ALTER TABLE "JobExecution"
  ADD CONSTRAINT "JobExecution_originalExecutionId_fkey"
  FOREIGN KEY ("originalExecutionId") REFERENCES "JobExecution"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
