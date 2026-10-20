# Implementation Summary: Issue #334 - Bounded Offline Verification Bundles

**Issue:** #334 - Issue bounded offline verification bundles

**Status:** ✅ Complete

**Date:** October 15, 2026

---

## Overview

Implemented bounded offline verification bundles: time-limited, signed JSON packages enabling offline proof verification with explicit freshness and expiry constraints.

## Files Changed

### DTOs (2 files)
- `src/proofs/dto/create-offline-bundle.dto.ts` — Input request DTO with validation
- `src/proofs/dto/offline-bundle.dto.ts` — Response DTOs (bundle, manifest, scope, contents, keys, checkpoints)

### Service & Controller (2 files)
- `src/proofs/offline-bundle.service.ts` — Core service: generate, verify, validate, signing/verification logic
- `src/proofs/offline-bundles.controller.ts` — POST /api/v1/proofs/bundles endpoint with authorization

### Tests (1 file)
- `src/proofs/offline-bundle.service.spec.ts` — 30+ test cases (positive, negative, boundary, authorization, tamper detection, regression)

### Persistence (1 file)
- `prisma/schema.prisma` — OfflineBundle model + ApiKeyScope.BUNDLES_CREATE enum

### API (1 file)
- `src/common/dto/api-error.dto.ts` — 12 new error codes (BUNDLE_*)

### Documentation (1 file)
- `docs/offline-verification-bundles.md` — Bundle format, API, signing, verification, boundaries, authorization, errors

**Total:** 8 files changed

---

## Key Implementation Details

### Bundle Format
- **Version:** `"earnproof.offline-bundle.v1"` (versioned for evolution)
- **Manifest:** Lists scope, expiry, freshness limit, issuer, signed with HMAC-SHA256
- **Contents:** Credentials (allowlist), verification keys, checkpoints (allowlist)
- **Signature:** `hmac-sha256:v{VERSION}={HEX}` (versioned for key rotation)
- **Idempotency:** Unique (organizationId, bundleId) database constraint

### Signing & Verification
- **Algorithm:** HMAC-SHA256 (existing `CredentialSigningKeyringService`)
- **Canonicalization:** Deterministic JSON (existing `canonicalize.ts`)
- **Key Versioning:** Active/verify-only/retired states (key rotation support)
- **Fail-Closed:** All verification failures reject bundle

### Expiry & Freshness Boundaries
- **Bundle Expiry:** `now >= expiresAt` → expired (inclusive boundary, tested)
- **Checkpoint Freshness:** `age > maxFreshnessSeconds` → stale (exclusive on limit, tested)
- **Verification:** Both checked by verifier; fail-closed on boundary violations

### Authorization
- **Scope:** `BUNDLES_CREATE` API key scope required
- **Proof Access:** Caller can only include proofs they own (403 if violated)
- **Field Allowlist:** Only authorized fields included (privacy-preserving)
- **Exclusive Fields:** No private keys, secrets, PII, raw addresses

### Error Handling
- 12 new error codes in `ApiErrorCode` enum
- Fail-closed design: unknown versions, tampered bundles, expired/stale rejected
- Structured errors: code, message, requestId

### Test Coverage
- **Positive:** Valid bundle generation, multiple proofs, keys/checkpoints included
- **Authorization:** Proof access, organization isolation, inaccessible proofs (403)
- **Validation:** Expiry in past, too far, freshness out of bounds, all rejected
- **Boundary:** Expiry at 1-hour limit, freshness at 60–86400s boundaries
- **Expiry Boundary:** Bundle at exact expiry instant rejected (inclusive)
- **Freshness Boundary:** Checkpoint at exact limit accepted, +1s rejected
- **Tamper Detection:** Invalid signature, hash mismatch, malformed signature
- **Version Handling:** Unknown bundle version, unknown signature version
- **Regression:** No secrets/private keys leak into serialized bundle

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **HMAC-SHA256 Signing** | Reuses existing credential signing keyring, versioned for key rotation |
| **Canonical JSON** | Deterministic hashing via existing `canonicalize.ts` pattern |
| **Allowlist for Scope** | Privacy-preserving, explicit about included fields, fail-closed on out-of-scope |
| **Expiry Boundary: Inclusive** | `now >= expiresAt` → expired; simpler for verifiers, standard semantics |
| **Freshness: Age-Based** | `age > limit` → stale; checkpoints carry their own timestamps |
| **No Encryption MVP** | Signing provides integrity; encryption optional future enhancement |
| **Versioned Bundles** | Enables schema evolution without breaking verifiers |
| **Database Persistence** | Audit trail + idempotency via (organizationId, bundleId) unique constraint |
| **Stateless Generation** | Each request generates deterministic bundle; no external state needed |

