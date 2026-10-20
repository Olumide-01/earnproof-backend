-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED');
CREATE TYPE "DisputeEvidenceRole" AS ENUM ('PROOF_OWNER', 'ISSUER', 'ADMIN', 'VERIFIER');

CREATE TABLE "ProofDispute" (
  "id"          TEXT NOT NULL,
  "proofId"     TEXT NOT NULL,
  "status"      "DisputeStatus" NOT NULL DEFAULT 'OPEN',
  "reason"      TEXT NOT NULL,
  "openerHash"  TEXT NOT NULL,
  "resolvedAt"  TIMESTAMP(3),
  "resolution"  TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProofDispute_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DisputeEvidenceManifest" (
  "id"                      TEXT NOT NULL,
  "disputeId"               TEXT NOT NULL,
  "version"                 TEXT NOT NULL,
  "manifestHash"            TEXT NOT NULL,
  "submitterRole"           "DisputeEvidenceRole" NOT NULL,
  "submitterHash"           TEXT NOT NULL,
  "algorithms"              JSONB NOT NULL,
  "storageRefs"             JSONB NOT NULL,
  "contractTransactionHash" TEXT,
  "contractConfirmedAt"     TIMESTAMP(3),
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DisputeEvidenceManifest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProofDispute_proofId_idx" ON "ProofDispute"("proofId");
CREATE INDEX "ProofDispute_status_idx"  ON "ProofDispute"("status");
CREATE UNIQUE INDEX "DisputeEvidenceManifest_manifestHash_key" ON "DisputeEvidenceManifest"("manifestHash");
CREATE INDEX "DisputeEvidenceManifest_disputeId_idx"    ON "DisputeEvidenceManifest"("disputeId");
CREATE INDEX "DisputeEvidenceManifest_submitterRole_idx" ON "DisputeEvidenceManifest"("submitterRole");

ALTER TABLE "ProofDispute" ADD CONSTRAINT "ProofDispute_proofId_fkey"
  FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DisputeEvidenceManifest" ADD CONSTRAINT "DisputeEvidenceManifest_disputeId_fkey"
  FOREIGN KEY ("disputeId") REFERENCES "ProofDispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;