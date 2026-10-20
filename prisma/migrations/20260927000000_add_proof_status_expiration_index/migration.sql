-- CreateIndex
-- Add compound index on (status, expiresAt) for proof expiration reconciliation queries.
-- This index optimizes the query: WHERE status = 'ACTIVE' AND expiresAt <= NOW()
-- used by the ProofExpirationReconcilerService.
CREATE INDEX "Proof_status_expiresAt_idx" ON "Proof"("status", "expiresAt");
