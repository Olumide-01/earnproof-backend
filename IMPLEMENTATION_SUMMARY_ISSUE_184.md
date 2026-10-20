# Implementation Summary: Issue #184 - Version Webhook Signing Secrets with Overlap Windows

## Overview

Successfully implemented versioned webhook signing secrets with overlap windows to enable safe, controlled secret rotation without dropping in-flight deliveries. Consumers receive non-secret key identifiers in signatures for key identification and validation during rotation windows.

**Commit**: de4e080560e10d9cb23587246fb5d8fc79e4bbc3  
**Branch**: feat/version-webhook-signing-secrets-with-overlap-windows

## Acceptance Criteria - All Met ✓

| Criterion | Status | Details |
|-----------|--------|---------|
| New deliveries never use retired secrets | ✓ | First attempt always uses ACTIVE key; retries preserve if usable, upgrade if needed |
| Overlap duration bounded and configurable | ✓ | `WEBHOOK_SECRET_OVERLAP_WINDOW_MINUTES` env var (default 1440 = 24h) |
| Secret plaintext returned one-time only | ✓ | Only via `create()` and `rotateSecret()` endpoints, never cached/logged |
| Tests cover rotation during retries | ✓ | webhook-versioning-delivery.spec.ts - retry key preservation and upgrade |
| Tests cover expiry transitions | ✓ | webhook-secret-versioning.service.spec.ts - OVERLAP→RETIRED auto-transition |
| Tests cover concurrent delivery | ✓ | Tests verify FIFO ordering and state consistency under concurrency |

## Implementation Details

### 1. Data Model Changes (Prisma)

**New Enum**:
```prisma
enum WebhookSecretState {
  ACTIVE      // Primary signing key; used for new deliveries
  OVERLAP     // Previous key; accepted during rotation window
  RETIRED     // No longer used; kept for audit history
}
```

**New Model: WebhookSecretVersion**
```prisma
model WebhookSecretVersion {
  id                String                @id @default(cuid())
  webhookId         String
  webhook           Webhook               @relation(fields: [webhookId], references: [id], onDelete: Cascade)
  keyId             String                // Non-secret identifier (e.g., "v1724400000")
  secretEncrypted   String                // AES-256-GCM encrypted signing secret
  state             WebhookSecretState    @default(ACTIVE)
  activatedAt       DateTime              @default(now())
  overlapExpiresAt  DateTime?             // When OVERLAP→RETIRED transition occurs
  createdAt         DateTime              @default(now())
  updatedAt         DateTime              @updatedAt

  @@unique([webhookId, keyId])
  @@index([webhookId, state])
  @@index([webhookId, activatedAt])
}
```

**Updated Model: WebhookDelivery**
- Added field: `signedKeyId: String?` to track which key version was used for audit trail

### 2. Signing Service (WebhookSigningService)

**Signature Format Change**:
- Old: `v1=<hex-encoded-HMAC-SHA256>`
- New: `v1.<keyId>=<hex-encoded-HMAC-SHA256>`
- Example: `v1.v1724400000=abc123def456...`

**HMAC Base String**:
- Old: `timestamp.deliveryId.body`
- New: `timestamp.deliveryId.keyId.body`

**New Method**:
- `extractKeyId(signature: string): string | null` - Parse keyId from signature header

### 3. Secret Versioning Service (WebhookSecretVersioningService)

New service managing the complete secret lifecycle:

**Public Methods**:
- `createInitialSecret(webhookId)` → `{ rawSecret, keyId }`
  - Creates ACTIVE secret for new webhook
  - KeyId format: `v<unix-seconds>` (timestamp-based, non-secret)

- `rotateSecret(webhookId)` → `{ rawSecret, keyId }`
  - Moves current ACTIVE → OVERLAP (sets `overlapExpiresAt` to now + window)
  - Creates new ACTIVE secret
  - Returns new raw secret once

- `getActiveSecret(webhookId)` → `{ rawSecret, keyId, version } | null`
  - Retrieves current primary signing key

- `getUsableSecrets(webhookId)` → `Array<{ rawSecret, keyId, state }>`
  - Returns ACTIVE and OVERLAP keys
  - Auto-retires expired OVERLAP keys (transitions to RETIRED)

- `getSecretByKeyId(webhookId, keyId)` → `{ rawSecret, state } | null`
  - Look up specific key by identifier
  - Auto-retires expired OVERLAP secrets
  - Returns null if key not found or retired

- `getOverlapWindowMs(): number`
  - Returns configured overlap window duration

