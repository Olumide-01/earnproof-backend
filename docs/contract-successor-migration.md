# Contract Successor Migration Readiness Assessment

## Overview

This document describes the contract successor migration readiness assessment feature, which provides a coordinated view of compatibility, pause state, migrations, checkpoints, and dependent services for contract successor activation.

The assessment is deterministic, immutable once computed, and blocks migration if any finding cannot be individually acknowledged. It follows established patterns from the health check system and integrates with governance proposals.

## Design Principles

### Successor Identity

A successor contract is uniquely identified by:
- **Network**: The Stellar network (e.g., `testnet`, `mainnet`)
- **Contract ID**: The contract's address on the network
- **Expected Version**: The schema version expected to be deployed

The triple (network, contractId, expectedVersion) is network-bound and immutable.

### Readiness Verdict

A successor is ready for migration when:
1. **Live contract identity matches expected** — Network, contractId, and schemaVersion all verified live
2. **All blocking findings acknowledged or absent** — Any blocking issue must be explicitly acknowledged with a TTL
3. **Assessment is recent** — Not older than the configured staleness threshold (60 seconds default)
4. **Pause state is compatible** — The successor is not paused, or pause state is acceptable for migration
5. **Migration checkpoint is current** — Latest validation gates have passed within the retention window

### Finding Classification

Findings are classified by severity:

- **Blocking**: Migration cannot proceed until finding is resolved or acknowledged
- **Advisory**: Migration can proceed, but findings should be reviewed
- **Informational**: Observations for audit trail, no action required

### Acknowledgement Model

Operators can acknowledge expected blocking findings with:
- **Note**: Human-readable reason (stored for audit trail)
- **TTL**: Time-to-live (bounded max 7 days; after expiry, the acknowledgement is ignored)
- **Actor ID**: Who acknowledged it (from audit system, never raw PII)

## API Endpoints

All endpoints require authentication with `ORG_ADMIN` API key scope.

### Assess Readiness

```
GET /contracts/:network/:contractId/successor/readiness
```

Returns a deterministic readiness verdict with all findings.

**Response:**
```json
{
  "successor": {
    "network": "testnet",
    "contractId": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    "expectedVersion": 1
  },
  "status": "ready",
  "findings": [
    {
      "key": "identity_verified",
      "severity": "informational",
      "description": "Successor contract identity verified on network.",
      "acknowledged": false
    }
  ],
  "overall": "none",
  "cached": false,
  "assessedAt": "2026-10-16T12:34:56.789Z",
  "latestCheckpoint": {
    "createdAt": "2026-10-16T12:34:56.789Z",
    "observedLedger": "100000000",
    "passedGates": ["identity_verified", "pause_state_checked"],
    "failedGates": []
  }
}
```

### Acknowledge Finding

```
POST /contracts/:network/:contractId/successor/findings/:findingKey/acknowledge
```

Records an operator acknowledgement for a readiness finding.

**Request:**
```json
{
  "note": "Expected schema version mismatch during planned upgrade",
  "ttlSeconds": 86400
}
```

**Response:**
```json
{
  "findingKey": "schema_version_mismatch",
  "acknowledgedAt": "2026-10-16T12:34:56.789Z",
  "expiresAt": "2026-10-17T12:34:56.789Z",
  "acknowledgedBy": "actor-123"
}
```

### Check Migration Readiness

```
GET /contracts/:network/:contractId/successor/can-migrate
```

Returns a boolean indicating whether migration can proceed.

**Response:**
```json
{
  "canMigrate": true
}
```

## Findings Reference

### Blocking Findings

These must be resolved or acknowledged to proceed:

| Key | Description |
|-----|-------------|
| `successor_not_found` | Successor contract not found or network unreachable |
| `identity_mismatch` | Live contract identity does not match expected |
| `schema_version_mismatch` | Schema version on contract differs from backend config |
| `successor_paused` | Successor contract is paused and cannot migrate |
| `stale_checkpoint` | Migration checkpoint is stale or incomplete |
| `ledger_reorg_detected` | Ledger reorg detected, monotonicity violated |
| `blocking_findings_unacknowledged` | Blocking finding(s) not acknowledged |
| `assessment_stale` | Assessment is too old to mark migration ready |
| `verification_timeout` | Live contract state could not be verified in time |

