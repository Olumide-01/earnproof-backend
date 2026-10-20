-- Acknowledgement store for expected contract configuration drift.
-- Allows operators to suppress blocking drift during upgrades for a bounded window.
CREATE TABLE "ContractDriftAcknowledgement" (
  "id"             TEXT         NOT NULL,
  "driftKey"       TEXT         NOT NULL,
  "acknowledgedBy" TEXT         NOT NULL,
  "note"           TEXT         NOT NULL,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractDriftAcknowledgement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContractDriftAcknowledgement_driftKey_expiresAt_idx" ON "ContractDriftAcknowledgement"("driftKey", "expiresAt");
CREATE INDEX "ContractDriftAcknowledgement_expiresAt_idx"           ON "ContractDriftAcknowledgement"("expiresAt");