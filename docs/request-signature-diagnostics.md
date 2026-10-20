# Request signature diagnostics

`POST /api/v1/integrations/signature-diagnostics` explains why a signed request
would be rejected, without revealing server secrets or creating anything
replayable (issue #316). It is for synthetic test requests while an integration
is being built.

Implementation: `src/common/crypto/request-signing-diagnostics.ts` (pure
evaluation) and `src/integrations/signature-diagnostics/`. The signing scheme
itself is documented in `src/common/crypto/request-signing.ts`.

## Calling it

Authenticate with the API key whose signing you want to check
(`Authorization: Bearer <secret>`, `X-Organization-Id`, `ORG_READ` scope).
Describe the synthetic request in the body:

```json
{
  "method": "POST",
  "path": "/api/v1/proofs/minimum-income",
  "body": "{\"thresholdAmount\":\"500.0000000\"}",
  "headers": {
    "signature": "v1=<64 hex>",
    "timestamp": "1724400000",
    "nonce": "abc123def456ghi7"
  },
  "declaredCanonical": "POST\n/api/v1/proofs/minimum-income\n1724400000\nabc123def456ghi7\n<body sha256>"
}
```

Send `bodySha256` instead of `body` if you prefer; sending both is **400**.
`body` is limited to 16 KiB. `declaredCanonical` is optional: when given, each
covered component is compared.

## Response

| Field | Values |
| --- | --- |
| `result` | `VALID` or `INVALID` |
| `failureCategory` | `null`, or the first failure in guard order (below) |
| `canonicalizationVersion` | `v1` |
| `coveredComponents` | `method`, `path`, `timestamp`, `nonce`, `body-sha256` |
| `headers` | `PRESENT` / `MISSING` / `MALFORMED` per signing header |
| `timestampWindow` | `status` (`WITHIN`, `TOO_OLD`, `TOO_NEW`, `MALFORMED`, `MISSING`), `skewSeconds` (server minus request), `windowSeconds` (300) |
| `canonicalStructure` | `OK`, `NOT_DECLARED`, `CRLF_LINE_ENDINGS`, `TRAILING_NEWLINE`, `WRONG_LINE_COUNT` |
| `components` | `MATCH` / `MISMATCH` / `NOT_DECLARED` per covered component |
| `signatureMatches` | `true`/`false`, or `null` when an earlier check stopped evaluation |
| `nonceStatus` | `CONSUMED`, `REPLAYED`, `MALFORMED`, `MISSING`, `NOT_EVALUATED` |

### Stable failure categories

In the order `RequestSigningGuard` applies them: `MISSING_HEADERS`,
`MALFORMED_TIMESTAMP`, `STALE_TIMESTAMP`, `MALFORMED_NONCE`,
`MALFORMED_SIGNATURE`, `SIGNATURE_INVALID`, then `NONCE_REPLAYED`. For the same
inputs, diagnostics and the guard report the same failure; a unit test asserts
this against `verifySignature`.

When only the timestamp is out of window, `signatureMatches` still reports
whether the HMAC was right, so a clock problem can be told apart from a signing
problem.

### Boundaries

- The window is ±300 seconds inclusive: a skew of exactly 300 is `WITHIN`, 301
  is `TOO_OLD`/`TOO_NEW`. This matches the guard.
- Timestamps must be whole Unix seconds. Leading/trailing whitespace is
  tolerated as the guard tolerates it; `+`, decimals and exponents are
  `MALFORMED`.

## What is never returned

- The expected signature, the derived signing key, or the server's canonical
  string. Component checks only compare the caller's declared lines with lines
  built from the caller's own inputs.
- The nonce, the signature, or the body. Logs record the key id and the
  category only.

## Nonces and replay

Every **well-formed** nonce whose timestamp is **within the window** is consumed
by diagnostics, whether or not the signature matched. It is consumed through
the same atomic store the guard uses, in the calling key's namespace.

- A request that went through diagnostics can never afterwards be accepted by a
  live endpoint.
- Of two concurrent diagnostics with the same nonce, exactly one reports
  `CONSUMED`; the other reports `REPLAYED`.
- If the nonce store is unavailable the claim fails closed and the nonce is
  reported `REPLAYED`, as the guard would reject it.

Use fresh, synthetic nonces for diagnostics. Never submit a nonce you intend to
use for a real call.

## Abuse controls

- API key authentication with the `ORG_READ` scope.
- 10 requests per minute on this route, on top of the global limiter.
- Bounded inputs: 16 KiB body, 2 KiB path, 4 KiB declared canonical string.
- Signature comparison is constant-time.
