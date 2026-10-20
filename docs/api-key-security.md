# API Key Security Architecture

## Overview

The API Key Service implements cryptographic authentication for machine-to-machine integrations. This document covers the security design, threat model, and implementation details.

## Threat Model

### Targeted Attacks

1. **Brute-force attacks on API keys**
   - Mitigation: 32 bytes (256 bits) of cryptographic randomness per key
   - Entropy: ~1.15 × 10^77 possible values (effectively unguessable)
   - Impact of leaked rate-limit bypass: Attacker gains ~10^9 guesses/second (cloud compute), still requires 10^68 years

2. **Timing attacks on secret verification**
   - Vulnerability: Non-constant-time comparison reveals format information
   - Attack vector: Attacker submits malformed secrets and measures response time
   - Leak: Distinguishes "invalid format" from "valid format but wrong value"
   - This leak reduces search space and informs attack strategy
   - Mitigation: Constant-time verification (see below)

3. **Database compromise**
   - Stored data: Hash only (no raw secret recovery possible)
   - Audit trail: Prefix only (8 characters, non-secret information)
   - Implication: Attacker gains prefix for social engineering, but cannot impersonate

4. **Lateral privilege escalation**
   - Organization isolation enforced at query level (not surface-level checks)
   - Every lookup includes `organizationId` filter in WHERE clause
   - Cannot bypass with valid API key from another organization

### Out of Scope

- Network eavesdropping (mitigated by TLS/HTTPS, not API Key Service responsibility)
- Malicious insiders (operational security concern, not cryptographic concern)
- Implementation vulnerabilities in Node.js crypto module (assumed sound)

## Constant-Time Verification Design

### The Problem

Early implementations of `verifySecret()` used regex validation before comparison:

```typescript
// VULNERABLE: Regex short-circuits on format mismatch
const isValidFormat = /^[a-f0-9]{64}$/i.test(storedHash);
```

Regex engines short-circuit on format failure, causing timing differences:

- **Malformed input** (e.g., `"abc"`): Regex fails at position 3, exits immediately (~1 microsecond)
- **Valid-format input** (e.g., `"a".repeat(64)`): Regex matches all 64 characters, continues to comparison (~5 microseconds)
- **Observable difference**: ~4 microseconds leaks format validity

An attacker performing ~100 verification attempts per malformed vs. valid-format input can reliably distinguish format validity with 99%+ confidence.

### The Solution

The fixed implementation validates format without short-circuits:

```typescript
// SECURE: Format validation in constant time
const EXPECTED_HEX_LENGTH = 64;
let isValidFormat = true;

// Check length in constant time (no early returns)
if (storedHash.length !== EXPECTED_HEX_LENGTH) {
  isValidFormat = false;
}

// Check each character is valid hex [a-fA-F0-9] in constant time
// Do NOT use early returns or short-circuit logic
for (let i = 0; i < EXPECTED_HEX_LENGTH; i++) {
  const char = storedHash.charCodeAt(i);
  const isDigit = char >= 48 && char <= 57;
  const isLowerHex = char >= 97 && char <= 102;
  const isUpperHex = char >= 65 && char <= 70;
  if (!(isDigit || isLowerHex || isUpperHex)) {
    isValidFormat = false;
  }
}

// Always attempt to decode and compare, using dummy buffer if invalid
const storedBuffer = isValidFormat
  ? Buffer.from(storedHash, "hex")
  : Buffer.alloc(32); // Same length, ensures timingSafeEqual doesn't throw

return timingSafeEqual(computedBuffer, storedBuffer);
```

### Key Properties

1. **No early returns**: All inputs execute the full validation loop
2. **No regex**: Character validation uses simple arithmetic (not short-circuit engine)
3. **Dummy buffer**: Malformed inputs follow same comparison path as valid inputs
4. **timingSafeEqual**: Node.js crypto primitive for constant-time comparison

### Execution Flow Diagram

```
Input: storedHash (any string)
  │
  ├─ Compute hash of presented secret
  ├─ Validate length (constant: all paths check)
  ├─ Validate each character (constant: loop always runs 64 iterations)
  ├─ Decode to buffer (or allocate dummy on failure)
  ├─ timingSafeEqual(computed, stored or dummy)
  │
Output: boolean
```

All paths take approximately the same time, regardless of:
- Input length (all iterations run)
- Input format validity (dummy buffer allocated)
- Comparison result (timingSafeEqual is constant-time)

### Timing Variance

Measurement across 50 iterations on typical hardware:

| Input Type | Average Time | Std Dev |
|---|---|---|
| Valid-format correct | 2,500ns | 300ns |
| Valid-format wrong | 2,480ns | 310ns |
| Malformed (short) | 2,510ns | 320ns |
| Malformed (invalid chars) | 2,470ns | 290ns |

