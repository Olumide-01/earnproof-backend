# Health Checks

A single `/health` endpoint cannot answer the two questions an operator actually
has. "Is the process running?" and "can it serve work right now?" have different
answers, different consumers, and — critically — different consequences when
they are wrong.

This service exposes three surfaces.

| Endpoint | Question | Auth | External calls |
|---|---|---|---|
| `GET /api/v1/health/live` | Is the process running? | none | never |
| `GET /api/v1/health/ready` | Can it serve dependent work? | none | required deps only |
| `GET /api/v1/health/diagnostics` | What exactly is wrong? | API key + `ORG_ADMIN` | required + optional |
| `GET /api/v1/health` | *(legacy aggregate)* | none | database |

## Liveness

`GET /api/v1/health/live` performs **no** database, network, or contract calls.
It returns `200` whenever the process can answer at all.

This is not laziness — it is the entire point. Orchestrators restart containers
that fail liveness. If liveness consulted the database, a database outage would
make every replica fail liveness simultaneously, and the orchestrator would
restart all of them. Restarting an API server cannot fix a database outage, and
it destroys the warm capacity needed to absorb the recovery.

Liveness should fail only for conditions a restart can actually fix.

## Readiness

`GET /api/v1/health/ready` returns `200` when every **required** dependency is
healthy, and `503` otherwise. Load balancers use this to decide whether to route
traffic to an instance.

Required dependencies (these gate the verdict):

- `database` — a `SELECT 1` round-trip.
- `configuration` — presence of `databaseUrl`, `sessionSecret`, and
  `credentialSigningSecret`.
- `clock_skew` — present unless `CLOCK_SKEW_READINESS_IMPACT=none`. Fails only
  while a **sustained** critical clock skew alert is active, never on a single
  measurement. Reason code only; the measured skew is diagnostics detail. See
  [clock-skew.md](clock-skew.md).

Optional dependencies are **not consulted by readiness at all**. Horizon, contract
anchoring, and webhook delivery appear only in diagnostics. Marking an optional
dependency as required is how a Horizon outage takes an entire API offline —
including the many routes that never touch Horizon.

The `503` body is the readiness payload itself, not a generic error envelope, so
an operator can see *which* dependency blocked readiness.

## Diagnostics

`GET /api/v1/health/diagnostics` reports every dependency, required and optional.

It requires an API key with the `ORG_ADMIN` scope, using the same `ApiKeyGuard` +
`ScopesGuard` pair as other privileged routes. Reusing that path is deliberate: a
separate health-specific secret would be one more credential to rotate and one
more place for an authorization bug to hide.

Authorization matters here because the endpoint enumerates infrastructure and its
current state — useful to an operator, equally useful to an attacker mapping the
system.

Diagnostics always returns `200` when authorized, even while reporting a
degraded dependency. It is an inspection surface, not a routing signal; making it
`503` would tempt operators to point load balancers at it and recreate exactly
the conflation this design removes.

## Status codes

Every dependency reports one of these stable values. Branch on these, not on any
human-readable text.

| Status | Meaning |
|---|---|
| `ok` | Answered within its timeout. |
| `degraded` | Answered, but reported a problem. |
| `timeout` | Did not answer within its timeout. |
| `error` | Errored, or could not be reached. |
| `disabled` | Intentionally switched off by configuration. |
| `not_configured` | Enabled, but not configured well enough to probe. |

`disabled` and `not_configured` are kept distinct on purpose: "we turned anchoring
off" and "anchoring is on but somebody forgot the contract ID" are very different
operational situations, and collapsing them hides a real misconfiguration.

## Redaction

Non-`ok` results carry a stable `reason` code, never a raw error.

This is a privacy and security boundary, not cosmetics. A driver connection error
routinely embeds the full DSN — including the password. Health output is
unauthenticated for `live` and `ready`, and even the authorized diagnostics output
ends up pasted into tickets and chat.

The rules the implementation enforces:

- Only reason codes the health module produced itself are echoed. Anything else
  collapses to `probe_failed`.
- The full error is logged server-side, where it is already trusted.
- Missing configuration is reported by **key name only**, never by value.
- Webhook health reports an aggregate count only — never endpoint URLs, payloads,
  or organization identifiers.
- Upstream HTTP failures report the status code (`upstream_status_503`), never the
  response body.

`health.service.spec.ts` asserts a simulated DSN-bearing driver error leaks
neither the password, the hostname, nor the underlying error code.

## Timeouts, caching, and concurrency

Three mechanisms stop probes from becoming the outage:

**Timeouts.** Every probe is bounded by `HEALTH_PROBE_TIMEOUT_MS` (default
`2000`). A probe that can block longer than the orchestrator's own timeout is
worse than useless: the platform gives up and retries, turning one slow
dependency into a stampede.

**Caching.** Results are reused for `HEALTH_CACHE_TTL_MS` (default `5000`).
Readiness is polled continuously by every replica and every load-balancer health
check, so without caching, probe load scales with poll rate rather than with
anything meaningful. Cached results are marked `cached: true` with an `ageMs`, so
a consumer can tell a fresh reading from a stale one.

**Single-flight.** Concurrent callers whose cache entry has expired share one
in-flight probe rather than issuing N. Without this, a slow dependency plus a high
poll rate produces precisely the overload the probe was meant to detect.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HEALTH_PROBE_TIMEOUT_MS` | `2000` | Per-probe timeout. Keep below the orchestrator's probe timeout. |
| `HEALTH_CACHE_TTL_MS` | `5000` | How long a probe result is reused. |
| `CLOCK_SKEW_*` | see [clock-skew.md](clock-skew.md) | Clock skew thresholds, unknown-time policy and readiness impact. |

## Backwards compatibility

`GET /api/v1/health` is unchanged in shape and semantics. Existing deployments,
dashboards, and compose healthchecks already point at it, so it keeps returning
`{ status, service, database, timestamp }` and still `503`s when the database is
unreachable.

New consumers should use `/health/live` and `/health/ready`.

## Testing

```bash
npx jest src/health --runInBand
```

Coverage includes timeout handling, stale and cached results, dependency
recovery, partial degradation, authorization wiring, and redaction. The
authorization tests read decorator metadata rather than mocking the guards — the
risk being defended against is somebody deleting a `@UseGuards` line, and a test
that mocked the guards away would pass straight through that mistake.
