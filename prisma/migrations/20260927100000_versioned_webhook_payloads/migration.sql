-- #158: versioned webhook payload schemas.
--
-- Every delivery row now records the payload schema version it was serialized
-- with and the exact request body bytes that were signed. Retries, replays and
-- redrives copy both verbatim, so an event is never re-serialized (JSONB does
-- not preserve key order, so re-serializing `payload` can change the bytes).

ALTER TABLE "Webhook" ADD COLUMN "payloadVersion" TEXT NOT NULL DEFAULT '1';

ALTER TABLE "WebhookDelivery" ADD COLUMN "schemaVersion" TEXT;
ALTER TABLE "WebhookDelivery" ADD COLUMN "payloadBody" TEXT;

-- Backfill rows written before versioning. They were produced by the version-1
-- serializer; their original bytes were never stored, so the canonical JSONB
-- text is the best stable representation and is what later attempts will sign.
UPDATE "WebhookDelivery"
SET "schemaVersion" = '1',
    "payloadBody"   = "payload"::text
WHERE "schemaVersion" IS NULL OR "payloadBody" IS NULL;

ALTER TABLE "WebhookDelivery" ALTER COLUMN "schemaVersion" SET NOT NULL;
ALTER TABLE "WebhookDelivery" ALTER COLUMN "payloadBody" SET NOT NULL;
