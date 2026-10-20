# Sign and Validate Cursor Pagination Tokens

## Issue
#326: Deliver signed and validated cursor pagination tokens as focused production-readiness work without expanding beyond the documented scope.

## Summary

This PR implements tamper-proof, time-bound cursor pagination tokens for mutable list endpoints. Cursors are protected against tampering, expiry attacks, cross-filter pagination, and cross-tenant data leaks through:

- **HMAC-SHA256 signatures** for integrity verification
- **Expiry timestamps** (15-minute default TTL)
- **Filter binding** to prevent using cursors across different filter sets
- **Tenant binding** to prevent cross-tenant data access
- **Versioned key rotation** with staged key management

## Changes

### Core Implementation (8 new files)

1. **`src/common/pagination/signed-cursor.types.ts`**
   - `SignedCursorEnvelope`: Signed envelope structure
   - `SignedCursorPayload`: Validated payload returned to services
   - `SignedCursorFailureReason`: Stable error reasons (no data leaks)
   - Signing/verification parameter types

2. **`src/common/pagination/signed-cursor.service.ts`**
   - Signs cursor tokens with HMAC-SHA256
   - Validates tokens with comprehensive security checks:
     - Expiry validation
     - Tenant ID binding verification
     - Filter ID binding verification
     - Signature verification with constant-time comparison
   - Never throws on validation failures (returns typed results)
   - ~200 lines, fully tested

3. **`src/common/pagination/signed-cursor-keyring.service.ts`**
   - Manages versioned signing keys (similar to CredentialSigningKeyringService)
   - Loads keys from config: `CURSOR_SIGNING_SECRET_V{n}`
   - Supports key rotation with `CURSOR_SIGNING_KEY_VERSION` and verify-until deadlines
   - Backward compatible with legacy `CURSOR_SIGNING_SECRET`

4. **`src/common/pagination/signed-cursor.dto.ts`**
   - `SignedCursorPaginationQueryDto`: Standard query DTO (limit, cursor)
   - `PaginationPageInfo`: Response metadata (hasMore, nextCursor)
   - `PaginatedListResponse<T>`: Generic paginated response type

5. **`src/common/pagination/filter-id.ts`**
   - Computes deterministic SHA-256 hashes of filter parameters
   - Binds cursors to specific filter contexts (status, category, etc.)
   - Prevents cross-filter pagination with normalized JSON

6. **`src/common/pagination/pagination.module.ts`**
   - NestJS module exporting signed cursor services
   - Imported globally in CommonModule

7. **`src/common/pagination/signed-cursor.service.spec.ts`** (~600 lines)
   - 20+ unit tests covering all scenarios:
     - ✓ Positive: Valid tokens, custom TTL, envelope structure
     - ✓ Negative: Malformed, expired, missing fields
     - ✓ Security: Cross-tenant protection, cross-filter protection, tampering detection
     - ✓ Boundary: Expiry boundary, special characters in IDs
     - ✓ Consistency: Round-trip, deterministic encoding

8. **`src/common/pagination/signed-cursor-keyring.service.spec.ts`** (~400 lines)
   - 15+ unit tests for key rotation:
     - ✓ Key loading and sequencing
     - ✓ Legacy secret compatibility
     - ✓ Active version management
     - ✓ Verification deadline enforcement
     - ✓ Sorted version listing

### Endpoint Migrations (3 modified files)

1. **`src/disputes/disputes.service.ts`**
   - Inject `SignedCursorService`
   - `listDisputes` now:
     - Computes filter ID from: `status`, `category`, `assignedTo`
     - Validates incoming cursor with tenant/filter binding
     - Signs outgoing cursor for next page
     - Returns stable error on cursor validation failure

2. **`src/proofs/proofs.service.ts`**
   - Inject `SignedCursorService`
   - `listProofs` now:
     - Computes filter ID from: `type`, `status`, `assetCode`, `issuedFrom`, `issuedTo`
     - Validates incoming cursor with tenant/filter binding
     - Signs outgoing cursor for next page
     - Returns stable error on cursor validation failure

3. **`src/proofs/dto/list-proofs.dto.ts`**
   - Add cursor field validation: base64url format check

### Integration (1 modified file)

1. **`src/common/common.module.ts`**
   - Import `PaginationModule`
   - Export services globally (available to all modules)

## Security Properties

### Tamper Protection
- Cursor modified → signature validation fails
- Attempt to skip items → cursorId invalid, Prisma query fails
- Attempt to seek backward → would require valid older cursor

### Expiry Protection
- Tokens expire after 15 minutes (configurable per request)
- Expired tokens rejected before any data access
- Clock skew tolerance: None (explicit exact-match validation)

### Cross-Filter Protection
- Filter parameters (status, category, etc.) hashed into cursor
- Using cursor with different filters detected and rejected
- Prevents pagination state from leaking across filter contexts

### Cross-Tenant Protection
- Tenant ID (organizationId for disputes, userId for proofs) embedded
- Mismatched tenant IDs detected and rejected before data access
- Prevents organization A from using organization B's cursor

### Timing Safety
- Signature comparison uses constant-time HMAC
- All validation paths deterministic (no conditional behavior)
- Error messages stable (no internal state leaked)

### Key Rotation
- Versioned keys support staged rotation
- Old keys can verify during transition period
- `CURSOR_SIGNING_SECRET_V{n}_VERIFY_UNTIL` deadline controls phase-out
- Active version always usable (no artificial deadline)

## Error Handling

All cursor validation failures return deterministic, stable error reasons:

