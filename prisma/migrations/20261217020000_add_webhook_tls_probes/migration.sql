-- Issue #315: webhook endpoint TLS posture probes.
-- Additive only. Probe rows hold an outcome category and public certificate
-- facts; resolved addresses and raw error text are never stored.

-- CreateEnum
CREATE TYPE "WebhookTlsProbeOutcome" AS ENUM ('HEALTHY', 'EXPIRING_SOON', 'EXPIRED', 'NOT_YET_VALID', 'HOSTNAME_MISMATCH', 'UNTRUSTED', 'WEAK_PROTOCOL', 'HANDSHAKE_FAILED', 'DESTINATION_BLOCKED', 'UNREACHABLE', 'TIMEOUT');

-- CreateTable
CREATE TABLE "WebhookTlsProbe" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "outcome" "WebhookTlsProbeOutcome" NOT NULL,
    "protocol" VARCHAR(16),
    "certificateNotBefore" TIMESTAMP(3),
    "certificateNotAfter" TIMESTAMP(3),
    "certificateFingerprint" VARCHAR(95),
    "alerted" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER NOT NULL,
    "probedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookTlsProbe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookTlsProbe_webhookId_probedAt_idx" ON "WebhookTlsProbe"("webhookId", "probedAt");

-- CreateIndex
CREATE INDEX "WebhookTlsProbe_outcome_probedAt_idx" ON "WebhookTlsProbe"("outcome", "probedAt");

-- AddForeignKey
ALTER TABLE "WebhookTlsProbe" ADD CONSTRAINT "WebhookTlsProbe_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
