-- #159: webhook dead-letter inspection and controlled redrive.

ALTER TABLE "WebhookDelivery" ADD COLUMN "deadLetteredAt"   TIMESTAMP(3);
ALTER TABLE "WebhookDelivery" ADD COLUMN "deadLetterReason" TEXT;
ALTER TABLE "WebhookDelivery" ADD COLUMN "redrivenAt"       TIMESTAMP(3);
ALTER TABLE "WebhookDelivery" ADD COLUMN "redrivenBy"       TEXT;
ALTER TABLE "WebhookDelivery" ADD COLUMN "redriveReason"    TEXT;

CREATE INDEX "WebhookDelivery_deadLetteredAt_idx" ON "WebhookDelivery"("deadLetteredAt");

-- Existing terminal failures: the last FAILED attempt of each event chain that
-- has no later attempt and reached the historical 5-attempt threshold is marked
-- dead-lettered so operators can see and redrive it.
UPDATE "WebhookDelivery" d
SET "deadLetteredAt"   = COALESCE(d."deliveredAt", d."createdAt"),
    "deadLetterReason" = 'max_attempts_exhausted'
WHERE d."status" = 'FAILED'
  AND d."attempt" >= 5
  AND NOT EXISTS (
      SELECT 1 FROM "WebhookDelivery" later
      WHERE later."webhookId" = d."webhookId"
        AND later."eventId" = d."eventId"
        AND later."createdAt" > d."createdAt"
  );
