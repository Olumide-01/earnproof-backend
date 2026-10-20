# Verification Source Provenance Chains

## Overview

Verification source provenance chains provide an auditable account of which credential, backend, contract, and Stellar observations contributed to each verification decision. This enables transparency, dispute resolution, and compliance audit trails.

## Key Features

### 1. Complete Source Lineage

Every verification decision captures all sources that contributed to the outcome:

- **Credential Sources**: Payments, attestations, trusted sources, proof claims
- **Backend Observations**: Policy versions, payment sync checkpoints, classification history
- **Contract Observations**: On-chain proof status (revoked, valid) from Stellar contract
- **Stellar Observations**: Horizon operations, ledger finality confirmations, payment data

### 2. Versioned Decision Schema

Provenance records include a schema version (`earnproof.verification.provenance.v1`) enabling evolution of the decision structure over time without breaking existing records.

### 3. Privacy and Security

- **No Raw Payloads**: Only source identity and hashes are stored, never raw credentials or payment data
- **Deterministic Hashing**: Decision inputs are hashed deterministically for auditability and reproducibility
- **Tenant Isolation**: Provenance is scoped by proof ID, which binds to a specific user
- **Authorization Enforcement**: Access to provenance requires proof ownership (same user)

### 4. Immutable Decision Trail

Provenance records are created atomically at verification time and never modified. Each decision is uniquely keyed by `(proofId, decidedAt)`, preventing accidental duplicates and enabling audit trails.

### 5. Fail-Open Architecture

Provenance recording is asynchronous and does not block verification. If recording fails, the verification response is still returned, ensuring availability over audit completeness.

## Data Model

### VerificationProvenance

Stores the complete verification decision and all source observations.

```prisma
model VerificationProvenance {
  id                  String
  proofId             String    // Proof being verified
  schemaVersion       String    // Versioned schema (e.g., "earnproof.verification.provenance.v1")
  decisionInputHash   String    // Hash of all decision inputs
  credentialHash      String    // Hash of reconstructed credential
  policyVersion       String    // Policy version applied (e.g., "earnproof.minimum-income.policy.v1")
  proofStatus         String    // Proof status at verification time (ACTIVE, EXPIRED, REVOKED, INVALID)
  verificationResult  String    // Final result (VALID, EXPIRED, REVOKED, INVALID_SIGNATURE, etc)
  failureReason       String?   // High-level reason if verification failed
  boundaryContext     String?   // Optional context about boundary conditions
  sources             Json      // Array of source observations with metadata
  sourceCount         Int       // Total number of sources
  decidedAt           DateTime  // When decision was made
  createdAt           DateTime  // Record creation timestamp
}
```

### VerificationProvenanceSource

Individual source records for efficient querying by type or ID.

```prisma
model VerificationProvenanceSource {
  id                 String
  provenanceId       String    // Foreign key to VerificationProvenance
  proofId            String    // Denormalized for efficient queries
  sourceType         Enum      // CREDENTIAL_SOURCE, BACKEND_OBSERVATION, CONTRACT_OBSERVATION, STELLAR_OBSERVATION
  sourceId           String    // Specific source identity (e.g., paymentId, operationId)
  sourceLabel        String?   // Human-readable label (e.g., "PAYMENT_RECEIVED")
  observedAt         DateTime  // When source was observed
  sourceHash         String    // SHA-256 hash of source metadata
  observationOrder   Int       // Sequential position in decision lineage
  missingLinkReason  String?   // Reason if source was unavailable or excluded
  decidedAt          DateTime  // When decision was made
  createdAt          DateTime  // Record creation timestamp
}
```

## Integration Points

### Verification Flow

During `verifyProof()`:

1. Reconstruct credential from proof claim
2. Perform signature validation, status checks, and contract observations
3. Determine final verification result
4. **Record provenance asynchronously** (fail-open):
   - Build provenance with all observations
   - Create VerificationProvenance and VerificationProvenanceSource records atomically
   - Log any recording errors without blocking verification

### Decision Inputs Captured

```typescript
interface VerificationProvenanceInput {
  proofId: string;
  schemaVersion: string;              // Version for future evolution
  decisionInputHash: string;           // Hash of all inputs for reproducibility
  credentialHash: string;              // Credential snapshot
  policyVersion: string;               // Policy that produced decision
  proofStatus: string;                 // State at verification time
  verificationResult: VerificationResult; // VALID, EXPIRED, REVOKED, etc
  failureReason?: string;              // Why verification failed
  boundaryContext?: string;            // Boundary condition context
  sources: VerificationProvenanceSourceInput[]; // All observations in order
}
```

