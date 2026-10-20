# Secret Retrieval Receipts

## Overview

Secret retrieval receipts provide immutable, cryptographically-verifiable evidence that a one-time secret was revealed to a user or client at a specific time. They are created atomically with secret revelation and never contain the secret itself.

**Scope**: API keys, webhook signing secrets, export download tokens.

**Goal**: Enable compliance, audit, and forensic investigations without storing additional copies of secrets.

## Design Principles

### 1. No Secret Material Stored

Receipts contain ZERO information that could leak or allow recovery of the secret:
- No raw secret value
- No secret prefix or suffix
- No reversible encoding (base64, hex, etc.)
- No hash of the secret that could be brute-forced
- No metadata derived from the secret

**What is stored**: Non-sensitive resource identifiers, timestamps, delivery channel, and an acknowledgement hash (explained below).

### 2. Deterministic Acknowledgement Hash

The acknowledgement hash is proof that a specific secret was revealed, without revealing the secret itself.

**Computation**:
```
hash = SHA-256(
  resourceId 
  + "|" + secretType 
  + "|" + revealedAt.toISOString() 
  + "|" + HMAC-SHA256(organizationId, "secret-retrieval-receipt-salt-v1")
)
```

**Why this design**:
- **Deterministic**: Same parameters always produce the same hash (idempotent).
- **Non-reversible**: Cannot be reversed to recover the secret.
- **Organization-scoped**: Includes org-derived salt, making hashes meaningless outside this system.
- **Time-bound**: Includes exact timestamp, detecting post-hoc manipulation attempts.
- **Type-safe**: Includes secret type, preventing cross-secret confusion.

**Example verification** (outside this system, in a customer audit):
```
Given: resourceId=key_abc123, secretType=api_key, revealedAt=2025-10-15T10:30:00Z
Expected hash: [computed above]
Actual hash from receipt: [from database]
Match => evidence that the secret was revealed at that time to that resource
```

### 3. Atomic Transactions

Receipt creation ALWAYS occurs in the same database transaction as secret creation. This guarantees:
- If the secret is created, the receipt is created.
- If creation fails, both the secret and receipt are rolled back.
- No code path can reveal a secret without creating a receipt.

**Example flow for API key creation**:
```
BEGIN TRANSACTION
  1. Quota check
  2. Create API key record (store hash only)
  3. Create SecretRetrievalReceipt
  4. Create audit log entry (references receipt)
COMMIT
```

If step 3 fails, the entire transaction rolls back and no key is created.

### 4. Single-Use, Expiry-Guarded

Receipts are created on revelation and become EXPIRED when:
- The underlying secret itself expires (for API keys, webhooks).
- The secret is consumed (for export tokens — one-time download).
- Time passes (default 1 year from creation, or custom expiry).

Receipts cannot be manually deleted; they are immutable evidence.

### 5. Replay Prevention

The unique constraint `(organizationId, resourceId, secretType, revealedAt)` prevents duplicate receipts for the same secret at the same millisecond. This is sufficient because:
- Receipts are created in the same transaction as secret creation.
- If two requests create the same secret concurrently, they will have different timestamps (unless at the exact same millisecond, which is rare and acceptable).
- The database constraint catches the rare case and one request gets a conflict error (application can retry).

## Data Model

### SecretRetrievalReceipt

| Field | Type | Nullable | Description |
|-------|------|----------|-------------|
| `id` | string (cuid) | No | Unique receipt ID |
| `organizationId` | string | No | Organization ID (foreign key) |
| `secretType` | string | No | `api_key`, `webhook`, `export` |
| `resourceId` | string | No | ID of the resource (API key ID, webhook ID, export job ID) |
| `resourceReference` | string | Yes | Human-readable identifier (prefix, URL, category) for user reference |
| `recipientId` | string | Yes | Who received the secret (user ID, API key prefix, or null for capability URLs) |
| `deliveryChannel` | string | No | `http_response`, `download_url`, `email` (default: `http_response`) |
| `revealedAt` | timestamp | No | When the secret was revealed |
| `acknowledgementHash` | string | No | SHA-256 hash (non-reversible proof of revelation) |
| `status` | string | No | `ACTIVE`, `EXPIRED`, `REVOKED` (default: `ACTIVE`) |
| `expiresAt` | timestamp | Yes | When the receipt expires (null = 1 year from now) |
| `metadata` | JSON | No | Optional context (IP, user agent, reason, etc.) |
| `hash` | string | No | SHA-256 of receipt state (audit chain) |
| `hashVersion` | int | No | Audit chain version (default: 1) |
| `prevHash` | string | Yes | Previous receipt hash (audit chain) |
| `createdAt` | timestamp | No | Record creation timestamp |
| `updatedAt` | timestamp | No | Record update timestamp |

### Indexes

- **Unique constraint**: `(organizationId, resourceId, secretType, revealedAt)` — prevents duplicates, enables fast lookup by secret.
- **Composite index**: `(organizationId, secretType, resourceId)` — org + secret type + resource queries.
- **Composite index**: `(organizationId, status, expiresAt)` — expiry cleanup queries.
- **Composite index**: `(organizationId, createdAt)` — timeline queries.

## Integration Points

### API Key Creation and Rotation

When an API key is created or rotated:

```
Receipt created with:
  secretType = "api_key"
  resourceId = apiKey.id
  resourceReference = apiKey.prefix (e.g., "Ep4ZxkY3")
  recipientId = creator user ID
  deliveryChannel = "http_response"
  revealedAt = now()
  expiresAt = apiKey.expiresAt (receipt expires when key expires)
```