```typescript
enum SignedCursorFailureReason {
  MALFORMED = "MALFORMED",              // Decoding/parsing failed
  UNSUPPORTED_VERSION = "UNSUPPORTED_VERSION",  // Version not "1"
  SIGNATURE_INVALID = "SIGNATURE_INVALID",    // Tampering detected
  EXPIRED = "EXPIRED",                  // TTL exceeded
  FILTER_MISMATCH = "FILTER_MISMATCH",       // Different filters
  TENANT_MISMATCH = "TENANT_MISMATCH",       // Different tenant
  MISSING_FIELDS = "MISSING_FIELDS",         // Required fields missing
}
```

No exceptions thrown. No data leaks through error messages.

## Testing

### Unit Tests (1,000+ lines)
- SignedCursorService: 20+ tests
- SignedCursorKeyringService: 15+ tests
- All scenarios covered: positive, negative, security, boundary, consistency

### Test Coverage
- Sign/verify round-trip ✓
- Expiry validation ✓
- Cross-tenant detection ✓
- Cross-filter detection ✓
- Tampering detection (cursor ID, filter ID, signature) ✓
- Key loading and rotation ✓
- Deterministic encoding ✓

### Manual Testing
```bash
# Get first page
curl https://api.example.com/disputes?limit=10

# Use returned cursor for next page
curl "https://api.example.com/disputes?limit=10&cursor=<nextCursor>"

# Attempt cross-filter pagination
curl "https://api.example.com/disputes?limit=10&cursor=<nextCursor>&status=RESOLVED"
# Result: 400 Bad Request "Invalid pagination cursor: FILTER_MISMATCH"
```

## Backward Compatibility

- Existing unsigned cursor endpoints NOT changed (only disputes and proofs list updated)
- Services can opt-in to signed cursors on new endpoints
- Legacy `CURSOR_SIGNING_SECRET` env var still supported (version 0)
- Key rotation workflow same as CredentialSigningKeyringService

## Configuration

### Minimal (Development)
```bash
CURSOR_SIGNING_SECRET=dev-secret-key-here
CURSOR_SIGNING_KEY_VERSION=0
```

### Production (Key Rotation)
```bash
# Current active key
CURSOR_SIGNING_SECRET_V2=<production-secret-v2>
CURSOR_SIGNING_KEY_VERSION=2

# Old key (verify-only, expires 2024-12-31)
CURSOR_SIGNING_SECRET_V1=<production-secret-v1>
CURSOR_SIGNING_SECRET_V1_VERIFY_UNTIL=2024-12-31T23:59:59Z

# Oldest key (retired, no longer loaded)
```

## Files Added

```
src/common/pagination/
├── signed-cursor.types.ts              (Types and interfaces)
├── signed-cursor.service.ts            (Core signing/validation)
├── signed-cursor-keyring.service.ts    (Key rotation)
├── signed-cursor.dto.ts                (DTO types)
├── filter-id.ts                        (Filter hashing utility)
├── pagination.module.ts                (NestJS module)
├── signed-cursor.service.spec.ts       (600 lines of tests)
└── signed-cursor-keyring.service.spec.ts (400 lines of tests)
```

## Files Modified

```
src/common/common.module.ts             (Import PaginationModule)
src/disputes/disputes.service.ts        (Inject SignedCursorService, update listDisputes)
src/proofs/proofs.service.ts            (Inject SignedCursorService, update listProofs)
src/proofs/dto/list-proofs.dto.ts       (Add cursor validation)
```

## Documentation

- `SIGNED_CURSOR_IMPLEMENTATION.md`: Comprehensive implementation guide
  - Architecture overview
  - Security model
  - Configuration
  - Key rotation workflow
  - Migration guide for future endpoints

## Acceptance Criteria ✓

- [x] Tampered cursors fail with stable errors (SIGNATURE_INVALID)
- [x] Expired cursors fail with stable errors (EXPIRED)
- [x] Cross-filter cursors fail with stable errors (FILTER_MISMATCH)
- [x] Cross-tenant cursors fail with stable errors (TENANT_MISMATCH)
- [x] Failure behavior is deterministic (no exceptions, typed results)
- [x] Exact boundary behavior documented (TTL check, filter hash)
- [x] Focused tests cover all scenarios (positive, negative, security, boundary)
- [x] Test requirements met:
  - [x] Positive cases (valid tokens, round-trip)
  - [x] Negative cases (malformed, expired, tampered)
  - [x] Authorization cases (cross-tenant, cross-filter)
  - [x] Concurrency cases (key rotation)
  - [x] Boundary cases (expiry timing)
  - [x] Regression cases (all failure reasons)

## Deployment

1. Merge to main
2. Configure `CURSOR_SIGNING_SECRET` or versioned keys in production
3. Deploy (no migration scripts needed, backward compatible)
4. Monitor cursor validation failures (should be minimal)
5. Optionally add signed cursors to other endpoints following migration pattern

## Related Issues

- #326: Sign and validate cursor pagination tokens (this issue)

## Commit History

Each commit is focused and reviewable:
1. Add signed cursor types and interfaces
2. Add signed cursor keyring service
3. Add signed cursor signing/validation service
4. Add pagination module and DTOs
5. Add comprehensive unit tests for signed cursor service
6. Add unit tests for signed cursor keyring
7. Migrate disputes service to signed cursors
8. Migrate proofs service to signed cursors
9. Update common module to export pagination services
10. Add implementation documentation

---

**Note**: This implementation follows established patterns in the codebase:
- Key rotation: Same pattern as `CredentialSigningKeyringService`
- Request signing: Similar approach to `request-signing.ts`
- Error handling: Consistent with service layer conventions
- Testing: Comprehensive unit tests, ready for integration testing