### Advisory Findings

These don't block migration but should be reviewed:

| Key | Description |
|-----|-------------|
| `pause_state_incompatible` | Pause state verification failed or incompatible |
| `pause_state_not_found` | Pause state record not found; assuming operational |

### Informational Findings

These are observations for the audit trail:

| Key | Description |
|-----|-------------|
| `identity_verified` | Successor contract identity verified on network |
| `pause_state_compatible` | Successor pause state is compatible with migration |
| `checkpoint_valid` | Migration checkpoint is current and complete |

## Usage Examples

### 1. Assess a Successor Contract

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://api.example.com/contracts/testnet/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4/successor/readiness"
```

### 2. Acknowledge a Expected Schema Mismatch

The assessment detects that the successor schema version differs from backend config. This is expected during a planned upgrade, so we acknowledge it for 24 hours:

```bash
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "note": "Planned schema upgrade; acknowledging expected mismatch",
    "ttlSeconds": 86400
  }' \
  "https://api.example.com/contracts/testnet/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4/successor/findings/schema_version_mismatch/acknowledge"
```

### 3. Check if Migration Can Proceed

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://api.example.com/contracts/testnet/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4/successor/can-migrate"
```

Response will be `{"canMigrate": true}` or `{"canMigrate": false}`.

## Implementation Details

### Caching and Staleness

- **Cache TTL**: 5 seconds (configurable via `health.cacheTtlMs`)
- **Max Assessment Age**: 60 seconds (configurable via `contractSuccessor.maxAssessmentAgeMs`)
- **Stale Assessment Detection**: Results older than max age cannot mark migration ready

The cache prevents assessment spam while allowing timely updates. Assessments are immutable once computed — the `assessedAt` timestamp and checkpoint record this for audit.

### Database Models

Four new Prisma models support the assessment:

**ContractSuccessorFindingAcknowledgement**
- Stores operator acknowledgements with TTL
- Indexed by (findingKey, expiresAt) for efficient expiry queries
- Automatically cleaned up by retention jobs

**ContractSuccessorMigrationCheckpoint**
- Immutable record of passed/failed validation gates
- Indexed by (network, contractId, observedLedger) for monotonicity verification
- Supports audit trail and recovery scenarios

**ContractSuccessorReadinessCache**
- Latest assessment verdict and findings
- Indexed by status and timestamp for queries
- Used for historical review and trend analysis

**ContractVersion**
- Contract identity versioning
- Tracks schemaVersion per (network, contractId)
- Supports compatibility matrix queries

### Privacy and Security

The assessment is designed to never expose secrets:
- **No connection strings**: DSNs are never included in findings
- **No addresses**: IP addresses, wallet addresses, or other identifying data are filtered
- **No raw errors**: All errors are mapped to deterministic status codes
- **No credentials**: API keys, tokens, or other secrets are never exposed

All findings use only:
- Safe observable values (e.g., observed schema version as a string)
- Deterministic status codes
- Non-identifying descriptions

### Authorization and Audit

All operations require `ORG_ADMIN` API key scope:
- Assessment endpoints verify scope via `ScopesGuard`
- Acknowledgements are recorded with `actorId` from the authenticated principal
- All state changes are logged to the audit trail via `AuditLog`

## Health Check Integration

The successor readiness is integrated into the health diagnostics as an OPTIONAL dependency:

```
GET /health/diagnostics
```

The response includes a `contract_successor_readiness` probe:

```json
{
  "name": "contract_successor_readiness",
  "kind": "optional",
  "status": "ok",
  "durationMs": 125
}
```

- Status is `ok` when successor is ready for migration
- Status is `degraded` when blocking findings exist
- Status is `disabled` when successor service is not available
- Status is `not_configured` when successor contract ID is not configured

This allows operators to monitor successor readiness alongside other dependencies.

## Workflow Example: Planned Contract Upgrade

### 1. Configure the Successor

Update configuration with new contract ID and schema version:

```env
STELLAR_NETWORK=testnet
CONTRACT_ANCHORING_PROOF_REGISTRY_CONTRACT_ID=CNEW00000000000000000000000000000000000000000000000000SC4
CONTRACT_ANCHORING_SCHEMA_VERSION=2
```

