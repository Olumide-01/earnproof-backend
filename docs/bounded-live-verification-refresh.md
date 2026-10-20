# Bounded Live Verification Refresh

## Overview

The bounded live verification refresh endpoints provide high-assurance verifiers with an explicit fresh-read path that bypasses caches under controlled budgets. This feature enables proof owners and authorized verifiers to request fresh on-chain status checks with deterministic timeout behavior, concurrency limits, and result provenance tracking.

## Problem Statement

Standard verification endpoints may return cached or stale results, which is appropriate for most use cases but insufficient for high-assurance scenarios where verifiers need guaranteed freshness. However, unconstrained live checks can cause:

- **Thundering herd**: Multiple concurrent requests hammer the contract without bound
- **Resource exhaustion**: Slow network calls block server threads
- **Unbounded latency**: Verification may take indefinite time
- **Replay ambiguity**: Clients can't distinguish fresh results from cached ones

The bounded refresh endpoints solve this by:

1. **Source selection**: Choose between cache, live, or prefer-live with fallback
2. **Deterministic timeouts**: Strict latency bounds prevent hanging requests
3. **Concurrency limits**: Global queue prevents thundering herd
4. **Result provenance**: Response indicates whether result was live or cached
5. **Fail-closed on contract**: On-chain invalidity overrides local state
6. **Fail-open on errors**: Graceful fallback when live checks fail

## Endpoints

### Authenticated Refresh (Proof Owner)

**Request:**
```
POST /proofs/:id/verify/refresh
Authorization: Bearer <token>
Content-Type: application/json

{
  "source": "prefer_live",
  "maxLatencyMs": 5000
}
```

**Response (200 OK):**
```json
{
  "result": "VALID",
  "status": "valid",
  "credential": {
    "signature": "...",
    "credentialSubject": { ... }
  },
  "proof": {
    "id": "proof-123",
    "type": "minimum-income",
    "schemaVersion": "earnproof.minimum-income.v1",
    "network": "testnet",
    "issuedAt": "2025-01-15T12:00:00Z",
    "expiresAt": "2025-02-15T12:00:00Z",
    "revokedAt": null,
    "revocationReasonCode": null,
    "contractStatus": { ... }
  },
  "freshness": {
    "provenance": "live",
    "checkedAt": "2025-01-15T12:34:56.789Z",
    "latencyMs": 234
  }
}
```

**Authorization:** Proof owner only (verified via bearer token and proof ownership check)

**Rate Limiting:** Subject to verification tier (30 req/min)

---

### Shared/Public Refresh (Sharing Token)

**Request (with direct proof ID):**
```
POST /proofs/:id/verify/refresh
Content-Type: application/json

{
  "source": "cache",
  "maxLatencyMs": 5000
}
```

**Request (with sharing token):**
```
POST /proofs/share_abc123xyz/verify/refresh
Content-Type: application/json

{
  "source": "prefer_live",
  "maxLatencyMs": 5000
}
```

**Response:** Same as authenticated endpoint

**Authorization:** Public access; sharing token validates access

**Rate Limiting:** Subject to verification tier (30 req/min)

---

## Source Selection

The `source` parameter determines where the verification result is sourced:

### `CACHE` - Local Only

- Uses cached/local state only
- No on-chain contract check is performed
- Fastest response time
- May return stale results
- Provenance: `cache`

**Use case:** Bulk verification where freshness is secondary

```json
{
  "source": "cache"
}
```

---

### `LIVE` - On-Chain Required

- Requires live on-chain status check within `maxLatencyMs`
- Fails if contract check exceeds latency bound
- Fails if contract is unavailable (fail-closed)
- Provenance: `live` or error

**Use case:** High-assurance verification requiring current on-chain state

```json
{
  "source": "live",
  "maxLatencyMs": 5000
}
```

---

### `PREFER_LIVE` - Live with Fallback (Default Recommended)

- Attempts live on-chain check within `maxLatencyMs`
- Falls back to cache if live check fails or exceeds bound
- Falls back to local state only if both fail
- Provenance: `live`, `cache_fallback`, or `local_only`
- Always succeeds (unless all paths fail)

**Use case:** Most applications; balances freshness and reliability

```json
{
  "source": "prefer_live",
  "maxLatencyMs": 5000
}
```

---

## Request Parameters

| Field | Type | Required | Bounds | Default | Description |
|-------|------|----------|--------|---------|-------------|
| `source` | enum | ✓ | `CACHE`, `LIVE`, `PREFER_LIVE` | N/A | Where to source the result |
| `maxLatencyMs` | number | ✗ | [100, 30000] | 5000 | Max milliseconds for live contract check |

### Parameter Validation

- `source` is required and must be one of the three enum values
- `maxLatencyMs` is optional; if omitted, 5000ms default is used
- `maxLatencyMs` is clamped to [100, 30000] range
  - Below 100ms: normalized to 100ms
  - Above 30000ms: normalized to 30000ms

---

## Response Metadata

The `freshness` object indicates the source and freshness of the result:

