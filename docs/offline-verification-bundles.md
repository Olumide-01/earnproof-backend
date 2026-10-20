# Offline Verification Bundles

**Issue:** #334

## Overview

Bounded offline verification bundles enable time-limited, offline verification of proofs with explicit freshness and expiry constraints. A bundle is a signed JSON package containing authorized credentials, verification keys, and revocation checkpoints.

**Guarantees:**
- **Integrity:** HMAC-SHA256 signed (versioned for key rotation)
- **Scope:** Allowlist-based; only authorized fields included
- **Expiry:** Bundle invalid if `now >= expiresAt` (inclusive boundary)
- **Freshness:** Checkpoints stale if age > `maxFreshnessSeconds`
- **Privacy:** No private keys, secrets, PII, or raw wallet addresses
- **Idempotency:** Same request → same bundleId

## Bundle Format

```json
{
  "version": "earnproof.offline-bundle.v1",
  "bundleId": "obb_abc123...",
  "manifest": {
    "bundleId": "obb_abc123...",
    "issuedAt": "2025-10-15T14:30:00.000Z",
    "expiresAt": "2025-10-15T15:00:00.000Z",
    "maxFreshnessSeconds": 1800,
    "issuer": "earnproof",
    "scope": {
      "proofIds": ["proof_1"],
      "operations": ["verify"],
      "organizationId": "org_xyz"
    },
    "contentsHash": "sha256:...",
    "signature": "hmac-sha256:v1=..."
  },
  "contents": {
    "credentials": [...],
    "verificationKeys": [...],
    "checkpoints": [...]
  },
  "generatedAt": "2025-10-15T14:30:00.000Z"
}
```

## API Endpoint

**POST /api/v1/proofs/bundles**

**Authorization:** API key with `BUNDLES_CREATE` scope

**Request:**
```json
{
  "proofIds": ["proof_1", "proof_2"],
  "expiresAt": "2025-10-15T15:30:00.000Z",
  "maxFreshnessSeconds": 1800,
  "operations": ["verify"],
  "acknowledgeOfflineRisk": true
}
```

**Validation:**
- `expiresAt`: Must be future and within 1 hour from now
- `maxFreshnessSeconds`: 60–86400 seconds
- `proofIds`: 1–100 items, caller must own all
- `operations`: At least one of ["verify", "audit"]

**Errors:**
- 400: Invalid request (expiry, freshness out of bounds)
- 403: Proof not accessible
- 422: Generation failed

## Verification

Verifiers (offline) must check:

1. Bundle version is known
2. Signature version exists and is usable
3. HMAC signature valid
4. Contents hash valid
5. Bundle not expired: `now < expiresAt`
6. Checkpoints not stale: `age <= maxFreshnessSeconds`
7. Credentials not expired

All checks fail-closed.

## Expiry and Freshness Boundaries

- **Bundle expiry:** `now >= expiresAt` → expired (inclusive)
- **Checkpoint freshness:** `age > maxFreshnessSeconds` → stale (exclusive on limit)
  - At exactly `maxFreshnessSeconds`, checkpoint is current
  - At `maxFreshnessSeconds + 1s`, checkpoint is stale

## Signing

- **Algorithm:** HMAC-SHA256 (versioned via credential signing keyring)
- **Manifest:** Canonicalized JSON (sorted keys)
- **Signature Format:** `hmac-sha256:v{VERSION}={HEX}`
- **Key Versioning:** Active/verify-only/retired states for rotation

## Scope and Authorization

**Who can request:** API keys with `BUNDLES_CREATE` scope, for proofs in their organization

**Included fields (allowlist):**
- Credentials: id, type, schemaVersion, issuer, subject.walletHash, claim, privacy, issuedAt, expiresAt, proof
- Keys: keyId, type, algorithm, publicKey (JWK), version, validFrom, validUntil
- Checkpoints: proofId, version, observedAt, status, revocationHash, contractAddress, txnHash

**Excluded fields (never):**
- Private keys, secrets, raw wallet addresses, PII, internal IDs

## Persistence

**Table:** OfflineBundle

**Idempotency:** Unique constraint on (organizationId, bundleId) ensures same request → same bundle

**Audit:** API key ID logged with each bundle generation

## Error Codes

- `BUNDLE_EXPIRY_IN_PAST` — expiresAt is past
- `BUNDLE_EXPIRY_TOO_FAR` — expiresAt > 1 hour away
- `BUNDLE_FRESHNESS_EXCEEDS_POLICY` — maxFreshnessSeconds out of range
- `BUNDLE_SCOPE_AUTHORIZATION_FAILED` — Proof not accessible
- `BUNDLE_EXPIRED` — now >= expiresAt (verifier-side)
- `BUNDLE_CHECKPOINT_STALE` — Checkpoint age exceeds limit (verifier-side)
- `BUNDLE_TAMPERED` — Signature or hash mismatch
- `BUNDLE_UNKNOWN_VERSION` — Unknown bundle version
- `BUNDLE_UNKNOWN_SIGNATURE_VERSION` — Signing key version unknown/retired
