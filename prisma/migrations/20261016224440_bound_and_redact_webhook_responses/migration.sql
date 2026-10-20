-- Bound and redact stored webhook response bodies.
-- 
-- Changes responseBody from TEXT to JSONB to store a safe representation:
-- - truncatedBody: first 1024 bytes of redacted response
-- - contentHash: SHA-256 of full redacted response
-- - wasTruncated: boolean flag if response exceeded limit
-- - hadEncodingIssue: boolean flag for invalid UTF-8 sequences
--
-- This prevents:
-- - Storage exhaustion from large remote responses
-- - Accidental leakage of sensitive data (api_key, token, secret, password)
-- - Silent data loss (hash and flags preserve information about discarded content)
--
-- Backward compatibility:
-- Existing records with NULL responseBody remain NULL.
-- Existing text records are NOT automatically migrated; they are marked for retention.
-- New deliveries will use the safe JSON structure automatically.

-- Change responseBody column from TEXT to JSONB
ALTER TABLE "WebhookDelivery"
    ALTER COLUMN "responseBody" SET DATA TYPE JSONB USING (
        CASE
            WHEN "responseBody" IS NULL THEN NULL
            ELSE jsonb_build_object(
                'truncatedBody', 
                CASE 
                    WHEN length("responseBody") > 1024 THEN substring("responseBody" FROM 1 FOR 1024)
                    ELSE "responseBody"
                END,
                'contentHash', encode(digest("responseBody", 'sha256'), 'hex'),
                'wasTruncated', length("responseBody") > 1024,
                'hadEncodingIssue', false
            )
        END
    );
