# Contract State Reconciliation

## Overview

Contract state reconciliation is an automated drift detection system that compares backend projections against live Stellar contract state digests. The system runs on a scheduled interval (hourly by default) and can be triggered on-demand to detect and record state divergence.

### Key Features

- **Fail-Closed Verification**: Unknown digest versions, network mismatches, contract ID mismatches, and stale state all prevent comparison. Failures are recorded separately from mismatches.
- **Idempotent Comparisons**: Same checkpoint compared multiple times produces the same results; database uniqueness constraints prevent duplicate mismatch records within a run.
- **Bounded Findings**: Paginated API with hard limits (max 100 items/page, max 50 default) prevents unbounded output. Response size capped at 5MB.
- **Deterministic Digests**: Backend projection digests are computed the same way every time; identical state produces identical digests, enabling reliable drift detection.
- **Comprehensive Error Handling**: Transient RPC errors retry with exponential backoff (up to 3 attempts, max 5s backoff). Permanent errors fail immediately without retry.

---

## Architecture

### Data Model

#### ContractStateCheckpointMismatch
Records component-level mismatches between backend projections and live contract digests.

```sql
CREATE TABLE "ContractStateCheckpointMismatch" (
  id                TEXT NOT NULL PRIMARY KEY,
  network           TEXT NOT NULL,
  contractId        TEXT NOT NULL,
  checkpointNumber  TEXT NOT NULL,  -- BigInt as TEXT
  digestVersion     TEXT NOT NULL,
  componentName     TEXT NOT NULL,
  expectedValue     TEXT NOT NULL,
  observedValue     TEXT NOT NULL,
  detectionTime     TIMESTAMP(3) NOT NULL,
  runId             TEXT NOT NULL,
  createdAt         TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  
  -- Idempotency: one mismatch per component per run
  UNIQUE (network, contractId, checkpointNumber, digestVersion, componentName, runId)
);
```

#### ContractStateVerificationFailure
Records verification failures (unknown versions, network/contract mismatches, staleness, RPC errors).

```sql
CREATE TABLE "ContractStateVerificationFailure" (
  id             TEXT NOT NULL PRIMARY KEY,
  network        TEXT NOT NULL,
  contractId     TEXT NOT NULL,
  digestVersion  TEXT,           -- May be unknown
  failureCode    TEXT NOT NULL,  -- E.g., UNKNOWN_VERSION, NETWORK_MISMATCH
  failureMessage TEXT NOT NULL,  -- Redacted, no sensitive data
  detectionTime  TIMESTAMP(3) NOT NULL,
  runId          TEXT NOT NULL,
  createdAt      TIMESTAMP(3) NOT NULL DEFAULT NOW()
);
```

#### ContractStateReconciliationRun
Tracks each reconciliation run for operational visibility.

```sql
CREATE TABLE "ContractStateReconciliationRun" (
  id                 TEXT NOT NULL PRIMARY KEY,
  network            TEXT NOT NULL,
  contractId         TEXT NOT NULL,
  checkpointNumber   TEXT NOT NULL,
  digestVersion      TEXT,                -- From contract (if verification passed)
  runId              TEXT NOT NULL UNIQUE,
  verificationStatus TEXT NOT NULL,       -- PASSED or FAILED
  comparisonStatus   TEXT,                -- MATCH, MISMATCH (null if verification failed)
  mismatchCount      INT,                 -- Number of component mismatches
  detectedAt         TIMESTAMP(3) NOT NULL,
  createdAt          TIMESTAMP(3) NOT NULL DEFAULT NOW()
);
```

---

## Pipeline

### 1. Fetch & Verify (Fail-Closed)

The `ContractDigestClient` fetches the digest from the contract RPC with the following verification sequence:

1. **Fetch**: Call contract RPC method `get_checkpoint_digest(checkpointNumber)` with 5s timeout
   - Transient errors (timeout, rate limit, network): retry up to 3 times with exponential backoff (200ms, 400ms, 800ms base)
   - Permanent errors (malformed, client error): fail immediately

2. **Parse**: JSON-decode and validate required fields
   - Missing fields → `PARSE_ERROR`

3. **Version Check**: Verify `digestVersion` is in known list (e.g., ["1.0"])
   - Unknown → `UNKNOWN_VERSION`, **no comparison**

4. **Network Check**: Verify `network` matches expected
   - Mismatch → `NETWORK_MISMATCH`, **no comparison**