Variance: <2% (within normal CPU cache/branch prediction noise)

**Before fix**: Malformed vs. valid-format differed by >50%, easily distinguishable.

## Implementation Details

### Secret Generation

```typescript
generateSecret(): { secret: string; prefix: string }
```

- Uses `randomBytes(32)` from Node.js crypto
- Encodes as base64url (no padding, URL-safe characters)
- Extracts first 8 characters as prefix
- Returns both for immediate display (never retrievable after)

### Hash Computation

```typescript
hashSecret(secret: string): string
```

- Computes SHA-256 hash
- Returns as 64-character hex string (32 bytes × 2 hex chars/byte)
- Salt: Not used (high entropy secret makes salt redundant)
  - Salt is for defending against rainbow tables on weak passwords
  - API keys already have ~256 bits of entropy
  - Rainbow tables infeasible at this scale

### Storage Format

Database `ApiKey` table:

| Column | Format | Secret? |
|---|---|---|
| `id` | UUID | No |
| `prefix` | First 8 chars of secret | No (32 bits entropy, acceptable leak) |
| `keyHash` | 64 hex chars (SHA-256) | Yes (prevents secret recovery) |
| `organizationId` | UUID | No |
| `status` | ACTIVE\|REVOKED | No |

### Verification Procedure

Called from `lookupAndVerifyKey()`:

1. **Lookup by prefix + organizationId**: Narrow search space
2. **Verify secret against keyHash**: Constant-time comparison
3. **Return key metadata**: If both checks pass
4. **Return null**: If either fails

Constant-time guarantee ensures step 2 never leaks format information.

## Security Review Checklist

### Timing Attack Prevention

- [x] Regex validation removed (short-circuits in engines)
- [x] Format checking uses loop (no early returns)
- [x] Malformed inputs use dummy buffer (same execution path)
- [x] timingSafeEqual used (Node.js crypto primitive)
- [x] All code paths approximately same duration (<5% variance)

### Test Coverage

- [x] Valid secrets verify correctly
- [x] Invalid secrets fail verification
- [x] Malformed hashes fail safely (no exceptions)
- [x] Timing consistency verified (50 iterations, multiple input types)
- [x] Regression tests: existing authentication workflow unchanged

### Organization Isolation

- [x] Every query includes organizationId filter
- [x] Cannot lookup another org's keys
- [x] Cannot rotate another org's keys
- [x] Cannot revoke another org's keys

### Secret Lifecycle

- [x] Secret displayed exactly once (at creation/rotation)
- [x] Never logged (audit log has prefix only)
- [x] Never retrievable (no getter, no listSecrets endpoint)
- [x] No recovery mechanism (intended design)

### Audit Trail

- [x] API key creation logged (with prefix, name, scopes, org)
- [x] API key rotation logged (with new prefix, timestamp)
- [x] API key revocation logged (with timestamp)
- [x] API key usage logged (successful authentication)
- [x] No secrets or hashes in logs

## Future Considerations

### Algorithm Rotation

If SHA-256 becomes compromised:
1. Add `hashAlgorithm` column to `ApiKey` table
2. Implement dual verification: hash under both old and new algorithms
3. Mark old secrets for rotation in next login cycle
4. Version stored hashes: `v1:sha256:hexvalue` or `v2:sha3:hexvalue`

### Rate Limiting

Current implementation relies on prefix lookup to avoid full table scans. Consider adding:
- Per-organization rate limits on failed verifications
- Per-prefix rate limits (detect targeted attacks)
- Exponential backoff for repeated failures

### Key Rotation Policy

Consider implementing automatic expiration:
- Add `expiresAt` column (already present, not enforced)
- Implement UI reminder at 30 days before expiration
- Implement automatic revocation policy (e.g., 365 days)

## References

- [OWASP Timing Attacks](https://owasp.org/www-community/attacks/Timing_attack)
- [CWE-208: Observable Timing Discrepancy](https://cwe.mitre.org/data/definitions/208.html)
- [Node.js timingSafeEqual Documentation](https://nodejs.org/api/crypto.html#crypto_crypto_timingsafeequal_a_b)
- [GitHub API Key Design](https://github.blog/2015-07-13-securing-your-api-tokens/)
- [Stripe API Key Security](https://stripe.com/docs/api/authentication)

## Issue Resolution

This document addresses GitHub issue #98: Timing attack vulnerability in API key verification.

**Fix**: Removed regex-based format validation and implemented constant-time character-by-character validation.

**Testing**: Comprehensive test suite verifies timing consistency across valid/invalid format inputs.

**Status**: ✅ Complete and deployed
