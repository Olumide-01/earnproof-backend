-- Revocation propagation reconciliation (issue #212): tracks whether a
-- revoked proof's anchoring-intent and webhook-delivery channels have both
-- been observed confirmed (or not applicable).

ALTER TABLE "Proof" ADD COLUMN "revocationPropagationConfirmedAt" TIMESTAMP(3);

CREATE INDEX "Proof_status_revocationPropagationConfirmedAt_idx" ON "Proof"("status", "revocationPropagationConfirmedAt");
