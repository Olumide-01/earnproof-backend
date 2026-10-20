# Revocation Checkpoints

## Overview

Revocation checkpoints provide indexed, monotonic commitments to revocation state on a blockchain or distributed ledger. Each checkpoint records:

- **Sequence**: A monotonically increasing position in the stream
- **Root**: A cryptographic commitment (e.g., SHA-256 digest or Merkle tree root)
- **Algorithm**: The computation method (e.g., "sha256", "merkle-tree-v1")
- **Ledger**: The chain identifier (e.g., "stellar", "ethereum")
- **Contract Identity**: The contract or registry address
- **Observed Time**: When the checkpoint was observed on-chain

Checkpoints enable verification services to:
1. **Track freshness**: Know how stale revocation information is
2. **Detect conflicts**: Identify when multiple roots claim the same sequence (regression detection)
3. **Enable live reconciliation**: Compare backend projection against on-chain state
4. **Quarantine anomalies**: Safely isolate regressed or conflicting roots without silently accepting or dropping them

---

## Data Model

### RevocationCheckpoint

Persists all checkpoints (accepted and quarantined):

```
id                    UUID
ledger                "stellar", "ethereum", etc.
contractIdentity      Contract address
algorithm             "sha256", "merkle-tree-v1", etc.
sequence              BigInt (monotonically increasing per stream)
root                  Hex-encoded commitment
observedAt            Timestamp (when observed on-chain)
status                ACCEPTED | QUARANTINED
acceptedAt            Timestamp (when accepted into stream)
quarantineReason      Enum (if quarantined)
quarantineDetails     Bounded message
quarantinedAt         Timestamp (if quarantined)
createdAt, updatedAt  Lifecycle timestamps
```

**Unique Constraint**: `(ledger, contractIdentity, algorithm, sequence, root)` ensures idempotency.

### RevocationCheckpointStreamHead

Denormalized view of the latest accepted checkpoint per stream:

```
id                    UUID
ledger                "stellar", "ethereum", etc.
contractIdentity      Contract address
algorithm             "sha256", "merkle-tree-v1", etc.
sequence              BigInt (current head)
root                  Hex-encoded commitment (current head)
observedAt            Timestamp (from head)
acceptedAt            Timestamp (when accepted)
version               Int (optimistic concurrency version)
createdAt, updatedAt  Lifecycle timestamps
```

**Unique Constraint**: `(ledger, contractIdentity, algorithm)` defines the stream.

---

## Monotonicity Enforcement

### Rules

A checkpoint is **accepted** if:
- It is the first checkpoint for the stream, OR
- Its sequence is strictly greater than the current head sequence, OR
- Its sequence, root, and observedAt are identical to the current head (replay, idempotent)

A checkpoint is **quarantined** (never accepted, never advances head) if:
- Its sequence is lower than the current head sequence, OR
- Its sequence equals the current head sequence but root differs (conflict), OR
- Input validation fails (malformed, unknown algorithm, etc.)

### Enforcement Strategy

**Database-level** using PostgreSQL:
1. **Unique constraint** on `(ledger, contractIdentity, algorithm, sequence, root)` prevents duplicate acceptance
2. **Conditional insert** in transaction ensures monotonicity is checked before persisting
3. **StreamHead upsert** is atomic: either head advances or checkpoint is quarantined, not both

**Lock-free design**: Concurrent writers racing on the same stream will have exactly one succeed (via unique constraint), and others will either be idempotent or quarantined.

---

## Quarantine Behavior

### Quarantine Reasons

| Reason | When | Response |
|--------|------|----------|
| `LOWER_SEQUENCE` | Sequence < current head | Quarantined, operator review recommended |
| `SEQUENCE_CONFLICT` | Sequence == head but root ≠ head | Quarantine, indicates possible fork or data corruption |
| `STALE_OBSERVED_TIME` | Timestamp older than head | Quarantine, may indicate replay or stale data |
| `MALFORMED_INPUT` | Missing/invalid fields | Rejected immediately (400) |
| `ALGORITHM_UNKNOWN` | Algorithm not in allowed list | Rejected immediately (400) |
| `WRONG_CONTRACT_ID` | Contract mismatch | Rejected (400) or quarantined based on context |
| `WRONG_LEDGER` | Ledger mismatch | Rejected (400) or quarantined |
| `REPLAY_DUPLICATE` | Identical checkpoint re-submitted | Accepted (idempotent) |

### Quarantine Lifecycle

- **Persisted**: Quarantined checkpoints are never dropped; they remain visible for audit and operator review
- **Never silent**: Operator is alerted that a checkpoint was rejected
- **Never advancing**: A quarantined checkpoint does not update the stream head
- **Queryable**: Use `GET /api/v1/revocation-checkpoints/quarantine` to list quarantined items by reason

---

## Freshness Semantics

### Freshness DTO