```json
{
  "freshness": {
    "provenance": "live",
    "checkedAt": "2025-01-15T12:34:56.789Z",
    "latencyMs": 234,
    "reason": "live_verification"
  }
}
```

| Field | Type | Always Present | Description |
|-------|------|---|-------------|
| `provenance` | enum | ✓ | `live`, `cache`, `cache_fallback`, `local_only` |
| `checkedAt` | ISO-8601 | When `provenance=live` | Timestamp of live contract check |
| `latencyMs` | number | ✓ | Actual milliseconds taken for refresh |
| `reason` | string | Sometimes | Human-readable reason (e.g., why fallback occurred) |

### Provenance Values

- **`live`**: Result sourced from live on-chain check within latency bound
- **`cache`**: Result sourced from local cache (source was CACHE)
- **`cache_fallback`**: Requested live but fell back to cache (latency exceeded or contract failed)
- **`local_only`**: Both live and cache failed; using local state only

---

## Deterministic Timeout Behavior

### CACHE Source

- No timeout applied; returns immediately
- Latency determined by database query speed
- Never fails due to timeout

### LIVE Source

- Enforces strict `maxLatencyMs` timeout using `Promise.race()`
- If contract call exceeds bound, request fails with `408 Request Timeout`
- Timeout is deterministic: same input → same timeout behavior

**Example:**
```
Request: source=LIVE, maxLatencyMs=500
Contract check starts at 12:34:56.000
Contract response arrives at 12:34:56.800 (800ms)
Result: Rejected with "Live verification latency bound exceeded: 800ms > 500ms"
HTTP Status: 408 Request Timeout
```

### PREFER_LIVE Source

- Attempts live check with timeout
- If timeout occurs, immediately falls back to cache
- If cache also fails, returns local-only state
- Never rejects due to timeout (always succeeds)

**Example:**
```
Request: source=PREFER_LIVE, maxLatencyMs=500
Live check starts at 12:34:56.000
No response by 12:34:56.500 → timeout
Falls back to cache
Cache succeeds
Result: Returns cached result with provenance=cache_fallback
```

---

## Concurrency Management

The service enforces a **global concurrency limit** on in-flight live refreshes:

- **Default limit**: 10 concurrent live refreshes
- **Queue**: Additional requests wait for available slot
- **Deduplication**: Multiple refreshes for same proof are deduplicated

### Behavior

```
Request 1 (proof A): Acquires slot 1/10
Request 2 (proof B): Acquires slot 2/10
Request 3 (proof A): Joins Request 1 (same proof, deduplication)
Request 4 (proof C): Acquires slot 3/10
...
Request 11 (proof D): Queued (waiting for slot)
Request 1 completes: Slot released
Request 11 acquires slot 1/10 and proceeds
```

### Metrics

Service provides concurrency metrics:

```typescript
service.getMetrics() => {
  activeRefreshCount: 3,
  maxConcurrency: 10,
  pendingRefreshCount: 2,
  inFlightCount: 4
}
```

---

## Fail-Closed and Fail-Open Semantics

### Fail-Closed: Contract Status

When a live check is performed and on-chain status is retrieved:

- On-chain revocation overrides local VALID state → result becomes REVOKED
- On-chain invalidity overrides local VALID state → result becomes INVALID_SIGNATURE
- Local state is never trusted when contract check succeeds

**Rationale:** A live check proves what the on-chain state is; this is authoritative.

### Fail-Open: Errors and Unavailability

When errors occur:

- Contract unavailable → fall back to cached/local state
- Network timeout → fall back to cached/local state
- Rate limit on contract → fall back to cached/local state
- Latency bound exceeded (PREFER_LIVE) → fall back to cache

**Rationale:** Verification availability is critical; stale truth is better than availability failure.

### Never Report Stale as Fresh

The service guarantees:

```
IF provenance != "live" THEN result != freshly-checked-on-chain
IF provenance == "live" THEN result was confirmed-on-chain within maxLatencyMs
```

Provenance metadata prevents clients from misinterpreting stale results as current.

---

## Error Handling

### Authentication Required (Authenticated Endpoint)

```
Status: 401 Unauthorized
```

- Missing bearer token
- Invalid/expired token
- Session not found

---

### Forbidden (Ownership Check)

```
Status: 403 Forbidden
Body: { "error": "Proof not found" or "Proof belongs to another user" }
```

- Proof not found
- Proof owned by different user
- Invalid/expired sharing token

---

### Bad Request (Validation)

```
Status: 400 Bad Request
Body: { "error": "source must be one of: CACHE, LIVE, PREFER_LIVE" }
```

- `source` missing or invalid
- `maxLatencyMs` out of bounds ([100, 30000])
- Request body malformed

---

### Timeout (LIVE Source Only)

```
Status: 408 Request Timeout
Body: { "error": "Live verification latency bound exceeded: 523ms > 500ms" }
```

- Only returned for `source=LIVE`
- PREFER_LIVE never times out (falls back to cache)
- Indicates contract call exceeded `maxLatencyMs`

---

### Rate Limited

```
Status: 429 Too Many Requests
Body: { "error": "Verification temporarily unavailable" }
```