### 2. Check Readiness

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://api.example.com/contracts/testnet/CNEW00000000000000000000000000000000000000000000000000SC4/successor/readiness"
```

Assessment detects schema version mismatch (expected).

### 3. Acknowledge the Expected Mismatch

```bash
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "note": "Planned v2 schema upgrade; mismatch expected during deployment",
    "ttlSeconds": 604800
  }' \
  "https://api.example.com/contracts/testnet/CNEW00000000000000000000000000000000000000000000000000SC4/successor/findings/schema_version_mismatch/acknowledge"
```

### 4. Verify Readiness

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://api.example.com/contracts/testnet/CNEW00000000000000000000000000000000000000000000000000SC4/successor/can-migrate"
```

Response: `{"canMigrate": true}`

### 5. Proceed with Migration

Migrate traffic to the successor contract. The acknowledgement will expire in 7 days (or whenever the operator withdraws it).

## Monitoring and Troubleshooting

### Check Successor Health via Diagnostics

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://api.example.com/health/diagnostics" | jq '.dependencies[] | select(.name == "contract_successor_readiness")'
```

### Inspect Recent Assessments

Query the `ContractSuccessorReadinessCache` to see the latest assessment:

```sql
SELECT * FROM "ContractSuccessorReadinessCache"
WHERE network = 'testnet'
AND "contractId" = 'CNEW...'
ORDER BY "updatedAt" DESC
LIMIT 1;
```

### Review Acknowledgements

```sql
SELECT "findingKey", "acknowledgedBy", "note", "expiresAt", "createdAt"
FROM "ContractSuccessorFindingAcknowledgement"
WHERE "findingKey" LIKE 'testnet:CNEW%'
ORDER BY "createdAt" DESC;
```

### Inspect Checkpoints

```sql
SELECT "network", "contractId", "passedGates", "failedGates", "observedLedger", "createdAt"
FROM "ContractSuccessorMigrationCheckpoint"
WHERE network = 'testnet'
AND "contractId" = 'CNEW...'
ORDER BY "createdAt" DESC
LIMIT 10;
```

## Configuration

The following configuration options control assessment behavior:

| Key | Default | Description |
|-----|---------|-------------|
| `health.cacheTtlMs` | 5000 | Cache TTL for readiness assessments (ms) |
| `health.probeTimeoutMs` | 2000 | Timeout for individual checks (ms) |
| `stellar.network` | `testnet` | The network to check |
| `contractAnchoring.proofRegistryContractId` | (none) | Expected successor contract ID |
| `contractAnchoring.schemaVersion` | 1 | Expected schema version |
| `contractAnchoring.enabled` | false | Whether anchoring is enabled |

## Security Considerations

### Replay Protection

The assessment uses ledger sequence numbers (`observedLedger`) to prevent replay attacks:
- Each checkpoint records the observed ledger when validation passed
- Later assessments verify monotonicity (ledger sequence always advances)
- Replayed/reordered ledger entries are detected and flagged

### TTL-Bounded Acknowledgements

Acknowledgements expire after a bounded time (max 7 days):
- Operators must refresh acknowledgements for long-running migrations
- Expired acknowledgements are automatically purged by retention jobs
- This prevents "set and forget" acknowledgements from masking ongoing issues

### Authorization Scoping

All endpoints require `ORG_ADMIN` scope:
- Assessment endpoints are restricted to authorized operators
- Acknowledgement endpoints audit who made the change (via `actorId`)
- Health diagnostics require the same scope as other sensitive probes

## Related Documentation

- [Health Checks](./health-checks.md) — Overview of health check system
- [Contract Drift](./api-key-security.md) — Contract configuration drift detection
- [Governance](../adr/0006-outbox-anchoring.md) — Contract governance and proposals
- [Database Migrations](./database-migrations.md) — Schema migration patterns
- [Audit Events](./audit-events.md) — Audit trail and compliance logging

## Future Enhancements

Potential future improvements:

1. **Live Contract State Verification**: Query live contract state via Stellar RPC when available
2. **Governance Integration**: Integrate with governance proposals for automated activation
3. **Metrics and Alerting**: Export readiness metrics to observability systems
4. **Gradual Rollout**: Support canary deployments with percentage-based traffic splits
5. **Rollback Automation**: Automatic rollback if successor becomes unhealthy
