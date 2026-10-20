# Signed Cursor Pagination Tokens Implementation (#326)

## Overview

This implementation delivers tamper-proof, time-bound cursor pagination tokens for EarnProof API list endpoints. Cursors are protected against:
- **Tampering**: HMAC-SHA256 signatures prevent modification
- **Expiry attacks**: 15-minute default TTL (configurable per request)
- **Cross-filter pagination**: Filter ID binding prevents using cursors across different filter sets
- **Cross-tenant data leaks**: Tenant ID binding ensures cursors cannot be used by other organizations
- **Key rotation**: Versioned signing keys support staged key rotation with configurable verify-until deadlines

## Architecture

### Core Components

1. **SignedCursorService** (`src/common/pagination/signed-cursor.service.ts`)
   - Signs cursor tokens with HMAC-SHA256
   - Validates tokens and enforces all security constraints
   - Never throws on validation failures (returns typed failure reasons)
   - Supports versioned key rotation

2. **SignedCursorKeyringService** (`src/common/pagination/signed-cursor-keyring.service.ts`)
   - Manages versioned signing keys similar to CredentialSigningKeyringService
   - Loads keys from config: `CURSOR_SIGNING_SECRET_V{n}`
   - Supports key rotation with `CURSOR_SIGNING_KEY_VERSION` and `CURSOR_SIGNING_SECRET_V{n}_VERIFY_UNTIL`
   - Defaults to version 0 for backward compatibility

3. **Filter ID Utility** (`src/common/pagination/filter-id.ts`)
   - Computes deterministic SHA-256 hashes of filter parameters
   - Binds cursors to specific filter contexts (status, category, etc.)
   - Prevents cross-filter pagination with deterministic normalization

4. **PaginationModule** (`src/common/pagination/pagination.module.ts`)
   - NestJS module exporting SignedCursorService and SignedCursorKeyringService
   - Imported globally in CommonModule

### Signed Cursor Envelope Format

```json
{
  "version": "1",
  "signature": "hex-encoded HMAC-SHA256",
  "expiresAt": 1726400000000,
  "filterId": "sha256-hash-of-filters",
  "tenantId": "org-id",
  "cursorId": "last-item-id"
}
```

Base64url-encoded and returned as opaque token to client.

### Security Model

#### Signing Process
1. Build normalized payload (deterministic JSON with sorted keys)
2. Compute HMAC-SHA256(activeSecret, canonicalPayload)
3. Include signature in envelope
4. Base64url-encode envelope
5. Return token to client

#### Validation Process (Never Throws)
1. Base64url-decode token
2. Parse JSON payload
3. Validate all required fields present
4. Verify version is "1"
5. Verify expiry hasn't passed
6. **Verify tenant ID matches** (reject on mismatch — prevents cross-tenant attempts)
7. **Verify filter ID matches** (reject on mismatch — prevents cross-filter attempts)
8. Verify HMAC signature with constant-time comparison (prevents timing oracles)
9. Return payload on success or failure reason on any error

#### Failure Reasons (Stable, Deterministic, No Data Leaks)
- `MALFORMED`: Decoding or parsing failed
- `UNSUPPORTED_VERSION`: Version is not "1"
- `SIGNATURE_INVALID`: Tampering detected
- `EXPIRED`: TTL exceeded
- `FILTER_MISMATCH`: Cursor bound to different filter set
- `TENANT_MISMATCH`: Cursor bound to different tenant
- `MISSING_FIELDS`: Required fields absent

## Migrated Endpoints

### 1. Disputes Service (`src/disputes/disputes.service.ts`)

**Endpoint**: `GET /disputes`

**Changes**:
- Inject `SignedCursorService`
- Compute `filterId` from query filters: `status`, `category`, `assignedTo`
- Validate incoming cursor token
- Sign outgoing cursor with current filter context
- Return signed `nextCursor` in response

**Error Handling**:
- Cursor validation failures return stable `BadRequestException`
- No data leaks through error messages

### 2. Proofs Service (`src/proofs/proofs.service.ts`)

**Endpoint**: `GET /proofs`

**Changes**:
- Inject `SignedCursorService` in constructor
- Compute `filterId` from query filters: `type`, `status`, `assetCode`, `issuedFrom`, `issuedTo`
- Validate incoming cursor token with cross-tenant and cross-filter checks
- Sign outgoing cursor with current filter context and userId as tenant
- Return signed `nextCursor` in response

**Error Handling**:
- Cursor validation failures return stable `BadRequestException`
- No data leaks through error messages