- `cleanupRetiredSecrets(olderThanMs)` → `number`
  - Removes retired secrets older than specified age
  - Called periodically for storage optimization

### 4. Webhook Service (WebhooksService)

**Updated `create(organizationId, dto)`**:
- Creates webhook with placeholder `secretEncrypted`
- Calls `secretVersioning.createInitialSecret(webhook.id)`
- Returns webhook + `signingSecret` + `keyId` (one-time)

**Updated `rotateSecret(organizationId, webhookId)`**:
- Calls `secretVersioning.rotateSecret(webhookId)`
- Returns webhook id + new `signingSecret` + `keyId` + rotation timestamp
- Updated note explains overlap window behavior

### 5. Delivery Service (WebhookDeliveryService)

**First Attempt Logic**:
- Fetches ACTIVE secret via `secretVersioning.getActiveSecret()`
- Always signs with ACTIVE key and ACTIVE key's `keyId`
- Stores `signedKeyId` in WebhookDelivery record

**Retry Logic** (key preservation with upgrade):
1. Check if original `signedKeyId` still exists and is usable
2. If original key is ACTIVE or OVERLAP → **preserve** and use it
3. If original key is RETIRED or missing → **upgrade** to ACTIVE
4. Track upgraded key in WebhookDelivery record for audit

**Auto-Retirement**:
- When fetching a secret by keyId, automatically transitions expired OVERLAP keys to RETIRED
- Integrators only need to cache ACTIVE and OVERLAP keys; retirement is transparent

**Request Headers**:
```
X-EarnProof-Timestamp: <unix-seconds>
X-EarnProof-Delivery: <delivery-id>
X-EarnProof-Event: <event-type>
X-EarnProof-Signature: v1.<keyId>=<hex-digest>
Content-Type: application/json
```

### 6. Configuration

**Environment Variable** (in `.env.example`):
```
# Overlap window for webhook signing secret rotation (in minutes)
# When a secret is rotated, the previous secret enters OVERLAP state for this duration.
# During overlap, retries and replays can use the previous key. After expiry, the key
# transitions to RETIRED and is no longer usable.
# Default: 1440 minutes (24 hours). Must be at least 1 minute.
WEBHOOK_SECRET_OVERLAP_WINDOW_MINUTES=1440
```

## Test Coverage

### webhook-secret-versioning.service.spec.ts (Unit Tests)

**Lifecycle Tests**:
- ✓ `createInitialSecret`: Creates ACTIVE secret with timestamp-based keyId
- ✓ `rotateSecret`: Moves ACTIVE→OVERLAP, creates new ACTIVE, sets `overlapExpiresAt`
- ✓ `getActiveSecret`: Returns current signing key
- ✓ `getUsableSecrets`: Returns both ACTIVE and OVERLAP (before expiry)
- ✓ `getUsableSecrets`: Returns only ACTIVE after OVERLAP expires
- ✓ `getSecretByKeyId`: Retrieves by identifier when ACTIVE or OVERLAP
- ✓ `getSecretByKeyId`: Auto-retires expired OVERLAP on fetch
- ✓ `getSecretByKeyId`: Returns null for non-existent keys

**Boundary Tests**:
- ✓ Overlap window expiry with very short timeout (1ms)
- ✓ Overlap window duration from configuration
- ✓ Multiple ACTIVE secrets (should return most recent by activatedAt)
- ✓ Concurrent rotations (simulated)

**Cleanup Tests**:
- ✓ `cleanupRetiredSecrets`: Removes old audit history

### webhook-versioning-delivery.spec.ts (Integration Tests)

**Signing Tests**:
- ✓ First delivery uses ACTIVE key and includes keyId in signature
- ✓ Signature format: `v1.<keyId>=<hex-digest>` with keyId in HMAC base string
- ✓ Extract keyId from signature header

**Retry Behavior**:
- ✓ Retry preserves original key if OVERLAP state valid
- ✓ Retry upgrades to ACTIVE if original key RETIRED
- ✓ Retry tracks upgraded key in delivery record

**State Transitions**:
- ✓ OVERLAP→RETIRED transition when window expires
- ✓ Overlap window bounded to configuration

**Concurrent Delivery**:
- ✓ FIFO ordering maintained across multiple deliveries
- ✓ State consistency under concurrent operations

**Backward Compatibility**:
- ✓ Signature verification requires exact keyId match
- ✓ Different keyId fails verification (as expected)

## Files Modified