```json
{
  "sequence": "12345",
  "root": "abc123def456...",
  "observedAt": "2024-01-15T10:30:00Z",
  "acceptedAt": "2024-01-15T10:31:00Z",
  "age": {
    "seconds": 3600,
    "staleBeyond": false
  }
}
```

- **sequence**: Current head sequence
- **root**: Current head root
- **observedAt**: Timestamp from the checkpoint as observed on-chain
- **acceptedAt**: Timestamp when this checkpoint was accepted into the stream
- **age.seconds**: How long (in seconds) since acceptedAt
- **age.staleBeyond**: Boolean indicating if age > freshness threshold (default 1 hour)

### Staleness Threshold

Default: **1 hour** (3,600,000 ms)

Can be customized via environment variable:
```
REVOCATION_FRESHNESS_THRESHOLD_MS=7200000  # 2 hours
```

### Inclusive/Exclusive Boundary

- **Exactly at threshold**: Considered fresh (inclusive boundary)
- **Beyond threshold**: Considered stale

Example: 1-hour threshold
- 3,599 seconds ago → `staleBeyond: false`
- 3,600 seconds ago → `staleBeyond: false`
- 3,601 seconds ago → `staleBeyond: true`

---

## Live-Contract Reconciliation

### Pattern

Use the existing `ContractDigestClient` to compare backend projection against live contract state:

```typescript
const freshness = await revocationCheckpointService.getFreshCheckpoint(
  'stellar',
  'CAQWMB...',  // contract ID
  'sha256',
);

const liveDigest = await contractDigestClient.fetchAndVerify({
  network: 'mainnet',
  contractId: 'CAQWMB...',
});

const match = freshness.root === liveDigest.components['revocation_root'];
```

### Error Handling

Live comparison is **fail-closed**:
- **Network timeout** → no match, log as "FETCH_TIMEOUT"
- **Stale contract state** → no match, log as "STALE_CONTRACT_STATE"
- **Transient RPC error** → no match, log as "RPC_TRANSIENT_ERROR"
- **Unknown digest version** → no match, log as "UNKNOWN_VERSION"

Never assume a match on error; always verify explicitly.

---

## API Endpoints

### POST /api/v1/revocation-checkpoints

Create or update a revocation checkpoint.

**Request**:
```json
{
  "ledger": "stellar",
  "contractIdentity": "CAQWMB...",
  "algorithm": "sha256",
  "sequence": "12345",
  "root": "abc123def456...",
  "observedAt": "2024-01-15T10:30:00Z"
}
```

**Response (Accepted)** (201):
```json
{
  "status": "accepted",
  "checkpoint": {
    "id": "...",
    "sequence": "12345",
    "root": "abc123def456...",
    "observedAt": "2024-01-15T10:30:00Z",
    "acceptedAt": "2024-01-15T10:31:00Z",
    "status": "ACCEPTED"
  },
  "head": {
    "sequence": "12345",
    "root": "abc123def456...",
    "observedAt": "2024-01-15T10:30:00Z",
    "acceptedAt": "2024-01-15T10:31:00Z"
  }
}
```

**Response (Quarantined)** (201):
```json
{
  "status": "quarantined",
  "checkpoint": {
    "id": "...",
    "sequence": "5000",
    "root": "wrong_root...",
    "observedAt": "2024-01-15T10:20:00Z",
    "acceptedAt": "2024-01-15T10:31:00Z",
    "status": "QUARANTINED",
    "quarantineReason": "LOWER_SEQUENCE"
  },
  "head": {
    "sequence": "12345",
    "root": "abc123def456...",
    "observedAt": "2024-01-15T10:30:00Z",
    "acceptedAt": "2024-01-15T10:31:00Z"
  }
}
```

**Response (Validation Error)** (400):
```json
{
  "statusCode": 400,
  "message": "algorithm must be one of: sha256, merkle-tree-v1, merkle-tree-v2",
  "error": "Bad Request"
}
```

---

### GET /api/v1/revocation-checkpoints/fresh

Retrieve the latest accepted checkpoint with freshness metadata.

**Query Parameters**:
- `ledger` (required): e.g., "stellar"
- `contractIdentity` (required): e.g., "CAQWMB..."
- `algorithm` (required): e.g., "sha256"

**Response** (200):
```json
{
  "sequence": "12345",
  "root": "abc123def456...",
  "observedAt": "2024-01-15T10:30:00Z",
  "acceptedAt": "2024-01-15T10:31:00Z",
  "age": {
    "seconds": 3600,
    "staleBeyond": false
  }
}
```

**Response** (404): No checkpoint exists for this stream

---

### GET /api/v1/revocation-checkpoints/quarantine

List quarantined checkpoints for operator review.

**Query Parameters** (all optional):
- `ledger`: Filter by ledger
- `contractIdentity`: Filter by contract
- `algorithm`: Filter by algorithm
- `reason`: Filter by quarantine reason (enum)
- `limit`: Results per page (default 50, max 500)
- `offset`: Pagination offset (default 0)