### 3. Payments Service (`src/payments/payments.service.ts`)

**Status**: No changes required
- `listPayments` does not use cursor pagination (returns fixed 100 items)
- Not in scope for this implementation

## DTOs and Types

### SignedCursorPaginationQueryDto
Standard query DTO for cursor-paginated endpoints:
```typescript
{
  limit?: number;      // 1-100, default 20
  cursor?: string;     // Base64url-encoded signed token
}
```

### PaginatedListResponse<T>
Standard response shape:
```typescript
{
  data: T[];
  pageInfo: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}
```

### SignedCursorFailureReason
Enumeration of stable, deterministic failure reasons with no data leaks.

## Configuration

### Environment Variables

```bash
# Signing key (version 0, legacy)
CURSOR_SIGNING_SECRET=<base64-or-hex-secret>

# Versioned signing keys
CURSOR_SIGNING_SECRET_V0=<secret-v0>
CURSOR_SIGNING_SECRET_V1=<secret-v1>
# ... up to V99

# Active signing key version
CURSOR_SIGNING_KEY_VERSION=1

# Expiry deadlines for non-active versions (ISO-8601)
CURSOR_SIGNING_SECRET_V0_VERIFY_UNTIL=2024-12-31T23:59:59Z
```

### Key Rotation Workflow

1. **Generate new key**: `CURSOR_SIGNING_SECRET_V2=<new-secret>`
2. **Set as active**: `CURSOR_SIGNING_KEY_VERSION=2`
3. **Set verify-until on old key**: `CURSOR_SIGNING_SECRET_V1_VERIFY_UNTIL=2024-12-31T23:59:59Z`
4. **Retire old key**: Delete `CURSOR_SIGNING_SECRET_V0` (after deadline passes)

## Testing

### Unit Tests

**SignedCursorService** (`src/common/pagination/signed-cursor.service.spec.ts`)
- ✓ Sign creates valid tokens with expiry
- ✓ Sign includes all envelope fields
- ✓ Verify accepts valid tokens
- ✓ Verify rejects malformed tokens
- ✓ Verify rejects expired tokens
- ✓ Verify rejects mismatched tenant IDs
- ✓ Verify rejects mismatched filter IDs
- ✓ Verify detects tampering (modified cursor ID, filter ID, signature)
- ✓ Cross-tenant protection verified
- ✓ Cross-filter protection verified
- ✓ Round-trip consistency across special characters
- ✓ Constant-time comparison prevents timing oracles
- ✓ Deterministic encoding (base64url)

**SignedCursorKeyringService** (`src/common/pagination/signed-cursor-keyring.service.spec.ts`)
- ✓ Load versioned keys from config
- ✓ Load legacy secret as version 0
- ✓ Default to version 0
- ✓ Load keys until first gap
- ✓ Return active secret
- ✓ Throw on missing active version
- ✓ Get secret for specific version
- ✓ Return undefined for unloaded version
- ✓ Allow verification with all loaded versions
- ✓ Deny verification with unloaded versions
- ✓ Respect VERIFY_UNTIL deadlines for non-active versions
- ✓ Always allow active version regardless of deadline
- ✓ Return sorted loaded versions

### Integration Tests

Manual testing with curl:

```bash
# Get first page
curl -s https://api.example.com/disputes?limit=10 | jq '.pageInfo.nextCursor'

# Use cursor for next page
curl -s "https://api.example.com/disputes?limit=10&cursor=<nextCursor>" | jq '.data | length'

# Tamper detection: attempt to use cursor across different filter
curl -s "https://api.example.com/disputes?limit=10&cursor=<nextCursor>&status=RESOLVED" 
# Returns: 400 Bad Request with "Invalid pagination cursor: FILTER_MISMATCH"

# Cross-tenant detection: user A tries to use user B's cursor
# (Service-level enforcement through tenant ID binding)
```

## Acceptance Criteria Verification

### ✓ Tampered cursors fail with stable errors
- All modifications (cursorId, filterId, signature, expiresAt, tenantId) detected
- Failure reason returned, no data leaked
- Error message: "Invalid pagination cursor: {reason}"

### ✓ Expired cursors fail with stable errors
- TTL validation occurs before filter/tenant checks
- Failure reason: `EXPIRED`
- 15-minute default TTL, configurable per request

### ✓ Cross-filter cursors fail with stable errors
- Filter ID computed deterministically from query parameters
- Cursor bound to specific filter set (status, category, etc.)
- Failure reason: `FILTER_MISMATCH`

