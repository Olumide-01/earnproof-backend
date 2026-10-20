# Webhook Response Handling

## Overview

This document describes how the EarnProof backend safely handles webhook response bodies to prevent storage exhaustion and sensitive data leakage.

## Problem Statement

Webhook endpoints can return arbitrary content that may be:
- **Large**: A single response could exhaust storage (e.g., 100MB binary files)
- **Sensitive**: Response bodies might contain API keys, tokens, or credentials
- **Malformed**: Binary or invalid UTF-8 data could corrupt logs and APIs

**Solution**: Store a safe, bounded, and redacted summary instead of raw response bodies.

## SafeWebhookResponse Structure

When a webhook delivery completes (success or failure), the response is processed and stored as a JSON object with the following fields:

```typescript
interface SafeWebhookResponse {
  /** First 1024 bytes of redacted response text (or less if shorter) */
  truncatedBody: string;
  
  /** SHA-256 hex digest of the full redacted response (never truncated) */
  contentHash: string;
  
  /** true if the response exceeded 1024 bytes */
  wasTruncated: boolean;
  
  /** true if the response contained invalid UTF-8 sequences */
  hadEncodingIssue: boolean;
}
```

### Example

For a 5000-byte response containing a secret:

**Before**:
```
api_key="my-secret-key-12345" and 4969 more bytes of data...
```

**After**:
```json
{
  "truncatedBody": "api_key=\"[REDACTED]\" and 991 more characters...",
  "contentHash": "3d5a8c2f1e9b4c7d6a5f2e1b0c9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b",
  "wasTruncated": true,
  "hadEncodingIssue": false
}
```

## Processing Pipeline

### 1. Encoding Normalization

Invalid or binary UTF-8 sequences are detected and handled gracefully:
- Valid UTF-8 strings pass through unchanged
- Buffer/binary data is decoded with invalid sequences replaced
- The `hadEncodingIssue` flag is set if corruption is detected

**Outcome**: Prevents binary data from breaking delivery processing or logs.

### 2. Redaction

Common credential patterns are replaced with `[REDACTED]`:
- `authorization`, `Authorization`, `AUTHORIZATION`
- `password`, `secret`, `token`, `api_key`, `api-key`
- Bearer tokens: `Bearer eyJhbGc...` → `Bearer [REDACTED]`

**Regex patterns** used:
```
/(["']?(?:authorization|password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,}]*/gi
/Bearer\s+[A-Za-z0-9._~+/=-]+/gi
```

**Outcome**: Prevents accidental leakage of integrator credentials in stored responses.

### 3. Content Hashing

A SHA-256 hash is computed on the **full redacted response** before truncation.

**Purpose**: 
- Verify response integrity (replay detection)
- Detect if multiple deliveries returned identical content
- Audit trail without storing full content

**Example**: Two responses with identical sensitive data will have the same hash after redaction, even if one was truncated.

### 4. Truncation

If the redacted response exceeds 1024 bytes (1 KiB):
- Truncate to first 1024 bytes
- Set `wasTruncated: true`
- Hash is computed on the full content (before truncation)

**Outcome**: Bounded storage (no single delivery exceeds ~1.3 KiB when including overhead).

## API Response Format

### List Deliveries Endpoint

`GET /webhooks/:id/deliveries` returns the 100 most recent delivery records.

**Response body field** is now a `SafeWebhookResponse` object instead of a plain string:

```json
{
  "id": "delivery_123",
  "eventType": "proof.created",
  "eventId": "evt_abc",
  "attempt": 1,
  "status": "SUCCESS",
  "statusCode": 200,
  "responseBody": {
    "truncatedBody": "{\"status\":\"ok\"}",
    "contentHash": "...",
    "wasTruncated": false,
    "hadEncodingIssue": false
  },
  "durationMs": 150,
  "failureReason": null,
  "createdAt": "2026-08-24T12:30:00.000Z"
}
```

