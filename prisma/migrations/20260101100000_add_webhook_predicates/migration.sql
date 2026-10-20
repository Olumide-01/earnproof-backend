-- Add bounded webhook subscription predicate support.
--
-- Predicates allow subscriptions to select events using typed operators
-- (eq, in, and, or, not) over three public fields: resource, outcome, and schemaVersion.
-- No arbitrary expressions, no private field access, no unbounded evaluation.
--
-- Schema changes:
-- 1. Add optional `predicate` column to Webhook: stores the PredicateV1 JSON structure
-- 2. Add optional `predicateSnapshot` column to WebhookDelivery: stores predicate snapshot
--    at delivery creation time, ensuring replay consistency if the subscription is updated
--    or deleted before delivery completes.
--
-- Migration is backward compatible: existing subscriptions have predicate = NULL and
-- continue to match exactly as before (event type only).

-- Add predicate column to Webhook model
ALTER TABLE "Webhook" ADD COLUMN "predicate" JSONB;

-- Add predicate snapshot column to WebhookDelivery model
-- This stores the predicate that was active when the delivery was created,
-- ensuring deterministic replay semantics if the subscription is modified during delivery.
ALTER TABLE "WebhookDelivery" ADD COLUMN "predicateSnapshot" JSONB;

-- Create indices for efficient querying (if precomputation is added later)
-- For now, evaluator scans all subscriptions per event as before.
-- Future optimization: add selectorHash index for fast pre-filtering.

-- Update timestamps on affected tables
UPDATE "Webhook" SET "updatedAt" = NOW() WHERE "predicate" IS NULL;