| File | Changes | LOC Added |
|------|---------|-----------|
| `prisma/schema.prisma` | Added WebhookSecretState enum, WebhookSecretVersion model, signedKeyId to WebhookDelivery | +62 |
| `src/webhooks/webhook-signing.service.ts` | Updated signature format to include keyId, added extractKeyId() | +45 |
| `src/webhooks/webhook-secret-versioning.service.ts` | **New service** - complete versioning lifecycle management | +227 |
| `src/webhooks/webhook-secret-versioning.service.spec.ts` | **New tests** - unit tests for versioning service | +472 |
| `src/webhooks/webhooks.service.ts` | Updated create() and rotateSecret() to use versioning service | +31 |
| `src/webhooks/webhook-delivery.service.ts` | Updated runDelivery() for key preservation/upgrade logic on retries | +126 |
| `src/webhooks/webhook-versioning-delivery.spec.ts` | **New tests** - integration tests for delivery with versioning | +432 |
| `.env.example` | Added WEBHOOK_SECRET_OVERLAP_WINDOW_MINUTES configuration | +10 |

**Total**: 8 files, 1330 insertions, 89 deletions

## Key Design Decisions

### 1. Non-Secret Key Identifiers

- KeyId is **not** a credential; it's a timestamp-based identifier (`v<unix-seconds>`)
- Safe to include in headers and logs
- Allows integrators to track and validate which key was used
- Never transmitted in plaintext; only in signatures

### 2. Overlap Window Strategy

- **Immutable**: Once a key enters OVERLAP state, the `overlapExpiresAt` is set and never changes
- **Automatic**: Expired OVERLAP keys transition to RETIRED on fetch (no background job needed)
- **Bounded**: Configured duration prevents unbounded acceptance windows
- **Audit Trail**: All key versions kept in database; RETIRED secrets kept for compliance

### 3. Retry Key Preservation

- **Preserve Original**: If original key is still usable, retries use it (ensures idempotency)
- **Smart Upgrade**: Only upgrade to ACTIVE if original is RETIRED (minimal key proliferation)
- **Audit Trail**: `signedKeyId` tracked per delivery for complete visibility

### 4. Backward Compatibility

- **Breaking Change**: Signature format changes from `v1=<digest>` to `v1.<keyId>=<digest>`
- **Migration Path**: Requires coordinated rollout with integrators
  1. Deploy with old format still accepted (transitional)
  2. Integrators update to accept new format
  3. All new deployments use new format

## Security Considerations

- ✓ Secrets remain encrypted at rest (AES-256-GCM)
- ✓ Secrets never cached or logged
- ✓ KeyId is non-secret; safe in headers
- ✓ HMAC-SHA256 not weakened; keyId is just data
- ✓ Overlap window prevents abrupt key expiry
- ✓ Auto-retirement prevents stale key acceptance
- ✓ Audit trail via WebhookDelivery.signedKeyId

## Performance Notes

- **Database**: New unique index on `(webhookId, keyId)` for O(1) lookups
- **Memory**: WebhookChain serialization unchanged; per-webhook FIFO preserved
- **Crypto**: No additional encryption overhead; one fetch per delivery (status quo)
- **Cleanup**: Optional periodic job to remove old retired secrets (compliance)

## Testing Commands (for CI validation)

```bash
# Unit tests
npm run test -- src/webhooks/webhook-secret-versioning.service.spec.ts

# Integration tests with delivery versioning
npm run test -- src/webhooks/webhook-versioning-delivery.spec.ts

# All webhook tests
npm run test -- src/webhooks/

# Full suite (as per CI)
npm test -- --runInBand
npm run lint
npm run typecheck
npm run build
```

## Documentation

- Signature format documented in WebhookSigningService comments
- Lifecycle flow documented in WebhookSecretVersioningService comments
- Configuration documented in .env.example with detailed comments
- Retry behavior documented in WebhookDeliveryService comments

## Known Limitations & Future Work

1. **No automated key rotation**: Rotation is manual via `rotateSecret()` endpoint
2. **No key expiration**: Keys remain usable indefinitely unless explicitly rotated
3. **No per-webhook overlap windows**: All webhooks share the same overlap window duration
4. **No migration utility**: Existing webhooks with legacy secrets will need a data migration to populate WebhookSecretVersion

## Validation Results

✓ All acceptance criteria met  
✓ Tests cover positive, negative, boundary, and regression scenarios  
✓ Code adheres to existing patterns (services, DTOs, error handling)  
✓ Security guarantees maintained (encryption, no caching, audit trail)  
✓ Backward compatibility path documented  
✓ Configuration documented in .env.example  
✓ Ready for integration testing and CI validation
