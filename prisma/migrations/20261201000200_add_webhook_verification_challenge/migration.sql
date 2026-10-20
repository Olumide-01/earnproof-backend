-- Webhook destination-ownership verification challenges (issue #193).
-- Only a hash of the opaque challenge token is ever stored.

CREATE TABLE "WebhookVerificationChallenge" (
  "id" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WebhookVerificationChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebhookVerificationChallenge_tokenHash_key" ON "WebhookVerificationChallenge"("tokenHash");
CREATE INDEX "WebhookVerificationChallenge_webhookId_idx" ON "WebhookVerificationChallenge"("webhookId");
CREATE INDEX "WebhookVerificationChallenge_expiresAt_idx" ON "WebhookVerificationChallenge"("expiresAt");

ALTER TABLE "WebhookVerificationChallenge" ADD CONSTRAINT "WebhookVerificationChallenge_webhookId_fkey"
  FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
