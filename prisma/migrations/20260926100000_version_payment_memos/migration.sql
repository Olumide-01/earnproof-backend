-- Normalize and minimize Payment.memo (earnproof-backend#176).
--
-- migration-safety: destructive-approved (legacy memo content is purged)
-- migration-safety: compatibility=every non-null memo that is not already
--   version 2 becomes {"version": 2, "type": "none", "omitted": "legacy"}
--   (or {"version": 2, "type": "none"} when it recorded no memo). The API
--   already reports such rows as memo type "none", and the next payment sync
--   re-derives the memo from Horizon in the encrypted version-2 form.
-- migration-safety: rollback=drop the CHECK constraint. Purged legacy
--   content is not restorable from the database by design; memos are public
--   on-chain and are re-fetched by sync.

UPDATE "Payment"
SET "memo" = CASE
  WHEN jsonb_typeof("memo") = 'object' AND "memo"->>'type' = 'none'
    THEN '{"version": 2, "type": "none"}'::jsonb
  ELSE '{"version": 2, "type": "none", "omitted": "legacy"}'::jsonb
END
WHERE "memo" IS NOT NULL
  AND NOT (jsonb_typeof("memo") = 'object' AND "memo"->>'version' = '2');

-- Backstop for the application-side 512-byte limit. jsonb's text form adds
-- whitespace, hence the looser bound.
ALTER TABLE "Payment"
ADD CONSTRAINT "Payment_memo_version_2_bounded" CHECK (
  "memo" IS NULL
  OR (
    jsonb_typeof("memo") = 'object'
    AND "memo"->>'version' = '2'
    AND octet_length("memo"::text) <= 1024
  )
);
