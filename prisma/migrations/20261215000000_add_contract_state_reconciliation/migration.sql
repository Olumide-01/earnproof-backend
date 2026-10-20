-- Contract state checkpoint digest comparison and reconciliation
-- Supports fail-closed verification and bounded findings queries

-- Persists mismatches between backend projections and live contract digests
CREATE TABLE "ContractStateCheckpointMismatch" (
  "id"                 TEXT         NOT NULL,
  "network"            TEXT         NOT NULL,
  "contractId"         TEXT         NOT NULL,
  "checkpointNumber"   TEXT         NOT NULL, -- BigInt as TEXT to preserve precision
  "digestVersion"      TEXT         NOT NULL,
  "componentName"      TEXT         NOT NULL,
  "expectedValue"      TEXT         NOT NULL,
  "observedValue"      TEXT         NOT NULL,
  "detectionTime"      TIMESTAMP(3) NOT NULL,
  "runId"              TEXT         NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractStateCheckpointMismatch_pkey" PRIMARY KEY ("id")
);

-- Composite unique constraint: ensure mismatch is recorded at most once per run
CREATE UNIQUE INDEX "ContractStateCheckpointMismatch_unique_per_run" ON "ContractStateCheckpointMismatch"(
  "network",
  "contractId",
  "checkpointNumber",
  "digestVersion",
  "componentName",
  "runId"
);

-- Indexes for common queries
CREATE INDEX "ContractStateCheckpointMismatch_network_contractId_checkpoint_idx" ON "ContractStateCheckpointMismatch"(
  "network",
  "contractId",
  "checkpointNumber"
);

CREATE INDEX "ContractStateCheckpointMismatch_network_createdAt_idx" ON "ContractStateCheckpointMismatch"(
  "network",
  "createdAt"
);

CREATE INDEX "ContractStateCheckpointMismatch_runId_idx" ON "ContractStateCheckpointMismatch"("runId");

-- Persists verification failures (fetch errors, version/network mismatches, staleness)
CREATE TABLE "ContractStateVerificationFailure" (
  "id"               TEXT         NOT NULL,
  "network"          TEXT         NOT NULL,
  "contractId"       TEXT         NOT NULL,
  "digestVersion"    TEXT,              -- May be unknown/empty
  "failureCode"      TEXT         NOT NULL, -- e.g. UNKNOWN_VERSION, NETWORK_MISMATCH, RPC_ERROR
  "failureMessage"   TEXT         NOT NULL, -- Redacted, no sensitive data
  "detectionTime"    TIMESTAMP(3) NOT NULL,
  "runId"            TEXT         NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractStateVerificationFailure_pkey" PRIMARY KEY ("id")
);

-- Indexes for common queries
CREATE INDEX "ContractStateVerificationFailure_network_contractId_idx" ON "ContractStateVerificationFailure"(
  "network",
  "contractId"
);

CREATE INDEX "ContractStateVerificationFailure_failureCode_createdAt_idx" ON "ContractStateVerificationFailure"(
  "failureCode",
  "createdAt"
);

CREATE INDEX "ContractStateVerificationFailure_runId_idx" ON "ContractStateVerificationFailure"("runId");

-- Tracks the last comparison run per (network, contractId) for operational visibility
CREATE TABLE "ContractStateReconciliationRun" (
  "id"                 TEXT         NOT NULL,
  "network"            TEXT         NOT NULL,
  "contractId"         TEXT         NOT NULL,
  "checkpointNumber"   TEXT         NOT NULL, -- BigInt as TEXT
  "digestVersion"      TEXT,              -- The digest version from the contract (if successful)
  "runId"              TEXT         NOT NULL, -- References mismatches and failures
  "verificationStatus" TEXT         NOT NULL, -- PASSED or FAILED
  "comparisonStatus"   TEXT,              -- MATCH, MISMATCH, or null if verification failed
  "mismatchCount"      INT,               -- Number of component mismatches, null if verification failed
  "detectedAt"         TIMESTAMP(3) NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractStateReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- Indexes for operational queries
CREATE INDEX "ContractStateReconciliationRun_network_contractId_detectedAt_idx" ON "ContractStateReconciliationRun"(
  "network",
  "contractId",
  "detectedAt" DESC
);

CREATE UNIQUE INDEX "ContractStateReconciliationRun_runId_idx" ON "ContractStateReconciliationRun"("runId");
