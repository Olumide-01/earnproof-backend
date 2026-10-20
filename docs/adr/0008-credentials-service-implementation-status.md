# ADR-0008: CredentialsService Implementation Status

**Status:** Accepted  
**Date:** 2026-09-23  
**Deciders:** Development Team  
**Issue:** #92 — Implement missing CredentialsService or remove unused controller

## Context

Issue #92 titled "Implement missing CredentialsService or remove unused controller" prompted an investigation into the status of the credentials module. The issue suggested that `CredentialsController` existed without a corresponding service implementation.

## Investigation Findings

A thorough code inspection revealed that **CredentialsService is fully implemented and actively used** in production. The issue title reflects an outdated state of the codebase.

### CredentialsService Implementation

**Location:** `src/credentials/credentials.service.ts` (~350 lines)

**Functionality:** Implements a complete 7-step credential verification pipeline:

1. **Size/Depth Guard** — Validates payloads ≤32 KB and nesting ≤5 levels
2. **Schema Version Check** — Fast early-exit if schema version or type don't match supported version (`earnproof.minimum-income.v1`)
3. **Zod Shape Validation** — Strict schema validation against `MinimumIncomeCredentialSchema`
4. **Credential Hash Verification** — Canonicalizes credential body (excluding proof block) and verifies hash using timing-safe comparison
5. **HMAC-SHA256 Signature Verification** — Recomputes signature and timing-safely compares against submitted signature
6. **Database Reconciliation** — Looks up proof by unique `credentialHash` index; verifies:
   - Proof exists in database
   - Status is ACTIVE (not REVOKED)
   - Not expired (checked against both database `expiresAt` and credential's `expiresAt`)
   - If anchoring enabled, verifies contract transaction status via `ContractAnchoringService`
7. **Result Return** — Returns one of 8 possible verification outcomes

### CredentialsController Integration

**Location:** `src/credentials/credentials.controller.ts`

**Endpoint:** `POST /api/v1/credentials/verify`

**Configuration:**
- Rate limited: 10 requests per minute per client
- Request timeout handling via `RequestTimeoutInterceptor`
- Public, unauthenticated endpoint (by design — see ADR-0004)
- Request body limit: 40 KB
- Comprehensive OpenAPI documentation with examples

### Module Wiring

- **Module Registration:** `CredentialsModule` properly defined with controller, service, and `ProofsModule` dependency
- **AppModule Integration:** `CredentialsModule` imported in `src/app.module.ts` (line 43)

### Test Coverage

Comprehensive test suite present:
- `credentials.controller.spec.ts` — 14+ HTTP and unit tests
- `credentials.service.spec.ts` — 15+ unit tests covering verification logic
- `credential-conformance.spec.ts` — Conformance tests
- `credential.perf-spec.ts` — Performance tests for database lookup

### Design Rationale

The endpoint is **deliberately unauthenticated** (documented in code comments and referenced in ADR-0004). Design reasoning:

> "A verifier is typically a landlord, lender or employer holding a credential a worker handed them, and requiring them to hold an account first would put a login between a worker and being believed."

## Decision

**No action required.** The CredentialsService and CredentialsController are:
- ✅ Fully implemented and production-ready
- ✅ Actively wired into the application module
- ✅ Comprehensively tested
- ✅ Properly documented (OpenAPI, code comments, design intent)
- ✅ Following secure coding patterns (timing-safe comparisons, input validation, cryptographic verification)

Issue #92's premise was based on an outdated understanding of the codebase. Both the service and controller are essential, active components of the application.

## Consequences

- **Positive:** Clarifies that the credentials verification module is complete and production-ready
- **Documentation:** This ADR serves as a reference for future developers investigating the credentials module
- **Closure:** Issue #92 is closed as "not a bug" — investigation confirmed implementation is complete

## Related ADRs

- **ADR-0004** — Public unauthenticated verification design rationale
- **ADR-0007** — Credentials module decision to keep it (related architectural context)