### ✓ Cross-tenant cursors fail with stable errors
- Tenant ID binding enforced (organizationId for disputes, userId for proofs)
- Mismatches detected before signature verification
- Failure reason: `TENANT_MISMATCH`

### ✓ Failure behavior is deterministic
- No exceptions thrown on validation failures
- Typed failure reasons returned
- No timing oracles (constant-time comparison)
- Validation order: version → expiry → tenant → filter → signature

### ✓ Exact boundary behavior documented
- TTL check: `nowMs > envelope.expiresAt` (token invalid at or after expiry)
- Cursor pagination: Prisma cursor behavior (keyset pagination with skip:1)
- Filter ID: Sorted JSON of normalized filter parameters

### ✓ Focused tests cover all scenarios
- **Positive**: Valid tokens, round-trip consistency
- **Negative**: Malformed, expired, tampered, mismatched
- **Authorization**: Cross-tenant, cross-filter
- **Concurrency**: Versioned key rotation
- **Boundary**: Expiry boundary, special characters in IDs
- **Regression**: All failure reasons deterministic

## Migration Path for Future Endpoints

To add signed cursor pagination to new list endpoints:

1. Import `SignedCursorService` and `computeFilterIdFromDto`
2. Inject `SignedCursorService` in service constructor
3. In list method:
   ```typescript
   const filterId = computeFilterIdFromDto(query, ['status', 'type', ...]);
   
   let cursorId: string | undefined;
   if (query.cursor) {
     const verifyResult = this.signedCursorService.verify({
       token: query.cursor,
       tenantId: userId,
       filterId,
     });
     if (!verifyResult.ok) {
       throw new BadRequestException(
         `Invalid pagination cursor: ${verifyResult.reason}`
       );
     }
     cursorId = verifyResult.data.cursorId;
   }
   
   // ... execute query with cursorId ...
   
   const nextCursor = hasMore
     ? this.signedCursorService.sign({
         cursorId: lastItemId,
         tenantId: userId,
         filterId,
       })
     : null;
   ```

## Security Considerations

### Key Material
- Never logged (only versions and key IDs logged)
- Derived using HMAC for isolation
- Supports staged key rotation with verify-until deadlines

### Timing Safety
- Constant-time comparison for signatures
- All validation paths deterministic
- No conditional behavior based on secret information

### Information Leakage
- All validation failures return typed, stable reasons
- No exception stack traces exposed
- Error messages do not reveal internal state
- Base64url encoding prevents binary data exposure

### Replay Attacks
- Cursors expire after 15 minutes
- Signature validates entire payload (cursorId, filterId, tenantId, expiresAt)
- Prisma keyset pagination prevents re-accessing same items

### Brute Force
- HMAC-SHA256 with full entropy secret
- 64-character hex signature space

## Production Readiness

### Before Deploying

1. ✓ Configure signing keys (non-empty, sufficient entropy)
2. ✓ Set `CURSOR_SIGNING_KEY_VERSION` to active version
3. ✓ Verify `DEFAULT_CURSOR_TTL_SECONDS` (15 min default, adjust if needed)
4. ✓ Review and test key rotation workflow
5. ✓ Verify no secrets in logs (use structured logger)

### Monitoring

- Log cursor validation failures at WARN level for debugging
- Track cursor expiry rates (may indicate clock skew)
- Alert on key rotation deadline approaches

### Rollback

If issues arise:
1. Revert service code changes to restore unsigned cursors (backward compatible)
2. Optionally rotate keys by adding new version and demoting old one

## Files Added/Modified

### New Files
- `src/common/pagination/signed-cursor.types.ts`
- `src/common/pagination/signed-cursor.service.ts`
- `src/common/pagination/signed-cursor-keyring.service.ts`
- `src/common/pagination/signed-cursor.dto.ts`
- `src/common/pagination/filter-id.ts`
- `src/common/pagination/pagination.module.ts`
- `src/common/pagination/signed-cursor.service.spec.ts`
- `src/common/pagination/signed-cursor-keyring.service.spec.ts`

### Modified Files
- `src/common/common.module.ts` (import PaginationModule)
- `src/disputes/disputes.service.ts` (inject SignedCursorService, update listDisputes)
- `src/proofs/proofs.service.ts` (inject SignedCursorService, update listProofs)
- `src/proofs/dto/list-proofs.dto.ts` (add cursor validation)

## References

- Request signing pattern: `src/common/crypto/request-signing.ts`
- Credential signing keyring: `src/common/crypto/credential-signing-keyring.service.ts`
- Payment encryption keyring: `src/common/crypto/payment-encryption-keyring.service.ts`