**Audit log**: Includes `receiptId` in metadata.

### Webhook Signing Secret Creation and Rotation

When a webhook is created or its signing secret is rotated:

```
Receipt created with:
  secretType = "webhook"
  resourceId = webhook.id
  resourceReference = webhook.url
  recipientId = null (webhook creation not attributed to a user)
  deliveryChannel = "http_response"
  revealedAt = now()
  expiresAt = null (no inherent expiry, defaults to 1 year)
```

**Audit log**: Includes `receiptId` in metadata.

### Export Download Token Issuance and Consumption

When an export download token is issued:

```
Receipt created with:
  secretType = "export"
  resourceId = exportJob.id
  resourceReference = "export-{categories}" (e.g., "export-payments,webhooks")
  recipientId = requesting user ID
  deliveryChannel = "download_url"
  revealedAt = now()
  expiresAt = token expiry (default 10 minutes)
```

When the token is consumed (redemption):

```
Receipt updated:
  status = "EXPIRED"
  metadata.consumedAt = now()
```

**Audit log**: Includes `receiptId` in metadata for issuance.

## Audit and Compliance

### What is Logged

**Audit events**:
- `api_key.created` — includes receiptId
- `api_key.rotated` — includes receiptId
- `webhook.created` — includes receiptId
- `webhook.rotated` — includes receiptId
- `export_download.issued` — includes receiptId
- `secret_retrieval_receipt.created` — detailed receipt metadata

**Never logged**: Raw secret values, secret hashes, or reversible encodings.

### Querying Receipts

Retrieve receipts for an organization by secret type and resource:

```typescript
const receipts = await prisma.secretRetrievalReceipt.findMany({
  where: {
    organizationId: "org_123",
    secretType: "api_key",
    resourceId: "key_456",
  },
  orderBy: { revealedAt: "desc" },
});
```

### Data Retention

Receipts are retained according to the organization's data retention policy (default 2 years). They are automatically expired and can be archived/purged after the retention period.

## Error Handling

### Duplicate Receipt Attempt

If two requests reveal the same secret within the same millisecond (rare), the second request gets a unique constraint violation:

```
PrismaClientKnownRequestError: Unique constraint failed on the fields: (organizationId, resourceId, secretType, revealedAt)
```

**Application handling**: Retry the request (will get a different timestamp) or return HTTP 409 Conflict.

### Receipt Expiry

Attempting to consume an expired token returns 404 (not 410 Gone):

```
NotFoundException: "Download not available"
```

This prevents attackers from probing which tokens once existed.

### Already-Consumed Token

Attempting to redeem a token twice (replay) returns 404:

```
NotFoundException: "Download not available"
```

Internally, the token hash is nulled out on first consumption, so a second attempt finds no record.

## Security Considerations

### Threat Model

**Attacker goals and mitigations**:

1. **Recover the secret from the receipt**: Impossible — the receipt contains no secret material and no reversible hash.

2. **Forge a receipt to claim a secret was revealed**: Difficult — would need to know the org salt (derived from organizationId) and the exact timestamp (unknown to attacker). Forged receipts fail verification by legitimate clients.

3. **Replay a download token**: Prevented by unique constraint + transaction atomicity + token nulling on consumption.

4. **Extract org salt from receipts**: Infeasible — the salt is HMAC-derived from organizationId internally; it never leaves the service.

5. **Brute-force the acknowledgement hash**: Infeasible — would require brute-forcing the org salt (unknown), the resourceId (many possibilities), and the exact ISO timestamp (microsecond precision).

### Constant-Time Verification

Future client-side verification of acknowledgement hashes should use constant-time comparison to prevent timing attacks:

```typescript
import { timingSafeEqual } from "crypto";

const expectedHash = computeAcknowledgementHash(...);
const isValid = timingSafeEqual(
  Buffer.from(expectedHash, "hex"),
  Buffer.from(receipt.acknowledgementHash, "hex")
);
```

## Backward Compatibility

### Pre-Existing Secrets

This feature only creates receipts for NEW secrets revealed after deployment. Receipts are NOT backfilled for secrets revealed before this feature existed.

**Reasoning**: Cannot determine precise reveal timestamps for historical secrets; audit logs exist for historical actions.

### API Responses

Secret revelation endpoints (POST /api-keys, POST /webhooks/:id/rotate-secret, POST /orgs/:orgId/exports/:id/download-token) return the same response structure. Receipts are internal; clients do not receive receipt IDs in the response.

**Future enhancement**: Add optional `receipt` field to responses if clients need proof-of-delivery.

## Operational Notes

### Monitoring

- **Receipt creation failures**: Alert if receipt creation fails (transaction rolled back). This blocks secret revelation.
- **Expiry cleanup**: Monitor that expired receipts are retained per policy. If cleanup jobs are needed, alert on cleanup lag.
- **Unique constraint violations**: Alert if duplicate receipts are attempted (rare concurrency edge case).

### Database Maintenance

- **Vacuum**: Run VACUUM on the table periodically to clean up deleted (expired) rows.
- **Backup**: Include SecretRetrievalReceipt in database backups for audit trail preservation.
- **Archive**: After retention period, archive receipts to cold storage for long-term compliance.

### Testing

- **Unit tests**: Verify acknowledgement hash determinism, expiry logic, and edge cases.
- **Integration tests**: Verify atomic transactions, unique constraint, and audit logging.
- **Concurrency tests**: Verify parallel receipt creation and replay prevention.
- **Boundary tests**: Verify exact expiry timestamp handling with controlled clocks (jest.useFakeTimers).