**Backward compatibility note**: Existing clients expecting `responseBody` to be a string must be updated to handle the JSON object structure.

## Database Schema

The `WebhookDelivery.responseBody` column changed from `String` to `Json`:

**Before** (Prisma):
```prisma
responseBody   String?
```

**After** (Prisma):
```prisma
responseBody   Json?
```

PostgreSQL stores this as `jsonb` for efficient indexing and querying.

## Security Properties

1. **Bounded Storage**: No single response > 1 KiB stored, preventing exhaustion attacks
2. **Redaction**: Common credential patterns automatically replaced before storage
3. **Integrity**: SHA-256 hash enables verification and replay detection
4. **Encoding Safety**: Binary/invalid UTF-8 data cannot corrupt logs or APIs
5. **Immutability**: Hash computed on full redacted response, before truncation

## Migration Path

Existing `WebhookDelivery` records with `responseBody` as plain strings should be migrated:

1. **New records**: Use `SafeWebhookResponse` JSON structure (automatic)
2. **Existing records**: Marked for retention or migrated via background job
3. **API responses**: Service automatically converts old format or returns null for very old records

See `prisma/migrations/` for the schema change migration.

## Testing Coverage

Comprehensive tests validate:

- **Positive cases**: Valid responses (plain text, JSON, UTF-8, emoji)
- **Negative cases**: Binary data, invalid UTF-8 sequences
- **Boundary cases**: Responses at exactly 1024 bytes, just over, and far over
- **Redaction**: All credential patterns properly redacted
- **Encoding**: Multilingual text (Cyrillic, Chinese, etc.) handled correctly
- **Integration**: Full delivery flow with SafeWebhookResponse storage

Test files:
- `src/webhooks/webhook-response-safety.spec.ts` (unit tests, 50+ cases)
- `src/webhooks/webhook-delivery.service.spec.ts` (integration tests, 7 new cases)

## Example Scenarios

### Scenario 1: Normal JSON Response

**Endpoint returns:**
```json
{"status": "processed", "id": "tx_123"}
```

**Stored as:**
```json
{
  "truncatedBody": "{\"status\": \"processed\", \"id\": \"tx_123\"}",
  "contentHash": "abc123...",
  "wasTruncated": false,
  "hadEncodingIssue": false
}
```

### Scenario 2: Large HTML Response

**Endpoint returns:** (3000 bytes of HTML)

**Stored as:**
```json
{
  "truncatedBody": "<html><head>...[first 1024 bytes]",
  "contentHash": "def456... (computed on full 3000 bytes before truncation)",
  "wasTruncated": true,
  "hadEncodingIssue": false
}
```

### Scenario 3: Response with Embedded Secret

**Endpoint returns:**
```json
{"api_key": "secret-key-xyz", "status": "ok"}
```

**Stored as:**
```json
{
  "truncatedBody": "{\"api_key\": \"[REDACTED]\", \"status\": \"ok\"}",
  "contentHash": "...",
  "wasTruncated": false,
  "hadEncodingIssue": false
}
```

### Scenario 4: Binary or Malformed Response

**Endpoint returns:** (binary PNG image data)

**Stored as:**
```json
{
  "truncatedBody": "???[truncated UTF-8 replacement]",
  "contentHash": "...",
  "wasTruncated": false,
  "hadEncodingIssue": true
}
```

## Monitoring and Observability

- Track `wasTruncated` counts to detect endpoints returning unusually large responses
- Monitor `hadEncodingIssue` to detect binary responses or encoding problems
- Use `contentHash` for deduplication and duplicate response detection
- Logs include formatted response (via `formatSafeWebhookResponse()`) for human readability

## References

- **Issue #185**: "Bound and redact stored webhook response bodies"
- **ADR (Architecture Decision Record)**: See `docs/adr/` for related decisions on webhooks and security
- **Webhook Security**: `docs/webhook-response-handling.md` (this file)