5. **Contract Check**: Verify `contractId` matches expected
   - Mismatch → `CONTRACT_MISMATCH`, **no comparison**

6. **Staleness Check**: Verify digest timestamp is within bound (default: < 1 hour old)
   - Stale → `STALE_CONTRACT_STATE`, **no comparison** (unless `skipStaleCheck=true` for admin override)

**Result**: If any check fails, a `ContractStateVerificationFailure` is persisted and comparison is skipped. If all pass, proceed to comparison.

### 2. Compute Backend Digest

The `BackendStateDigestCalculator` materializes a deterministic digest from backend state:

- **issuerCount**: Count of ACTIVE issuers
- **registrationHash**: SHA-256 of canonicalized issuer registry (sorted by stellar address)
- **attestationCount**: Count of ACTIVE attestations

Digests are deterministic: identical backend state always produces identical digest. Future versions can add more components (payment aggregates, proof counts, etc.).

### 3. Compare Components

For each component in the backend digest:
- If present in live digest with identical value → match
- If present but value differs → record mismatch
- If missing in live digest → record mismatch with observedValue="(missing)"

For each component in live digest but missing from backend → log warning (unexpected).

### 4. Persist Findings

All mismatches are persisted via `INSERT ON CONFLICT DO NOTHING` to prevent duplicate records within the same `runId`. Each mismatch is one row.

Verification failures are persisted unconditionally (one row per failure).

### 5. Reconciliation Run Record

A `ContractStateReconciliationRun` record is created to track the overall run:
- `verificationStatus`: PASSED or FAILED
- `comparisonStatus`: MATCH or MISMATCH (null if verification failed)
- `mismatchCount`: Number of component mismatches (null if verification failed)
- `runId`: UUID linking to associated mismatches and failures

---

## API Endpoints

### GET /v1/contract-reconciliation/findings

Retrieve paginated contract reconciliation findings.

**Authorization**: Requires `PROOF_READ` or `ORG_ADMIN` API key scope.

**Query Parameters**:
- `network` (required): Network identifier (e.g., "testnet")
- `contractId` (required): Contract ID
- `type` (optional): "mismatch" or "verification_failure" (default: both)
- `from` (optional): Earliest detection time (ISO-8601)
- `to` (optional): Latest detection time (ISO-8601)
- `page` (optional): Page number, 1-based (default: 1)
- `pageSize` (optional): Items per page, 1-100 (default: 50)
- `sortBy` (optional): "detection_time" or "component_name" (default: "detection_time")
- `sortOrder` (optional): "asc" or "desc" (default: "desc")

**Response**:
```json
{
  "data": [
    {
      "id": "mismatch_abc123",
      "network": "testnet",
      "contractId": "CAAAA...",
      "checkpointNumber": "100",
      "digestVersion": "1.0",
      "componentName": "issuerCount",
      "expectedValue": "5",
      "observedValue": "6",
      "detectionTime": "2026-12-15T10:30:00Z",
      "runId": "run_uuid"
    },
    {
      "id": "failure_def456",
      "network": "testnet",
      "contractId": "CAAAA...",
      "failureCode": "STALE_CONTRACT_STATE",
      "failureMessage": "Digest is stale (3661s old, max 3600s).",
      "detectionTime": "2026-12-15T10:15:00Z",
      "runId": "run_uuid"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "totalCount": 150,
    "totalPages": 3,
    "hasNextPage": true
  },
  "summary": {
    "mismatchCount": 120,
    "verificationFailureCount": 30,
    "totalComponentsAffected": 120
  },
  "limits": {
    "maxComponentsPerPage": 50,
    "maxComponentsTotal": 100
  }
}
```

**Bounds**:
- Max page size: 100 items
- Default page size: 50 items
- Response size capped at 5MB; if exceeded, results are truncated with a "truncated" flag
- If `totalCount > 50,000`, endpoint recommends filtering by date range

---

### POST /v1/contract-reconciliation/compare

Trigger an on-demand checkpoint comparison.

**Authorization**: Requires `ORG_ADMIN` API key scope.

**Request**:
```json
{
  "network": "testnet",
  "contractId": "CAAAA...",
  "checkpointNumber": 100,
  "skipStaleCheck": false
}
```

**Parameters**:
- `network` (required): Network identifier
- `contractId` (required): Contract ID
- `checkpointNumber` (optional): Checkpoint to compare (if omitted, use latest from contract)
- `skipStaleCheck` (optional): If true, skip staleness verification (admin override, default: false)

