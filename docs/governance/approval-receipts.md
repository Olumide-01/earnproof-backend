# Signed Governance Approval Intent Receipts

## Overview

A **signed governance approval intent receipt** is a cryptographically signed attestation binding an approval decision to the exact proposal, contract, network, role, and payload hash. Receipts provide:

- **Verifiable audit trail**: Approvers have a canonical record of their decisions
- **Off-chain attestation**: Receipts can be verified without on-chain state
- **Replay prevention**: Domain separation and outcome binding prevent misuse
- **Key rotation support**: Verification keys are published with explicit expiry for staged rotation

## Receipt Structure

### Receipt Data (Version 1)

```typescript
interface ApprovalIntentReceiptV1 {
  // Type and version for domain separation
  type: "approval-intent-receipt";
  schemaVersion: "v1";
  
  // Binding identifiers: must match the approval and proposal exactly
  approvalId: string;          // Unique approval ID
  proposalId: string;          // On-chain proposal ID
  contractId: string;          // On-chain contract ID
  network: string;             // On-chain network identifier
  
  // Approver context
  role: string;                // Approver role (e.g., "ADMIN")
  actionType: string;          // Operation type
  
  // Payload commitment
  payloadHash: string;         // Canonical hash of proposal payload
  
  // Decision metadata
  decision: "APPROVED" | "REJECTED";
  reason?: string;             // Optional decision reason
  
  // Timestamps (UTC, ISO-8601)
  decidedAt: string;           // When approval decision was recorded
  expiresAt?: string;          // Optional proposal expiry
}
```

### Receipt Response

The API returns a signed receipt with the canonical data, signature, and key information:

```json
{
  "id": "receipt-abc123",
  "schemaVersion": "v1",
  "receiptData": {
    "type": "approval-intent-receipt",
    "schemaVersion": "v1",
    "approvalId": "req-123",
    "proposalId": "prop-456",
    "contractId": "contract-xyz",
    "network": "public",
    "role": "ADMIN",
    "actionType": "organization.residency_policy.override",
    "payloadHash": "sha256:abc123...",
    "decision": "APPROVED",
    "reason": "Security audit required",
    "decidedAt": "2026-10-18T12:00:00Z"
  },
  "receiptHash": "sha256:def456...",
  "signingKeyId": "earnproof-v0",
  "signature": "ed25519:xyz789...",
  "credentialHash": "sha256:ghi012...",
  "issuedAt": "2026-10-18T12:00:00Z",
  "createdAt": "2026-10-18T12:00:01Z"
}
```

## API Endpoints

### Issue Receipt

**POST /governance/approval-receipts/approvals/{approvalId}/receipts**

Issues a signed receipt for an approved approval. Idempotent: calling multiple times returns the same receipt.

**Requirements:**
- Approval must exist and be in `APPROVED` status
- Proposal must exist and not be in a terminal state (EXECUTED, CANCELLED, EXPIRED)
- Caller must be authenticated (bearer token)

**Response:** `ApprovalIntentReceiptResponseDto` (200 OK)

**Errors:**
- `404 APPROVAL_NOT_FOUND`: Approval does not exist
- `409 APPROVAL_NOT_CONFIRMED`: Approval is not in APPROVED state
- `409 PROPOSAL_TERMINAL`: Proposal is in terminal state
- `409 STALE_PROPOSAL_STATE`: Proposal state changed since approval

### Retrieve Receipt

**GET /governance/approval-receipts/receipts/{receiptId}**

Retrieve a signed receipt by ID. Only the approver, related users, or admins may retrieve.

**Requirements:**
- Receipt must exist
- Caller must be authenticated (bearer token)
- Caller must be the approver or an admin

**Response:** `ApprovalIntentReceiptResponseDto` (200 OK)

**Errors:**
- `404 NOT_FOUND`: Receipt does not exist
- `403 FORBIDDEN`: Unauthorized

### Retrieve Receipt by Approval ID

**GET /governance/approval-receipts/approvals/{approvalId}**

Convenience endpoint to retrieve receipt by approval ID. Same authorization as above.

**Response:** `ApprovalIntentReceiptResponseDto` (200 OK)

**Errors:**
- `400 BAD_REQUEST`: No receipt issued for this approval yet
- `403 FORBIDDEN`: Unauthorized

### Verify Receipt

**POST /governance/approval-receipts/receipts/{receiptId}/verify**

Verify the signature of a receipt. No authentication required (public endpoint).

**Response:** 
```json
{
  "valid": true,
  "receiptData": { ... }
}
```

**Errors:**
- `404 NOT_FOUND`: Receipt does not exist
- `400 UNKNOWN_SCHEMA`: Unsupported receipt schema version
- `400 KEY_UNAVAILABLE`: Signing key is no longer available
- `400 SIGNATURE_INVALID`: Signature verification failed

### Publish Verification Keys

**GET /governance/approval-receipts/keys**

