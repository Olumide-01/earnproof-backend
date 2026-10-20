# ADR 0009: Contract State Reconciliation Strategy

**Status**: Accepted

**Date**: 2026-12-15

**Deciders**: Engineering Team

---

## Context

EarnProof maintains authoritative backend projections of contract state (issuer registry, attestations, proofs). The live Stellar smart contract is the source of truth, but we need automated detection of drift between our projections and live state to catch bugs, data corruption, or unexpected contract behavior.

Key constraints:
1. **No silent mismatches**: Unknown digest versions, network/contract mismatches, and stale state must fail verification before comparison
2. **Bounded findings**: Unbounded mismatches cannot be returned (response size + component count capped)
3. **Deterministic comparison**: Same state always produces same results (enables idempotent re-runs)
4. **Concurrent safety**: Multiple workers comparing same checkpoint must produce consistent results
5. **Audit trail**: All failures and mismatches must be persisted for forensics

---

## Decision

Implement a **fetch → verify → compare → persist → bounded-query pipeline** with the following architecture:

### 1. Fail-Closed Verification (No Silent Mismatches)

**Before** any comparison is performed, we verify:
- Digest version is known (prevents silent misinterpretation of new schema)
- Network matches expected (prevents comparing wrong network)
- Contract ID matches expected (prevents comparing wrong contract)
- Digest is not stale (prevents trusting old state)

If any check fails, we **do NOT** perform comparison. Instead, we persist a `ContractStateVerificationFailure` with a specific failure code. Verification failures are never treated as mismatches.

**Benefit**: Fail-closed prevents false positives (treating verification errors as matches). Explicit error codes enable operators to distinguish between transient issues (timeout, rate limit) and structural problems (unknown version, misconfiguration).

### 2. Component-Level Mismatch Granularity

Instead of storing one "MATCH/MISMATCH" per checkpoint, we store one row **per component** that mismatches:

```
checkpointNumber=100, componentName="issuerCount", expectedValue="5", observedValue="6"
checkpointNumber=100, componentName="registrationHash", expectedValue="sha256:abc", observedValue="sha256:def"
```

**Benefits**:
- Operators can quickly identify which specific components diverged
- Future components (payment aggregates, proof counts) can be added without schema migration
- Filtering and sorting by component becomes easier
- Component count is bounded separately from total findings

### 3. Deterministic Digest Computation

Backend digests are computed via:
- Sorted canonical JSON of component data (issuer registry sorted by address)
- SHA-256 hashing of canonical form

Same backend state always produces same digest. This enables:
- Idempotent re-runs (same checkpoint, same result)
- Easy replay (compute digest for historical checkpoints)
- Comparison verification (run twice, expect same mismatches)

### 4. Uniqueness Constraint for Idempotency

Each mismatch is uniquely keyed by:
```
(network, contractId, checkpointNumber, digestVersion, componentName, runId)
```

This allows:
- Same component mismatch recorded **at most once per run** (via `INSERT ON CONFLICT DO NOTHING`)
- Different runs of the same checkpoint use different `runId` values, creating separate audit trails
- No locking needed; database constraint is the safety mechanism

**Benefit**: No complex distributed coordination needed. Concurrent runs are safe via constraints.

### 5. Versioned Digest Schema

Supported digest versions are explicitly enumerated (e.g., ["1.0"]). New versions:
- Are added to the supported list
- Generate `UNKNOWN_VERSION` error if not in list
- Require matching backend computation logic

**Benefit**: Explicit versioning prevents silent misinterpretation. Unknown versions fail immediately rather than producing nonsense comparisons.

### 6. Bounded Findings Query

API returns paginated findings with hard limits:
- Max page size: 100 items
- Default page size: 50 items
- Response size capped at 5MB
- If `totalCount > 50,000`, recommend filtering by date range

**Benefit**: Prevents unbounded output. Prevents DOS from large result sets. Encourages operational filtering (by network, time range, failure code).

### 7. Fail-Safe RPC Resilience

RPC errors are classified as:
- **Transient** (timeout, rate limit, server error, network error): Retry up to 3 times with exponential backoff
- **Permanent** (malformed, not found, connection refused): Fail immediately

**Benefit**: Automated recovery from transient issues without manual intervention. Permanent errors surface immediately for investigation.

---

## Alternatives Considered

### A. Single MATCH/MISMATCH Record per Checkpoint

Instead of component-level granularity, store one row per checkpoint with components in JSON.

**Rejected because**:
- Querying "show me all issuers that diverged" becomes difficult (requires JSON parsing)
- Pagination is awkward (one row = multiple components, hard to page)
- Future components require schema migration

### B. Optimistic Locking with Revision Numbers

Use revision counters to detect concurrent modifications during comparison.

**Rejected because**:
- Adds complexity without benefit (idempotent writes via constraints simpler)
- Requires distributed coordination logic
- Our use case doesn't need strict ordering (different runs are independent)

### C. Silent Upgrade of Unknown Digest Versions

Treat unknown versions as "incompatible, skip comparison" without recording failure.

**Rejected because**:
- Operators wouldn't know a new version is unsupported
- Silent skips are hard to debug
- Explicit failures are safer and more observable

### D. Unbounded Findings Query

Return all findings without pagination or size limits.

**Rejected because**:
- Large networks could have millions of findings
- Unbounded response size enables DOS
- Operators prefer bounded queries with filters (by time, type, code)

---

## Consequences

### Positive

1. **Fail-closed verification** prevents silent false positives and undetected misconfiguration
2. **Component-level storage** enables granular forensics and filtering
3. **Deterministic digests** allow idempotent re-runs and replay
4. **Database uniqueness** avoids distributed coordination and locking complexity
5. **Bounded findings** prevent DOS and encourage operational filtering
6. **Explicit versioning** prevents silent schema misinterpretation
7. **Transient/permanent classification** enables smart retry logic

### Negative

1. **One row per component** (instead of per checkpoint) increases row count slightly, but still manageable (1-10 rows per checkpoint in normal cases)
2. **Three database tables** instead of one, but schema is normalized and easy to query
3. **No automatic recovery from schema changes** (manually update `supportedDigestVersions`)

---

## Compatibility

### Backward Compatibility

- Existing APIs are unaffected (only adds new endpoints)
- New tables don't conflict with existing schema
- No breaking changes to existing services

### Forward Compatibility

- New digest versions can be added without schema migration
- New components can be added to version 1.0 computation without breaking old comparisons
- Idempotency allows old runs to be re-executed with new logic

---

## Metrics & Monitoring

Key metrics:
- **Verification failures by code** (UNKNOWN_VERSION, STALE_CONTRACT_STATE, etc.)
- **Mismatches by component** (which components diverge most often)
- **Comparison latency** (RPC fetch time, digest computation time)
- **Mismatch count over time** (trending towards more/fewer divergences)

---

## References

- [RFC 2119: Key words for use in RFCs to Indicate Requirement Levels](https://tools.ietf.org/html/rfc2119)
- [Stellar Smart Contracts Documentation](https://developers.stellar.org/learn/smart-contracts)
- [EarnProof Architecture](./architecture.md)
- [Contract State Reconciliation Guide](../contract-state-reconciliation.md)