**Response**:
```json
{
  "runId": "run_uuid",
  "network": "testnet",
  "contractId": "CAAAA...",
  "checkpointNumber": "100",
  "digestVersion": "1.0",
  "verificationStatus": "PASSED",
  "comparisonStatus": "MISMATCH",
  "mismatchCount": 2,
  "detectedAt": "2026-12-15T10:30:00Z"
}
```

If verification fails:
```json
{
  "runId": "run_uuid",
  "network": "testnet",
  "contractId": "CAAAA...",
  "checkpointNumber": "100",
  "verificationStatus": "FAILED",
  "verificationFailures": [
    {
      "code": "UNKNOWN_VERSION",
      "message": "Digest version '2.0' is not supported by this backend. Supported versions: 1.0."
    }
  ],
  "detectedAt": "2026-12-15T10:30:00Z"
}
```

**Timeout**: 30 seconds (request will fail if comparison takes longer)

---

## Configuration

Environment variables (`.env` or `config/configuration`):

```bash
# Enable/disable scheduled reconciliation job
CONTRACT_RECONCILIATION_ENABLED=true

# Contract ID to reconcile
CONTRACT_RECONCILIATION_CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4

# Staleness threshold in milliseconds (default: 1 hour)
CONTRACT_RECONCILIATION_STALE_THRESHOLD_MS=3600000

# Stellar network (inherited from STELLAR_NETWORK)
STELLAR_NETWORK=testnet
```

---

## Digest Versions

### Version 1.0

Supported digest schema with three components:

| Component | Type | Description |
|-----------|------|-------------|
| `issuerCount` | String | Decimal count of ACTIVE issuers |
| `registrationHash` | String | SHA-256 hash of canonicalized issuer registry ("sha256:<hex>") |
| `attestationCount` | String | Decimal count of ACTIVE attestations |

**Canonicalization**:
- Issuers sorted by `stellarAddress` (ascending)
- Each issuer represented as JSON object: `{ id, organizationId, stellarAddress }`
- Entire array JSON-stringified and SHA-256 hashed

### Future Versions

New digest versions can be added by:
1. Adding version string to `supportedDigestVersions` list in `ContractDigestClient`
2. Adding new components to `BackendStateDigestCalculator.computeDigest()`
3. Updating comparison logic if needed

Old versions remain supported for backward compatibility. Comparisons fail-closed if version is unknown.

---

## Error Handling

### RPC Errors (Transient vs. Permanent)

| Category | Examples | Behavior |
|----------|----------|----------|
| **Transient** | Timeout (5s), Rate Limit (429), Server Error (5xx), Network Error | Retry up to 3 times with exponential backoff (200ms → 400ms → 800ms) |
| **Permanent** | Malformed Request (400), Not Found (404), Connection Refused | Fail immediately; recorded as `RPC_PERMANENT_ERROR` |

### Verification Failures

| Code | Meaning | Action |
|------|---------|--------|
| `UNKNOWN_VERSION` | Digest version not recognized | No comparison; update backend if new version is expected |
| `NETWORK_MISMATCH` | Digest network ≠ expected | Check contract configuration; may indicate misconfiguration |
| `CONTRACT_MISMATCH` | Digest contract ID ≠ expected | Check contract configuration |
| `FETCH_TIMEOUT` | RPC timeout after 3 retries | Check Horizon/RPC connectivity; may retry later |
| `RPC_TRANSIENT_ERROR` | Transient RPC error | Retry automatically; may resolve |
| `RPC_PERMANENT_ERROR` | Permanent RPC error | Manual investigation required |
| `PARSE_ERROR` | Response malformed or incomplete | Check contract RPC response format |
| `STALE_CONTRACT_STATE` | Digest > 1 hour old | Contract state may be stuck; investigate separately |

---

## Concurrency & Idempotency

### Concurrent Comparisons

Two workers comparing the same checkpoint simultaneously:
1. Both fetch digest from contract (may succeed independently)
2. Both compute backend digest
3. Both attempt to insert mismatches with same (network, contractId, checkpointNumber, digestVersion, componentName) but different `runId`
4. Database uniqueness constraint includes `runId`, so both inserts succeed with different runs
5. Two separate reconciliation run records created

**Result**: Safe; no duplicates. Each run is independent and generates unique `runId`. Later operators can compare runs to identify persistent vs. transient mismatches.

### Replay Idempotency

