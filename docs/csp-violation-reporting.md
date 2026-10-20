# CSP violation reporting

`POST /api/v1/security/csp-reports` ingests Content-Security-Policy violation
reports from a frontend into a privacy-safe, aggregated summary. It does not
set the `Content-Security-Policy` response header or a `report-to` directive
— that is a separate, frontend-facing concern outside this PR's scope. Wiring
a CSP header to actually point browsers at this endpoint is a follow-up.

## Why the ingestion contract is not the raw browser report

A real browser CSP report (the `report-uri`/Reporting API shape) carries
`document-uri`, `blocked-uri`, `source-file`, line/column numbers, and
similar fields — several of which can contain full URLs, including query
strings and, in a leaky configuration, tokens. Rather than accept that shape
and redact it server-side, this endpoint never accepts those fields at all:
the frontend is expected to map its own raw CSP report into the bounded shape
below before POSTing. The global `ValidationPipe` (`whitelist: true`,
`forbidNonWhitelisted: true`, configured once in `src/bootstrap.ts`) rejects
any other property outright — nothing is silently dropped, and nothing not
on this list is ever stored.

## Request

```
POST /api/v1/security/csp-reports
Content-Type: application/json

{
  "directive": "SCRIPT_SRC",
  "routeCategory": "DASHBOARD",
  "release": "2026.10.1",
  "disposition": "ENFORCE"
}
```

| Field | Type | Notes |
|---|---|---|
| `directive` | enum `CspDirective` | The CSP directive that was violated. See `prisma/schema.prisma` for the full closed list. |
| `routeCategory` | enum `CspRouteCategory` | A coarse frontend page category — never a path, never a query string. `OTHER` is the fallback for anything not in the list. |
| `release` | string, 1-64 chars, `[A-Za-z0-9][A-Za-z0-9._+-]*` | The frontend's own app release/version. Same bounded-version-string shape as the deployment manifest's `deploymentVersion`. |
| `disposition` | enum `CspDisposition` | `ENFORCE` or `REPORT`, mirroring the CSP spec's own disposition values. |

Unauthenticated — a reporting browser has no session or API key. Rate-limited
by the global throttler plus a dedicated strict-sampling layer (below). Body
size is capped at 2 KB (`ROUTE_BODY_LIMITS`, `src/common/limits/request-limits.ts`)
— a legitimate report is a few dozen bytes.

## Response

Always `204 No Content` for a validly-shaped body, whether or not the report
was actually counted (sampled out, or a storage failure the service fails
open on internally). The response is deliberately uninformative about
sampling/storage outcome so it cannot be used as an oracle. A malformed body
(unknown enum value, missing field, unlisted property) gets the normal
`422 Unprocessable Entity` from the global validation pipe.

## Storage model

One row per `(directive, routeCategory, release, disposition)` combination in
`CspViolationSummary`, incremented via the same atomic
`INSERT ... ON CONFLICT DO UPDATE SET count = count + 1` upsert pattern
`ApiKeyUsageService` uses for its own per-key usage summary — concurrent
reports for the same bucket converge on one row with no lost updates, no
advisory lock needed. `lastSeenAt` is rounded down to the nearest minute, so
individual report timing cannot be reconstructed from storage.

## Strict sampling (abuse control)

A single misbehaving page can fire the same violation on every paint.
`CspViolationAbuseService` caps how many reports from one client contribute
to one bucket within a rolling window (default: 1 per client per bucket per
60 seconds, both configurable via `rateLimit.cspReportPerClientBucketLimit`
and `rateLimit.cspReportWindowMs`). Reports past the cap are dropped, not
stored, not counted — the endpoint's response does not change either way.
Client keys are HMACs held only in process memory; the raw IP is never
persisted or logged, the same pattern `ProofVerificationAbuseService` uses
for the other public, unauthenticated endpoint in this service.

## Operator access

`CspViolationService.getSummary()` returns every aggregate bucket
(`directive`, `routeCategory`, `release`, `disposition`, `count`,
`firstSeenAt`, `lastSeenAt`) — safe to expose to an operator, since it never
carries a raw URI, DOM data, or user input. Not yet wired to a controller
route in this PR; the aggregate data is there for a follow-up operator view
if one is wanted, mirroring `ApiKeyUsageService.getSummary()`'s own
not-yet-routed precedent.
