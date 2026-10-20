-- Issue #307: Project issuer policy commitment history.
-- Tracks exact issuer policy commitment version effective at proof issuance.
--
-- Additive only. New table, and nullable columns on Proof/Attestation.
-- Existing proofs/attestations continue to work without migration.

-- CreateTable: IssuerPolicyCommitment
-- Immutable audit trail of issuer policy versions with deterministic commit hashes.
CREATE TABLE "IssuerPolicyCommitment" (
    "id" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    
    -- Version tracking: incremental per issuer
    "version" INTEGER NOT NULL,
    
    -- Commitment identification
    "commitment" TEXT NOT NULL,  -- "sha256:<hex>"
    "policyInputsHash" TEXT NOT NULL,  -- hash of canonical policy inputs
    
    -- Policy snapshot (immutable after creation)
    "policySnapshot" JSONB NOT NULL,  -- {signingKeyVersionId, metadata, address, ...}
    
    -- Lifecycle
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    
    -- Audit & correlation
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuerPolicyCommitment_pkey" PRIMARY KEY ("id")
);

-- Unique constraints to prevent duplicates and ensure version continuity
CREATE UNIQUE INDEX "IssuerPolicyCommitment_issuerId_version_key" ON "IssuerPolicyCommitment"("issuerId", "version");
CREATE UNIQUE INDEX "IssuerPolicyCommitment_commitment_key" ON "IssuerPolicyCommitment"("commitment");

-- Queries for current and historical lookups
CREATE INDEX "IssuerPolicyCommitment_issuerId_effectiveAt_idx" ON "IssuerPolicyCommitment"("issuerId", "effectiveAt");
CREATE INDEX "IssuerPolicyCommitment_issuerId_supersededAt_idx" ON "IssuerPolicyCommitment"("issuerId", "supersededAt");

-- Foreign key to issuer
ALTER TABLE "IssuerPolicyCommitment" ADD CONSTRAINT "IssuerPolicyCommitment_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "Issuer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: Proof
-- Capture issuer policy commitment at proof issuance time (similar to assetPolicySnapshot)
ALTER TABLE "Proof" ADD COLUMN "issuerPolicyCommitmentId" TEXT,
ADD COLUMN "issuerPolicySnapshot" JSONB;

-- AlterTable: Attestation
-- Track policy version for attestation-based proofs
ALTER TABLE "Attestation" ADD COLUMN "policyVersion" TEXT;

-- Optional: Add foreign key constraint to Proof (but use INT for lookups, not constraint)
-- This allows proofs to reference a historical snapshot even if issuer policies change
CREATE INDEX "Proof_issuerPolicyCommitmentId_idx" ON "Proof"("issuerPolicyCommitmentId");

