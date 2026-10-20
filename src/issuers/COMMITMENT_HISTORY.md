# Issuer Policy Commitment History (#307)

## Overview

Issuer policy commitment history tracks exact issuer policy versions effective at proof issuance time. This enables deterministic proof verification even after issuer policies change.

## Problem

Before this feature:
- Proofs were issued but did not capture the issuer's state at issuance time
- If an issuer changed their signing key, address, or metadata, verifying old proofs could fail
- No audit trail of policy changes linked to proof issuances

## Solution

New immutable `IssuerPolicyCommitment` table tracks versioned issuer policies:

1. **Deterministic versioning**: Each policy change creates a new row with incrementing version number
2. **Immutable snapshots**: Policy data (signing key, address, metadata) is frozen at each version
3. **Proof linkage**: Proofs capture the commitment ID and snapshot at issuance time
4. **Historical queries**: Look up what policy was active when a proof was issued

## Data Model

### IssuerPolicyCommitment table

```sql
CREATE TABLE IssuerPolicyCommitment (
  id STRING PRIMARY KEY,
  issuerId STRING NOT NULL,          -- issuer this commitment is for
  version INT NOT NULL,              -- monotonic per issuer
  commitment STRING UNIQUE NOT NULL, -- sha256:<hex> of policy inputs
  policyInputsHash STRING NOT NULL,  -- sha256:<hex> for deduplication
  policySnapshot JSONB NOT NULL,     -- frozen issuer state at this version
  effectiveAt TIMESTAMP NOT NULL,    -- when this version became active
  supersededAt TIMESTAMP,            -- when next version took effect (NULL = current)
  correlationId STRING,              -- audit trail linkage
  createdAt TIMESTAMP DEFAULT now(),
  
  UNIQUE(issuerId, version),  -- no version gaps or duplicates per issuer
  UNIQUE(commitment),         -- no duplicate commits globally
  INDEX(issuerId, effectiveAt),
  INDEX(issuerId, supersededAt),
  FOREIGN KEY(issuerId) REFERENCES Issuer(id)
)
```

### Proof table extensions

Added columns to capture commitment at issuance time:

```sql
ALTER TABLE Proof ADD COLUMN (
  issuerPolicyCommitmentId STRING,  -- references IssuerPolicyCommitment(id)
  issuerPolicySnapshot JSON         -- full snapshot for offline verification
)
```

### Attestation table extensions

Added column for policy version tracking:

```sql
ALTER TABLE Attestation ADD COLUMN (
  policyVersion STRING  -- "earnproof.attestation.policy.v1:keyId:createdAt"
)
```

## API Endpoints

### Get current issuer policy commitment

```
GET /api/v1/issuers/{issuerId}/policy-commitment/current
Authorization: Bearer <token>

Response 200: {
  "commitment": {
    "id": "c-xyz",
    "issuerId": "issuer-1",
    "version": 5,
    "commitment": "sha256:...",
    "policyInputsHash": "sha256:...",
    "policySnapshot": {
      "signingKeyVersionId": "key-v3",
      "stellarAddress": "GTEST",
      "publicMetadata": { "name": "Test Issuer" },
      "status": "ACTIVE"
    },
    "effectiveAt": "2026-10-16T00:00:00Z",
    "supersededAt": null,
    "correlationId": "evt-123",
    "createdAt": "2026-10-16T10:30:45.000Z"
  },
  "isFirstVersion": false
}
```

### List commitment history

```
GET /api/v1/issuers/{issuerId}/policy-commitment/history?limit=50&offset=0
Authorization: Bearer <token>

Response 200: {
  "items": [
    {
      "id": "c-xyz",
      "version": 5,
      "commitment": "sha256:...",
      "effectiveAt": "2026-10-16T00:00:00Z",
      "supersededAt": null,
      ...
    },
    {
      "id": "c-uvw",
      "version": 4,
      "commitment": "sha256:...",
      "effectiveAt": "2026-10-15T00:00:00Z",
      "supersededAt": "2026-10-16T00:00:00Z",
      ...
    }
  ],
  "total": 5,
  "hasMore": false
}
```

### Get commitment at point in time

```
GET /api/v1/issuers/{issuerId}/policy-commitment/at?timestamp=2026-10-15T12:00:00Z
Authorization: Bearer <token>

Response 200: {
  "commitment": { ... },
  "wasActive": true
}
```

### Get commitment by ID