**Response** (200):
```json
{
  "items": [
    {
      "id": "...",
      "ledger": "stellar",
      "contractIdentity": "CAQWMB...",
      "algorithm": "sha256",
      "sequence": "5000",
      "root": "wrong_root...",
      "observedAt": "2024-01-15T10:20:00Z",
      "quarantineReason": "LOWER_SEQUENCE",
      "quarantineDetails": "sequence is lower than current head (12345)",
      "quarantinedAt": "2024-01-15T10:31:00Z"
    }
  ],
  "total": 1
}
```

---

## Proof Verification Isolation

### Key Guarantee

**Checkpoints do NOT affect proof verification.**

Proof validity is determined by:
1. Signature validity (credential hash matches)
2. Proof status (ACTIVE vs REVOKED)
3. Expiration
4. Contract anchoring status (if applicable)

Checkpoints are **additional evidence only** for revocation reconciliation.

### Regression Test

A proof that fails its own validity checks is still rejected, even if a fresh checkpoint exists:

```typescript
const proof = buildRevokedProof(); // status: REVOKED
const checkpoint = buildFreshAcceptedCheckpoint(); // sequence: 1000, root: "abc..."

const result = await proofService.verifyProof(proof.id);
expect(result).toBe(VerificationResult.REVOKED); // Still revoked, checkpoint ignored
```

---

## Configuration

Configure via environment variables:

```bash
# Enable/disable checkpoint feature
REVOCATION_CHECKPOINTS_ENABLED=true

# Freshness threshold (milliseconds, default 1 hour)
REVOCATION_FRESHNESS_THRESHOLD_MS=3600000

# Allowed algorithms (comma-separated, validated on input)
REVOCATION_ALLOWED_ALGORITHMS=sha256,merkle-tree-v1,merkle-tree-v2

# Allowed ledgers (comma-separated, validated on input)
REVOCATION_ALLOWED_LEDGERS=stellar,ethereum
```

---

## Migration & Backfill

### Prisma Migration

```bash
npx prisma migrate deploy
```

This will:
1. Create `RevocationCheckpoint` table with indexes
2. Create `RevocationCheckpointStreamHead` table with unique constraint
3. Initialize enums for status and quarantine reasons

### No Backfill Required

Checkpoints are forward-looking; no historical data needs to be populated.

Streams with no checkpoints yet:
- `GET /api/v1/revocation-checkpoints/fresh` → 404 Not Found
- First checkpoint creates both `RevocationCheckpoint` and `RevocationCheckpointStreamHead` records

---

## Testing

### Unit Tests

Run checkpoint service and controller tests:

```bash
npm run test -- revocation-checkpoint.service.spec
npm run test -- revocation-checkpoint.controller.spec
```

### Coverage

- Monotonicity enforcement (accept, quarantine, replay)
- Freshness calculation
- Concurrency (parallel identical/conflicting writes)
- Error taxonomy (validation, authorization, state)
- Proof verification isolation

### Fixtures

All fixtures use synthetic data:
- Fake contract identities: "contract-<N>"
- Fake roots: deterministic hex strings from seed
- Fake ledgers: "stellar", "ethereum"
- No proof data, wallet material, or credentials

---

## Troubleshooting

### Checkpoint quarantined but should be accepted

Check:
1. Is the sequence strictly greater than current head? (if not, it's a regression)
2. Is the root identical to current head at the same sequence? (if not, it's a conflict)
3. Is the algorithm in the allowed list?

Query quarantine for diagnostics:
```bash
curl "http://localhost:3000/api/v1/revocation-checkpoints/quarantine?reason=LOWER_SEQUENCE"
```

### Freshness appears stale

Check:
1. How long has it been since `acceptedAt`?
2. What is the configured freshness threshold?
3. Is the checkpoint still the latest for that stream?

```bash
curl "http://localhost:3000/api/v1/revocation-checkpoints/fresh?ledger=stellar&contractIdentity=CAQWMB&algorithm=sha256"
```

### Live comparison shows mismatch

Check:
1. Is the contract state on-chain current?
2. Has the backend projection been updated since the last on-chain state?
3. Are there any quarantined checkpoints that might indicate a fork?

---

## Security Considerations

### No Secrets Stored

Checkpoints store only:
- Public chain identifiers (ledger, contract ID)
- Public commitment digests (roots)
- Public timestamps

No private keys, proof data, wallet addresses, or credentials are stored.

### Authorization

- **Write**: Requires `ORG_ADMIN` scope
- **Read freshness**: Requires `PROOF_READ` scope
- **Query quarantine**: Requires `ORG_ADMIN` scope (operator review)

### Deterministic Errors

All errors are bounded (enums, not free text) to prevent information leakage.

---

## References

- Design Document: See top-level DESIGN.md
- GitHub Issue: #333
- Architecture: See docs/architecture.md
