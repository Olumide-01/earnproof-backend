-- Composite indexes supporting deterministic keyset (cursor) pagination
-- ordered by [date field desc, id desc] for the mutable list endpoints
-- covered by issue #188 (proofs already had an equivalent index).

CREATE INDEX "Issuer_organizationId_createdAt_id_idx" ON "Issuer"("organizationId", "createdAt", "id");
CREATE INDEX "Issuer_status_createdAt_id_idx" ON "Issuer"("status", "createdAt", "id");

CREATE INDEX "Payment_userId_occurredAt_id_idx" ON "Payment"("userId", "occurredAt", "id");

CREATE INDEX "TrustedSource_userId_createdAt_id_idx" ON "TrustedSource"("userId", "createdAt", "id");

CREATE INDEX "ApiKey_organizationId_createdAt_id_idx" ON "ApiKey"("organizationId", "createdAt", "id");

CREATE INDEX "Webhook_organizationId_createdAt_id_idx" ON "Webhook"("organizationId", "createdAt", "id");

CREATE INDEX "WebhookDelivery_webhookId_createdAt_id_idx" ON "WebhookDelivery"("webhookId", "createdAt", "id");
