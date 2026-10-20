-- migration-safety: compatibility=additive
-- migration-safety: rollback=drop-table-ContractCompatibilityAssessment

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED');
CREATE TYPE "FindingSeverity" AS ENUM ('BLOCKING', 'WARNING', 'INFO');
CREATE TYPE "CompatibilityCheckKind" AS ENUM ('ABI', 'STORAGE', 'DEPENDENCY', 'CLIENT', 'MIGRATION');

-- CreateTable: ContractCompatibilityAssessment
--
-- Immutability guarantee: once status = 'COMPLETE' the findingsHash and findings
-- columns are never updated.  Any re-run creates a new row.
-- The UNIQUE constraint on findingsHash is the replay-detection gate.
CREATE TABLE "ContractCompatibilityAssessment" (
  "id"                  TEXT          NOT NULL,
  "proofId"             TEXT          NOT NULL,
  "version"             TEXT          NOT NULL,
  "findingsHash"        TEXT,
  "status"              "AssessmentStatus" NOT NULL DEFAULT 'PENDING',
  "requestedBy"         TEXT          NOT NULL,
  "artifactVersion"     TEXT          NOT NULL,
  "hasBlockingFindings" BOOLEAN       NOT NULL DEFAULT false,
  "findings"            JSONB,
  "lastErrorSafe"       TEXT,
  "completedAt"         TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractCompatibilityAssessment_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "ContractCompatibilityAssessment_findingsHash_key"
  ON "ContractCompatibilityAssessment"("findingsHash");

CREATE INDEX "ContractCompatibilityAssessment_proofId_idx"
  ON "ContractCompatibilityAssessment"("proofId");

CREATE INDEX "ContractCompatibilityAssessment_status_idx"
  ON "ContractCompatibilityAssessment"("status");

CREATE INDEX "ContractCompatibilityAssessment_requestedBy_idx"
  ON "ContractCompatibilityAssessment"("requestedBy");

-- Foreign key: proofId → Proof.id
ALTER TABLE "ContractCompatibilityAssessment"
  ADD CONSTRAINT "ContractCompatibilityAssessment_proofId_fkey"
  FOREIGN KEY ("proofId") REFERENCES "Proof"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