Publish verification keys in JWK Set format. No authentication required (public endpoint).

Supports cache efficiency via ETag. If `If-None-Match` header matches current ETag, returns `304 Not Modified`.

**Response:** 
```json
{
  "keys": [
    {
      "alg": "EdDSA",
      "crv": "Ed25519",
      "kid": "earnproof-v0",
      "kty": "OKP",
      "use": "sig",
      "status": "active",
      "x": "<base64url-public-key>"
    },
    {
      "alg": "EdDSA",
      "crv": "Ed25519",
      "kid": "earnproof-v0-retired",
      "kty": "OKP",
      "use": "sig",
      "status": "retired",
      "expiresAt": "2026-11-18T00:00:00Z",
      "x": "<base64url-public-key>"
    }
  ]
}
```

## Security Considerations

### Replay Prevention

1. **Domain Separation**: Receipt type is hardcoded as `"approval-intent-receipt"`. Cannot be deserialized as a proof, credential, or other message type.

2. **Outcome Binding**: The decision (APPROVED/REJECTED) is embedded in the signed payload. Cannot repurpose an APPROVED receipt as a REJECTED receipt.

3. **Temporal Binding**: Receipt is bound to a specific approval ID and timestamp. Retries with identical payload return the same receipt (idempotency key).

### Secret Leakage Prevention

- Receipts contain only non-secret, public identifiers (approval ID, proposal ID, network, role)
- No signing keys or private material included
- Proposer addresses and payloads are already public (observed on-chain)

### Execution Implication Prevention

- Receipt attests to an **approval decision**, not execution completion
- Separate execution lease and completion semantics exist in `ApprovalRequest`
- Receipt schema does not include execution status or ledger proof
- API documentation explicitly states purpose as decision attestation only

## Key Rotation

Signing keys are versioned using the pattern `earnproof-v{version}`. Key rotation workflow:

1. **New Key**: Add new signing key to configuration (`CREDENTIAL_SIGNING_SECRET_V1`)
2. **Active Key**: Update active version (`CREDENTIAL_SIGNING_KEY_VERSION=1`)
3. **Staged Retirement**: Old key becomes verify-only with optional `VERIFY_UNTIL` deadline
4. **Publication**: Keys endpoint returns both active and non-expired retired keys
5. **Expiry**: After deadline passes, old key is no longer usable for verification

## Versioning and Migration

### Forward Compatibility

- Receipt schema version is explicit (`schemaVersion: "v1"`)
- Verification service checks version before parsing
- New fields added additively (existing verifiers ignore unknown fields per JSON spec)

### Migration Example (v1 → v2)

1. Deploy v2-capable verification logic alongside v1 support
2. Update signing to emit v2 receipts for new approvals
3. Verification accepts both v1 and v2
4. No migration of existing v1 receipts (backward compatible)

## Error Taxonomy

| Error Code | HTTP Status | Scenario |
|------------|-------------|----------|
| `APPROVAL_NOT_FOUND` | 404 | Approval ID does not exist |
| `APPROVAL_NOT_CONFIRMED` | 409 | Approval not in APPROVED state |
| `PROPOSAL_TERMINAL` | 409 | Proposal in EXECUTED, CANCELLED, or EXPIRED state |
| `STALE_PROPOSAL_STATE` | 409 | Proposal state changed since approval |
| `FORBIDDEN` | 403 | Unauthorized to access receipt |
| `SIGNATURE_INVALID` | 400 | Cryptographic proof did not verify |
| `KEY_UNAVAILABLE` | 400 | Signing key not available or expired |
| `UNKNOWN_SCHEMA` | 400 | Unsupported receipt schema version |
| `CANONICAL_ENCODING_ERROR` | 400 | Receipt data cannot be serialized |

## Examples

### Issue and Retrieve Receipt

```bash
# 1. Issue receipt for approval
curl -X POST \
  https://api.example.com/governance/approval-receipts/approvals/req-123/receipts \
  -H "Authorization: Bearer $TOKEN"

# 2. Retrieve the receipt
curl -X GET \
  https://api.example.com/governance/approval-receipts/receipts/receipt-abc123 \
  -H "Authorization: Bearer $TOKEN"

# 3. Verify signature (no auth required)
curl -X POST \
  https://api.example.com/governance/approval-receipts/receipts/receipt-abc123/verify
```

### Get Verification Keys

```bash
# Fetch keys with caching support
curl -X GET \
  -H "If-None-Match: \"etag123\"" \
  https://api.example.com/governance/approval-receipts/keys
```

## References

- [EdDSA Signature Algorithm (RFC 8037)](https://tools.ietf.org/html/rfc8037)
- [JSON Web Key (JWK) Format (RFC 7517)](https://tools.ietf.org/html/rfc7517)
- [Canonical JSON Serialization](https://tools.ietf.org/html/draft-staykov-hu-json-canonical-form-00)
