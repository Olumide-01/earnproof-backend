-- Add networkPassphrase and origin fields to WalletChallenge
-- These fields are nullable to support legacy challenges created before this migration
ALTER TABLE "WalletChallenge" ADD COLUMN "networkPassphrase" TEXT;
ALTER TABLE "WalletChallenge" ADD COLUMN "origin" TEXT;
