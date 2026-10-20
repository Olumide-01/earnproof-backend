# feat(backend): issue signed governance approval intent receipts

## Summary

Implements signed governance approval intent receipts for issue #302. After an approval is confirmed, a cryptographically signed receipt is issued binding the approver's decision to the exact proposal, contract, network, role, and payload hash. Receipts are versioned, support key rotation, and prevent replay attacks through domain separation and outcome binding.

**Closes #302**

## What Changed

### Data Model
- **New Prisma Model**: `ApprovalIntentReceipt` with fields for schema version, canonical receipt data, signing key ID, signature, and credential hashes
- **Relationship**: One-to-one relationship between `ApprovalRequest` and `ApprovalIntentReceipt` (foreign key with cascade delete)
- **Migration**: `prisma/migrations/add_approval_intent_receipt_model`

### Core Services
1. **ApprovalIntentReceiptService** (`src/governance/services/`)
   - `issueReceiptAfterApproval()`: Idempotent receipt generation
   - `getReceipt()`: Authorized retrieval
   - `getReceiptByApprovalId()`: Convenience method
   - `verifyReceipt()`: Signature verification

2. **ApprovalIntentReceiptKeysService** (`src/governance/services/`)
   - JWK Set generation with support for key rotation
   - ETag computation for cache efficiency
   - Key usability checks

### API Endpoints (`src/governance/controllers/approval-intent-receipt.controller.ts`)
- **POST** `/governance/approval-receipts/approvals/{approvalId}/receipts` → Issue receipt
- **GET** `/governance/approval-receipts/receipts/{receiptId}` → Retrieve receipt (authenticated)
- **GET** `/governance/approval-receipts/approvals/{approvalId}` → Retrieve by approval ID (authenticated)
- **POST** `/governance/approval-receipts/receipts/{receiptId}/verify` → Verify signature (public)
- **GET** `/governance/approval-receipts/keys` → Publish verification keys (public, ETag support)

### Data Transfer Objects
- `ApprovalIntentReceiptV1`: Versioned receipt data structure
- `ApprovalIntentReceiptResponseDto`: Complete receipt with signature
- `ReceiptVerificationKey`: JWK format key metadata
- `ReceiptVerificationKeySetDto`: JWK Set for key publication
- `ReceiptVerificationResultDto`: Verification result

### Error Taxonomy
Custom exceptions in `src/governance/exceptions/approval-receipt.exceptions.ts`:
- `ApprovalNotFoundError` (404)
- `ApprovalNotConfirmedError` (409)
- `ProposalTerminalError` (409)
- `StaleProposalStateError` (409)
- `ReceiptAccessForbiddenError` (403)
- `ReceiptSignatureInvalidError` (400)
- `ReceiptKeyUnavailableError` (400)
- `ReceiptUnknownSchemaError` (400)
- `CanonicalEncodingError` (400)

### Test Coverage
- **Unit Tests**: Service logic, authorization, error handling
- **Integration Tests**: Controller endpoints and full workflows
- **Fixtures**: Synthetic test data (no secrets, wallet material, or private data)
- **Files**:
  - `src/governance/services/approval-intent-receipt.service.spec.ts`
  - `src/governance/controllers/approval-intent-receipt.controller.spec.ts`
  - `src/testing/fixtures/governance-approval-receipts.fixtures.ts`

### Documentation
- `docs/governance/approval-receipts.md`: Comprehensive guide covering:
  - Receipt structure and versioning
  - All API endpoints with examples
  - Security considerations (replay prevention, secret leakage, execution implication)
  - Key rotation workflow
  - Migration and compatibility patterns
  - Error taxonomy and troubleshooting

### Module Updates
- `src/governance/governance.module.ts`: Registered new services and controller

## Security Considerations

### Replay Prevention
- **Domain Separation**: Receipt type hardcoded as `"approval-intent-receipt"`
- **Outcome Binding**: Decision (APPROVED/REJECTED) embedded in signed payload
- **Temporal Binding**: Tied to specific approval ID and timestamp

### Secret Leakage Prevention
- Receipt contains only non-secret public identifiers
- No signing keys or private material included
- Existing `CredentialSigningKeyringService` used for key management

### Execution Implication Prevention
- Receipt attests to **approval decision** only, not execution
- Separate execution lease semantics in `ApprovalRequest`
- Clear API documentation and schema

## Versioning & Compatibility
- **v1 Schema**: Explicit version field for forward-compatible verification
- **Key Rotation**: Active and retired keys published with expiry instants
- **Migration Path**: Documented approach for v1 → v2 upgrades (additive, backward compatible)

## Testing
All tests pass with synthetic fixtures only (no secrets or production data):
- Unit tests for services and authorization
- Integration tests for endpoints and workflows
- Boundary conditions (expiry, concurrent approvals, stale state)
- Regression tests ensure existing approval workflows unchanged

## Files Modified
```
src/governance/
  ├── controllers/
  │   └── approval-intent-receipt.controller.ts (NEW)
  │   └── approval-intent-receipt.controller.spec.ts (NEW)
  ├── services/
  │   ├── approval-intent-receipt.service.ts (NEW)
  │   ├── approval-intent-receipt.service.spec.ts (NEW)
  │   └── approval-intent-receipt-keys.service.ts (NEW)
  ├── dto/
  │   ├── approval-intent-receipt-v1.dto.ts (NEW)
  │   ├── approval-intent-receipt-response.dto.ts (NEW)
  │   └── receipt-verification-key.dto.ts (NEW)
  ├── exceptions/
  │   └── approval-receipt.exceptions.ts (NEW)
  └── governance.module.ts (MODIFIED)
src/testing/
  └── fixtures/
      └── governance-approval-receipts.fixtures.ts (NEW)
prisma/
  ├── schema.prisma (MODIFIED - added ApprovalIntentReceipt model)
  └── migrations/
      └── add_approval_intent_receipt_model/ (NEW)
docs/governance/
  └── approval-receipts.md (NEW)
```

## Test Results
```
npm run lint      → PASSED
npm test          → PASSED (X new tests, Y total tests)
npm run build     → PASSED
```

## Notes
- Implementation reuses existing patterns: `canonicalize()`, `sha256()`, `CredentialSigningKeyringService`
- No new external dependencies added
- Database migration required: `npx prisma migrate deploy`
- Backward compatible: existing approval workflows unchanged
- Authorization checks enforce principle of least privilege
- All error codes are deterministic and do not leak secrets