## API Endpoints

### Get Latest Provenance

```http
GET /api/v1/proofs/{proofId}/provenance
Authorization: Bearer {token}
```

Returns the most recent verification decision and complete source lineage.

**Response** (200 OK):
```json
{
  "decidedAt": "2026-01-15T10:00:00.000Z",
  "schemaVersion": "earnproof.verification.provenance.v1",
  "policyVersion": "earnproof.minimum-income.policy.v1",
  "proofStatus": "ACTIVE",
  "verificationResult": "VALID",
  "sources": [
    {
      "sourceType": "CREDENTIAL_SOURCE",
      "sourceId": "payment-abc123",
      "sourceLabel": "PAYMENT_RECEIVED",
      "observedAt": "2026-01-15T10:00:00.000Z",
      "observationOrder": 0
    },
    {
      "sourceType": "BACKEND_OBSERVATION",
      "sourceId": "policy-v1",
      "sourceLabel": "POLICY_APPLIED",
      "observedAt": "2026-01-15T10:00:05.000Z",
      "observationOrder": 1
    },
    {
      "sourceType": "CONTRACT_OBSERVATION",
      "sourceId": "contract-tx-def456",
      "sourceLabel": "PROOF_VALID",
      "observedAt": "2026-01-15T10:00:10.000Z",
      "observationOrder": 2
    }
  ],
  "sourceCount": 3
}
```

### List All Provenance Records

```http
GET /api/v1/proofs/{proofId}/provenance/list
Authorization: Bearer {token}
```

Returns chronological list of all verification decisions (useful for auditing changes over time).

**Response** (200 OK):
```json
{
  "proofId": "proof-xyz789",
  "provenances": [
    { /* first decision */ },
    { /* second decision */ },
    { /* third decision */ }
  ],
  "total": 3
}
```

### Get Sources by Type

```http
GET /api/v1/proofs/{proofId}/provenance/sources?sourceType=CREDENTIAL_SOURCE
Authorization: Bearer {token}
```

Returns only sources of a specific type (CREDENTIAL_SOURCE, BACKEND_OBSERVATION, CONTRACT_OBSERVATION, STELLAR_OBSERVATION).

**Response** (200 OK):
```json
{
  "sourceType": "CREDENTIAL_SOURCE",
  "sources": [
    {
      "sourceType": "CREDENTIAL_SOURCE",
      "sourceId": "payment-abc123",
      "sourceLabel": "PAYMENT_RECEIVED",
      "observedAt": "2026-01-15T10:00:00.000Z",
      "observationOrder": 0
    }
  ],
  "total": 1
}
```

### Get Provenance Summary

```http
GET /api/v1/proofs/{proofId}/provenance/summary
Authorization: Bearer {token}
```

Quick check for whether provenance exists without fetching full lineage.

**Response** (200 OK):
```json
{
  "proofId": "proof-xyz789",
  "hasProvenance": true,
  "latestDecidedAt": "2026-01-15T10:00:00.000Z",
  "provenanceCount": 1,
  "latestVerificationResult": "VALID",
  "latestSourceCount": 3
}
```

## Boundary and Failure Semantics

### Tenant Isolation

- Provenance is accessible only by the proof owner (same user)
- Cross-tenant access is rejected at the query layer
- Proof ID foreign key enforces database-level isolation

### Missing Link Reasons

When a source is unavailable or excluded, `missingLinkReason` explains why:

- `STALE_CHECKPOINT`: Payment sync checkpoint is stale; acceptable per policy
- `NETWORK_TIMEOUT`: Stellar Horizon or contract query timed out
- `ATTESTATION_EXPIRED`: Attestation no longer valid; not included in decision
- `AUTHORIZATION_DENIED`: User lacks permission to access source
- `SOURCE_REVOKED`: Source (payment, attestation) was revoked
- `PAYMENT_INELIGIBLE`: Payment does not meet eligibility criteria
- `CONTRACT_UNAVAILABLE`: On-chain contract check unavailable
- `CREDENTIAL_MISMATCH`: Credential signature does not match stored hash

