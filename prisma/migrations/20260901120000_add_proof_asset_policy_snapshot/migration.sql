-- Snapshot of the SupportedAsset policy that was live-validated at proof
-- issuance time. This is intentionally not a foreign key: the registry row
-- referenced by assetPolicyId may later be deactivated (or removed), and an
-- already-issued proof must remain verifiable purely from this snapshot,
-- without re-consulting the live (possibly since-changed) SupportedAsset row.
ALTER TABLE "Proof"
ADD COLUMN "assetPolicyId" TEXT,
ADD COLUMN "assetPolicySnapshot" JSONB;