```
GET /api/v1/issuers/{issuerId}/policy-commitment/{commitmentId}
Authorization: Bearer <token>

Response 200: IssuerPolicyCommitmentDto
```

## Service API

### IssuerPolicyCommitmentsService

Key methods:

```typescript
/**
 * Capture or reuse issuer policy commitment.
 * Returns existing if identical, creates new version otherwise.
 */
async captureOrReuse(
  issuerId: string,
  policySnapshot: IssuerPolicySnapshotInput,
  correlationId?: string
): Promise<IssuerPolicyCommitment>

/**
 * Get current active commitment.
 */
async getCurrentCommitment(issuerId: string): Promise<IssuerPolicyCommitment>

/**
 * Get commitment by ID.
 */
async getCommitmentById(commitmentId: string): Promise<IssuerPolicyCommitment>

/**
 * Get commitment effective at point in time.
 */
async getCommitmentAt(
  issuerId: string,
  timestamp: Date
): Promise<IssuerPolicyCommitment>

/**
 * List all versions paginated.
 */
async listCommitments(
  issuerId: string,
  limit?: number,
  offset?: number
): Promise<{ items: IssuerPolicyCommitmentDto[]; total: number; hasMore: boolean }>

/**
 * Verify org has access to issuer.
 */
async assertCanReadCommitments(
  issuerId: string,
  organizationId: string
): Promise<void>
```

## Proof Verification Flow

### With commitment (new proofs)

```
1. Load proof with issuerPolicyCommitmentId populated
2. Load commitment snapshot from proof (no DB lookup)
3. Reconstruct credential using snapshot
4. Verify signature with signing key from snapshot
5. Result: deterministic, even if issuer policies changed
```

### Without commitment (legacy proofs)

```
1. Load proof with issuerPolicyCommitmentId = NULL
2. Load current issuer state
3. Reconstruct credential using current state
4. Verify signature with current key
5. Result: may fail if issuer changed (backward compat caveat)
```

## Guarantees

### Monotonic versioning

- Version numbers strictly increase per issuer
- No gaps: new version = max(current) + 1
- Unique constraint enforces: UNIQUE(issuerId, version)
- **Prevents reordering attacks**: even if events arrive out of order, versions stay in order

### Deterministic hashing

- Same policy snapshot → same commitment hash
- Hash computed from canonicalized JSON (keys sorted alphabetically)
- Enables deduplication: identical consecutive policies don't create new versions
- **Prevents collision attacks**: commitment hash is globally unique

### Immutable audit trail

- Old commitments never updated or deleted
- `supersededAt` timestamp marks when next version took effect
- Full history preserved for auditing and historical queries
- **Prevents rewriting history**: all changes logged and timestamped

### Authorization

- Only organization members can read their issuers' commitments
- Public API (verification endpoint) does not expose commitments
- Audit logs link policy changes to proof issuances

## Backward Compatibility

- Existing proofs have `issuerPolicyCommitmentId = NULL`
- Migration creates commitments for all existing issuers
- Verification falls back to current issuer state for old proofs
- No breaking changes to APIs or data structures

## Testing

Unit tests:
- Deterministic hashing
- Version numbering
- Authorization checks
- Boundary conditions

Integration tests:
- Monotonic versioning (no regressions)
- Deduplication (identical policies)
- Immutable audit trail (supersession)
- Historical queries (point-in-time)
- Backward compatibility

## Examples

### Scenario: Policy change detection

```typescript
// Get issuer policy at proof issuance time
const commitment = await service.getCommitmentById(proof.issuerPolicyCommitmentId);

// Compare to current
const current = await service.getCurrentCommitment(issuer.id);

if (commitment.version !== current.version) {
  // Policy changed since proof was issued
  // Can still verify using historical commitment
}
```

### Scenario: Audit trail

```typescript
// List all policy versions for an issuer
const history = await service.listCommitments(issuerId, 1000, 0);

// Find when signing key changed
const keyChanges = history.items.filter((c, i, arr) => 
  i === 0 || 
  c.policySnapshot.signingKeyVersionId !== arr[i-1].policySnapshot.signingKeyVersionId
);

// Correlate with proof issuances
for (const change of keyChanges) {
  const proofs = await db.proof.findMany({
    where: {
      issuerPolicyCommitmentId: change.id
    }
  });
  console.log(`Key change ${change.version}: ${proofs.length} proofs issued`);
}
```

## See Also

- ADR-0005: Deterministic credential canonicalization
- ADR-0006: Outbox pattern for anchoring
- docs/architecture.md: System design overview
