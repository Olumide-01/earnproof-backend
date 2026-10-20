-- Add revision field to Organization for optimistic concurrency control
ALTER TABLE "Organization" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- Add revision field to Issuer for optimistic concurrency control
ALTER TABLE "Issuer" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- Add revision field to TrustedSource for optimistic concurrency control
ALTER TABLE "TrustedSource" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- Add revision field to Webhook for optimistic concurrency control
ALTER TABLE "Webhook" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