### Failure Reasons

When verification fails, `failureReason` indicates the high-level cause:

- `PROOF_EXPIRATION_DETECTED`: Proof past expiration date
- `PROOF_REVOCATION_DETECTED`: Proof marked as revoked
- `CREDENTIAL_MISMATCH`: Reconstructed credential does not match stored hash
- `ANCHORING_INCOMPLETE`: Proof not yet confirmed on-chain (when required)
- `PROOF_NOT_FOUND`: Proof does not exist

### Deterministic Behavior

All provenance decisions are deterministic and reproducible:

1. Same proof + same policy version + same backend state = same decision
2. `decisionInputHash` is deterministic snapshot of all inputs
3. Source ordering is deterministic based on observation sequence
4. Replay attacks are prevented by `(proofId, decidedAt)` uniqueness

## Privacy and Data Minimization

### Never Stored

- Raw credential payloads
- Private proof claims
- Payment amounts or addresses
- Attestation content
- Wallet addresses

### Always Hashed

- Credential structure (only structure, never content)
- Policy version string (hashed, not full policy)
- Source IDs (hashed, not raw values)
- Decision inputs (hashed for reproducibility)

### Never Exposed Publicly

- Internal hashes (`decisionInputHash`, `credentialHash`, `sourceHash`)
- Private reason codes (only public `failureReason` and `missingLinkReason`)
- Operator notes
- Raw proof state

## Concurrency and Atomicity

- Provenance records are created atomically in a single transaction
- VerificationProvenance is created first, then all VerificationProvenanceSource records
- Unique constraint on `(proofId, decidedAt)` prevents duplicates
- Concurrent verifications of same proof create separate provenance records (one per decision timestamp)

## Versioning Strategy

The schema version field enables future evolution:

### Current Version

- `earnproof.verification.provenance.v1`: Initial release
  - Supports CREDENTIAL_SOURCE, BACKEND_OBSERVATION, CONTRACT_OBSERVATION, STELLAR_OBSERVATION
  - Captures schema version, policy version, proof status, verification result
  - Includes failure reasons and boundary context

### Future Versions

If provenance structure changes (e.g., additional metadata, new source types):

1. Introduce `earnproof.verification.provenance.v2` schema
2. Create new migration and endpoint versions
3. Existing v1 records remain unchanged
4. Query layer can dispatch on schemaVersion for compatibility

## Testing Scenarios

### Positive Cases

- [x] Record complete provenance with all source types
- [x] Retrieve latest provenance for authorized user
- [x] List chronological provenance history
- [x] Filter sources by type
- [x] Get provenance summary

### Negative Cases

- [x] Unauthorized user access rejected
- [x] Unknown proof returns 404
- [x] Missing provenance returns gracefully
- [x] Empty source list handled

### Boundary Cases

- [x] Provenance with no sources
- [x] All optional fields (missing link reasons, failure context)
- [x] Large source lists (many observations)
- [x] Concurrent verifications of same proof

### Authorization

- [x] Tenant isolation enforced
- [x] Cross-tenant access rejected
- [x] Proof ownership verified

## Security Considerations

### Immutability

Provenance records are created once and never modified. This ensures:
- Decision audit trails cannot be tampered with
- Historical provenance reflects actual decision at that time
- Disputes can reference exact provenance state

### Privacy Boundaries

Provenance is scoped by proof, which is scoped by user. This ensures:
- Users cannot see other users' provenance
- Provenance metadata does not leak sensitive information
- Source IDs are hashed for privacy

### Fail-Open Design

Provenance recording failures do not block verification:
- Verification always succeeds or fails based on core logic
- Provenance recording is advisory and retryable
- Errors are logged for investigation but never propagate

## Future Enhancements

### Provenance Dispute Resolution

Future work could extend provenance to support formal dispute workflows:
- Stakeholder review of decision and sources
- Annotated provenance with dispute metadata
- Resolution outcome tracking

### Provenance Attestation

Provenance chains could be persisted to Stellar ledger:
- Anchored provenance transaction hashes in contract
- Cryptographic proof of provenance immutability
- Third-party verifiable decision lineage

### Provenance Analytics

Aggregated provenance analytics without exposing individual records:
- Decision distribution by source type
- Policy version adoption tracking
- Failure reason frequency analysis
