-- Create enum for verification provenance source types
CREATE TYPE "VerificationProvenanceSourceType" AS ENUM (
  'CREDENTIAL_SOURCE',
  'BACKEND_OBSERVATION',
  'CONTRACT_OBSERVATION',
  'STELLAR_OBSERVATION'
);

-- Create VerificationProvenance table to store versioned provenance graphs
CREATE TABLE "VerificationProvenance" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "proofId" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "decisionInputHash" TEXT NOT NULL,
  "credentialHash" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "proofStatus" TEXT NOT NULL,
  "verificationResult" TEXT NOT NULL,
  "failureReason" TEXT,
  "boundaryContext" TEXT,
  "sources" JSONB NOT NULL,
  "sourceCount" INTEGER NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VerificationProvenance_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Create unique index on (proofId, decidedAt) to enforce one provenance per decision timestamp
CREATE UNIQUE INDEX "VerificationProvenance_proofId_decidedAt_key" ON "VerificationProvenance"("proofId", "decidedAt");

-- Create indexes for efficient querying
CREATE INDEX "VerificationProvenance_proofId_createdAt_idx" ON "VerificationProvenance"("proofId", "createdAt");
CREATE INDEX "VerificationProvenance_verificationResult_idx" ON "VerificationProvenance"("verificationResult");
CREATE INDEX "VerificationProvenance_createdAt_idx" ON "VerificationProvenance"("createdAt");

-- Create VerificationProvenanceSource table for individual source records
CREATE TABLE "VerificationProvenanceSource" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provenanceId" TEXT NOT NULL,
  "proofId" TEXT NOT NULL,
  "sourceType" "VerificationProvenanceSourceType" NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceLabel" TEXT,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "observationOrder" INTEGER NOT NULL,
  "missingLinkReason" TEXT,
  "decidedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VerificationProvenanceSource_provenanceId_fkey" FOREIGN KEY ("provenanceId") REFERENCES "VerificationProvenance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Create unique index on (provenanceId, observationOrder) to ensure ordering integrity
CREATE UNIQUE INDEX "VerificationProvenanceSource_provenanceId_observationOrder_key" ON "VerificationProvenanceSource"("provenanceId", "observationOrder");

-- Create indexes for efficient querying
CREATE INDEX "VerificationProvenanceSource_provenanceId_createdAt_idx" ON "VerificationProvenanceSource"("provenanceId", "createdAt");
CREATE INDEX "VerificationProvenanceSource_proofId_sourceType_idx" ON "VerificationProvenanceSource"("proofId", "sourceType");
CREATE INDEX "VerificationProvenanceSource_sourceId_idx" ON "VerificationProvenanceSource"("sourceId");
CREATE INDEX "VerificationProvenanceSource_missingLinkReason_idx" ON "VerificationProvenanceSource"("missingLinkReason");
