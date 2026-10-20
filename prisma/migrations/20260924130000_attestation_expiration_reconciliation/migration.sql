-- Issuer attestation expiration reconciliation (#207).
--
-- Attestations can expire after creation. Their effective status is reconciled
-- by a scheduled job that must find expired attestations cheaply and record when
-- each was last evaluated, without mutating the historical signed evidence.

-- New effective status reached by attestations whose expiry has passed. Added
-- to the shared ResourceStatus enum; other resources never take this value.
ALTER TYPE "ResourceStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

-- When the reconciler last evaluated this attestation. Null until first checked.
ALTER TABLE "Attestation" ADD COLUMN "reconciledAt" TIMESTAMP(3);

-- Lets the reconciler select ACTIVE attestations past their expiry without
-- scanning the whole table.
CREATE INDEX "Attestation_status_expiresAt_idx"
  ON "Attestation"("status", "expiresAt");