- Verification tier rate limit exceeded (30 req/min)
- Global abuse limits exceeded (see rate-limit documentation)
- Concurrency queue full (queued; client should retry)

---

## Rate Limiting

Refresh endpoints are subject to the same rate limits as standard verification:

- **Tier**: Verification (shared with `/proofs/:id/verify` and `/proofs/verify/batch`)
- **Limit**: 30 requests per minute per client IP (or per authenticated user)
- **Cost**: Each refresh costs 1 unit
- **Abuse budgets**: Same cardinality and repeated-verification limits apply

### Abuse Prevention

The `ProofVerificationAbuseService` enforces two budgets:

1. **Distinct-client budget**: Max 100 distinct proof IDs per 15-minute window
   - Prevents scanning unbounded proof ID space
   - Counts all verification requests (standard + refresh)

2. **Repeated-verification budget**:
   - Unknown/invalid proofs: 10 attempts per 15 min
   - Known proofs: 60 attempts per 15 min
   - Counts all verification requests (standard + refresh)

**Note:** Refresh requests cannot bypass these limits. They are checked before processing.

---

## Examples

### Example 1: Prefer-Live Refresh (Recommended)

```bash
curl -X POST http://localhost:3000/proofs/proof-123/verify/refresh \
  -H "Authorization: Bearer eyJhbGc..." \
  -H "Content-Type: application/json" \
  -d '{
    "source": "prefer_live",
    "maxLatencyMs": 5000
  }'
```

**Response (Live Success):**
```json
{
  "result": "VALID",
  "status": "valid",
  "freshness": {
    "provenance": "live",
    "checkedAt": "2025-01-15T12:34:56.789Z",
    "latencyMs": 234
  },
  "credential": { ... },
  "proof": { ... }
}
```

---

### Example 2: LIVE Refresh with Tight Timeout

```bash
curl -X POST http://localhost:3000/proofs/proof-123/verify/refresh \
  -H "Authorization: Bearer eyJhbGc..." \
  -H "Content-Type: application/json" \
  -d '{
    "source": "live",
    "maxLatencyMs": 500
  }'
```

**Response (Timeout):**
```
HTTP/1.1 408 Request Timeout
{
  "error": "Live verification latency bound exceeded: 523ms > 500ms"
}
```

---

### Example 3: CACHE Source (No Network)

```bash
curl -X POST http://localhost:3000/proofs/proof-123/verify/refresh \
  -H "Authorization: Bearer eyJhbGc..." \
  -H "Content-Type: application/json" \
  -d '{
    "source": "cache"
  }'
```

**Response (Instant):**
```json
{
  "result": "VALID",
  "status": "valid",
  "freshness": {
    "provenance": "cache",
    "latencyMs": 42
  },
  "credential": { ... },
  "proof": { ... }
}
```

---

### Example 4: Public Refresh with Sharing Token

```bash
curl -X POST http://localhost:3000/proofs/share_abc123xyz/verify/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "source": "prefer_live",
    "maxLatencyMs": 5000
  }'
```

**Response (Cache Fallback):**
```json
{
  "result": "VALID",
  "status": "valid",
  "freshness": {
    "provenance": "cache_fallback",
    "latencyMs": 234,
    "reason": "live_check_failed: Circuit breaker open"
  },
  "credential": { ... },
  "proof": { ... }
}
```

---

## Testing

### Unit Tests

Located at: `src/proofs/bounded-refresh.service.spec.ts` and `src/proofs/proofs-refresh.controller.spec.ts`

Run with:
```bash
npm test -- bounded-refresh.service.spec.ts
npm test -- proofs-refresh.controller.spec.ts
```

### Integration Tests

Located at: `test/integration/proofs-refresh.int-spec.ts`

Run with:
```bash
npm run test:int -- proofs-refresh.int-spec.ts
```

### Manual Testing

```bash
# Authenticate
TOKEN=$(curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "email": "test@example.com", "password": "..." }' \
  | jq -r '.token')

# Prefer-live refresh
curl -X POST http://localhost:3000/proofs/<proof-id>/verify/refresh \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "source": "prefer_live", "maxLatencyMs": 5000 }' \
  | jq '.freshness'
```

---

## Performance Considerations

- **CACHE source**: ~5-50ms (database query)
- **LIVE source**: ~200-1000ms (contract query) + latency bound
- **PREFER_LIVE source**: ~5-50ms (if cache hit) or ~200-1000ms (if live check needed)

### Optimization Tips

1. Use `maxLatencyMs: 5000` for most cases (balances speed and freshness)
2. Use `source: cache` for bulk verification where stale is acceptable
3. Use `source: live` only when current on-chain state is required
4. Batch verification when possible (use `/proofs/verify/batch` instead)
5. Cache refresh results on client side to avoid redundant requests

---

## Related Documentation

- [Rate Limiting](./request-limits.md)
- [Proof Verification](./proof-verification.md) ← Standard verification endpoint
- [Contract Anchoring](./proof-anchoring.md)
- [Authorization Matrix](./authorization-matrix.md)
