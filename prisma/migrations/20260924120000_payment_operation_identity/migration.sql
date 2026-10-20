-- Canonical identity for indexed Stellar payments (#206).
--
-- A transaction hash alone cannot identify a payment: one Stellar transaction
-- can carry several payment operations. The safe identity is the triple
-- (network, transaction hash, operation index). These columns are added
-- nullable so existing rows can be backfilled deterministically before the
-- identity is enforced, then a composite unique index guards distinctness.

-- 1. Add the new identity columns, nullable for backfill.
ALTER TABLE "Payment" ADD COLUMN "network" TEXT;
ALTER TABLE "Payment" ADD COLUMN "operationIndex" INTEGER;

-- 2. Backfill the operation index from the Horizon operation id (a TOID). The
--    operation index is the low 12 bits, i.e. the value modulo 4096. `numeric`
--    is used rather than `bigint` because a TOID is an unsigned 64-bit integer
--    and can exceed the signed bigint range. Only rows whose operationId is a
--    well-formed TOID are touched; anything else is left NULL and reported below
--    as ambiguous rather than guessed at.
UPDATE "Payment"
SET "operationIndex" = mod("operationId"::numeric, 4096)::integer
WHERE "operationId" ~ '^[0-9]{1,20}$';

-- 3. Report legacy rows whose identity cannot be derived, so an operator can
--    resolve them (see scripts/backfill-payment-identity.ts) instead of the
--    migration inventing an index. `network` is intentionally left NULL for all
--    existing rows: it is not recoverable from stored data and is set by the
--    backfill script for the deployment's network. Composite uniqueness is not
--    enforced while `network` is NULL (NULLs are distinct in Postgres), so no
--    legacy row conflicts here.
DO $$
DECLARE
  ambiguous_count INTEGER;
BEGIN
  SELECT count(*) INTO ambiguous_count
  FROM "Payment"
  WHERE "operationIndex" IS NULL;

  IF ambiguous_count > 0 THEN
    RAISE NOTICE 'payment_operation_identity: % payment row(s) have no derivable operation index and were left NULL; run scripts/backfill-payment-identity.ts to resolve them before enforcing NOT NULL.', ambiguous_count;
  END IF;
END $$;

-- 4. Enforce the canonical identity. Distinctness applies once a row has a
--    non-NULL network and operation index.
CREATE UNIQUE INDEX "Payment_network_stellarTransactionHash_operationIndex_key"
  ON "Payment"("network", "stellarTransactionHash", "operationIndex");