Same checkpoint compared twice with same `runId`:
1. First run inserts all mismatches
2. Second run attempts `INSERT ON CONFLICT DO NOTHING` → silently skipped for duplicates
3. Zero duplicate mismatch records created

**Result**: Idempotent at the database layer via uniqueness constraint.

---

## Monitoring & Diagnostics

### Operational Queries

**Recent mismatches**:
```sql
SELECT * FROM "ContractStateCheckpointMismatch"
WHERE network = 'testnet' AND contractId = '...'
ORDER BY createdAt DESC
LIMIT 100;
```

**Verification failure summary**:
```sql
SELECT failureCode, COUNT(*) as count
FROM "ContractStateVerificationFailure"
WHERE network = 'testnet'
GROUP BY failureCode
ORDER BY count DESC;
```

**Runs by status**:
```sql
SELECT verificationStatus, COUNT(*) as count
FROM "ContractStateReconciliationRun"
WHERE network = 'testnet'
GROUP BY verificationStatus;
```

### Structured Logging

All services use `StructuredLogger` with JSON context:

```
{
  "timestamp": "2026-12-15T10:30:00Z",
  "level": "info",
  "service": "ContractStateReconciliationService",
  "message": "Checkpoint comparison complete",
  "runId": "run_uuid",
  "network": "testnet",
  "contractId": "CAAAA...",
  "checkpointNumber": "100",
  "comparisonStatus": "MISMATCH",
  "mismatchCount": 2
}
```

Error logs redact sensitive data (Stellar addresses, keys, tokens) before output.

---

## Migration & Compatibility

### Upgrading Digest Schema

1. **Old digests remain readable**: Version check prevents silent misinterpretation
2. **No re-processing of old runs**: Existing mismatch records keep old digest version
3. **New version takes effect immediately**: Next comparison run uses new schema
4. **Backward compatibility enforced**: Unknown versions fail with `UNKNOWN_VERSION` error

### Database Backwards Compatibility

All schema changes are forward-compatible:
- New columns added are nullable or have defaults
- Existing queries continue to work
- No destructive migrations planned

---

## Testing

### Unit Tests

- **ContractDigestClient**: Verification logic, error classification, retry behavior
- **BackendStateDigestCalculator**: Deterministic digest computation, component calculation
- **ContractStateReconciliationService**: Comparison logic, persistence, error handling

All tests use synthetic fixtures (no production secrets, credentials, or wallet material).

### Integration Tests

- **End-to-end pipeline**: Fetch → verify → compare → persist → query
- **Concurrency**: Concurrent comparisons produce correct results
- **Pagination**: Large result sets handled correctly
- **Authorization**: Unauthorized requests rejected
- **Boundary cases**: Page size at cap, response size at cap, staleness at threshold

### Test Fixtures

Synthetic values used throughout:
- Contract IDs: Valid Stellar contract ID format, but not real contracts
- Digests: Deterministic values based on seed (not production data)
- Mocked RPC: Predefined responses by test scenario

---

## Troubleshooting

### "Digest version is not supported"

**Cause**: Contract returns digest with unknown version (e.g., "2.0" if only "1.0" is supported)

**Solution**: 
1. Verify contract version matches backend configuration
2. Update `supportedDigestVersions` if new version is expected
3. Implement comparison logic for new version

### "Digest is stale"

**Cause**: Contract digest timestamp is > 1 hour old

**Possible causes**:
- Contract state not being updated
- Time synchronization issue (contract's clock drifts from backend)
- Legitimate older checkpoint (less common)

**Solution**:
1. Check contract state freshness via other means
2. Verify time synchronization between systems
3. For operational testing, use `skipStaleCheck=true` (admin endpoint)

### "PARSE_ERROR" or "RPC_PERMANENT_ERROR"

**Cause**: Contract RPC returned invalid response or failed permanently

**Solution**:
1. Check contract RPC availability
2. Verify contract method signature matches expected
3. Check response format matches digest schema
4. Manual investigation required

### Too many mismatches detected

**Cause**: Large-scale state divergence between backend and contract

**Possible causes**:
- Contract state was reset/rolled back
- Backend projection computation bug
- Data corruption

**Solution**:
1. Query findings API to understand scope
2. Investigate backend projection computation
3. Verify contract state via independent means
4. Coordinate with infrastructure team for remediation

---

## References

- [Digest Versions](#digest-versions)
- [Error Handling](#error-handling)
- [Configuration](#configuration)
- [API Endpoints](#api-endpoints)
