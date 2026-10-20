-- Migration: add_device_fingerprint_and_revocation_reason
-- Adds optional fields to AuthSession for device tracking and revocation audit trails.

-- AlterTable: Add optional fields for session inventory and remote revocation
ALTER TABLE "AuthSession" ADD COLUMN "deviceFingerprint" TEXT,
ADD COLUMN "revocationReason" TEXT;

-- Create index for device fingerprint lookups (optional but useful for analytics)
CREATE INDEX "AuthSession_deviceFingerprint_idx" ON "AuthSession"("deviceFingerprint");