---

## API Contract

**Endpoint:** `POST /api/v1/proofs/bundles`

**Request (201 Created):**
```json
{
  "proofIds": ["proof_1"],
  "expiresAt": "2025-10-15T15:30:00.000Z",
  "maxFreshnessSeconds": 1800,
  "operations": ["verify"],
  "acknowledgeOfflineRisk": true
}
```

**Validation:**
- `expiresAt`: Future, within 1 hour
- `maxFreshnessSeconds`: 60–86400 seconds
- `proofIds`: 1–100, caller must own all
- Errors: 400 (bad input), 403 (not accessible), 422 (generation failed)

**Response (201):**
```json
{
  "version": "earnproof.offline-bundle.v1",
  "bundleId": "obb_abc123...",
  "manifest": {...},
  "contents": {...},
  "generatedAt": "2025-10-15T14:30:00.000Z"
}
```

---

## Verification (Offline)

Verifiers must:
1. Check bundle version is known
2. Extract and verify signature version exists
3. Re-canonicalize and HMAC-verify manifest
4. Recompute and verify contents hash
5. Check `now < expiresAt` (bundle not expired)
6. Check checkpoint ages <= `maxFreshnessSeconds`
7. Verify credential expiry

All fail-closed.

---

## Persistence & Idempotency

**Table:** `OfflineBundle`

**Key Fields:**
- `bundleId`, `organizationId`, `requestingApiKeyId` (audit)
- `scope`, `signature`, `contentsHash`, `contents`
- `issuedAt`, `expiresAt`, `maxFreshnessSeconds`
- `revokedAt`, `revocationReason` (optional, future)

**Unique Constraint:** `(organizationId, bundleId)` enforces idempotency

---

## Backward Compatibility

- ✅ New feature, no breaking changes to existing APIs
- ✅ New endpoint: `/api/v1/proofs/bundles`
- ✅ New scope: `BUNDLES_CREATE`
- ✅ New error codes (additive to `ApiErrorCode` enum)
- ✅ New Prisma model (no migrations to existing tables)

---

## Open Items & Future Enhancements

1. **Encryption at Rest:** Optional AES-256-GCM encryption for sensitive bundles (future)
2. **Revocation Support:** Bundle-level revocation if proof is revoked (database support added, logic TBD)
3. **Cross-Chain Checkpoints:** Real implementation joins checkpoints to proofs (MVP simplified)
4. **Concurrency Testing:** Load test with concurrent bundle requests to verify idempotency
5. **Performance Optimization:** Index tuning on `(organizationId, expiresAt)` for cleanup queries

---

## Verification Checklist

- ✅ DTOs created with validation decorators
- ✅ Prisma model with idempotency constraint
- ✅ Service: generate, verify, validate logic
- ✅ Controller: POST endpoint with authorization guards
- ✅ Error codes: 12 new codes added
- ✅ Tests: 30+ test cases (positive, negative, boundary, auth, tamper, regression)
- ✅ Documentation: Bundle format, API, signing, boundaries, verification
- ✅ Code style: Follows existing codebase patterns (DTO validation, service injection, error handling)
- ✅ No secrets/private keys in bundle
- ✅ Boundary tests with exact expiry/freshness limits

---

## Files to Review

1. **Service Logic:** `src/proofs/offline-bundle.service.ts`
   - Key signing/verification logic
   - Expiry/freshness boundary checks (inclusive/exclusive)
   - Allowlist enforcement

2. **Controller:** `src/proofs/offline-bundles.controller.ts`
   - Authorization guards
   - Error responses
   - Request/response documentation

3. **Tests:** `src/proofs/offline-bundle.service.spec.ts`
   - Boundary test cases (exact expiry instant, freshness limit)
   - Tamper detection (invalid sig, hash mismatch)
   - Authorization (inaccessible proofs)
   - Regression (no secrets leaked)

4. **Documentation:** `docs/offline-verification-bundles.md`
   - Bundle format schema
   - Verification steps
   - Error codes and meanings
