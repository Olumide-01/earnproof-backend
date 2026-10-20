# Clock Skew Monitoring

Authentication challenges, session expiry, cooldowns and ledger finality all
compare this process's clock with times minted elsewhere. Those comparisons
are only sound while local time agrees with network time within a bound.
`ClockSkewMonitorService` measures that agreement, classifies it, alerts on
sustained deviation and exposes the result to readiness and diagnostics.

**It never adjusts a clock.** Correcting time is the host's job (NTP or
chrony). The monitor only reads the injected `Clock`; nothing consumes its
estimate as a correction.

Code: [`src/common/time/clock-skew.ts`](../src/common/time/clock-skew.ts)
(pure classification), [`src/stellar/ledger-time-source.ts`](../src/stellar/ledger-time-source.ts)
(time sources), [`src/health/clock-skew-monitor.service.ts`](../src/health/clock-skew-monitor.service.ts)
(sampling, alerting, readiness).

## Trusted time sources

| Source | Reference | Resolution | Allowed lag |
|---|---|---|---|
| `horizon_ledger_close` | `closed_at` of the newest ledger (`/ledgers?order=desc&limit=1`) | 1s | `CLOCK_SKEW_LEDGER_CLOSE_ALLOWANCE_MS` (one ledger interval) |
| `horizon_http_date` | HTTP `Date` header of a Horizon response (IMF-fixdate only) | 1s | 0 |

The ledger source carries its sequence number. A reading whose sequence is
lower than the last accepted one is a cached or replayed response and is
discarded (`stale_reference`), never trusted.

## Measurement

For each sample the monitor records the local instants the request was sent
(`t0`) and answered (`t1`). The source's true time lies in
`[reference, reference + resolution + allowedLag]`, and it was produced at
some local instant in `[t0, t1]`. That gives the interval of
`local − network` offsets consistent with the observation:

```
lower = t0 − (reference + resolution + allowedLag)
upper = t1 − reference
```

The reported skew is the smallest skew consistent with that interval: `0`
when the interval contains zero, otherwise the bound nearest zero. It never
overstates skew. A positive value means the local clock is ahead.

Samples are discarded, not guessed at, when:

| Code | Condition |
|---|---|
| `round_trip_exceeded` | `t1 − t0 > CLOCK_SKEW_MAX_ROUND_TRIP_MS` (equal is accepted) |
| `local_clock_regressed` | `t1 < t0`: the local clock stepped backwards mid-request |
| `stale_reference` | ledger sequence went backwards |
| `invalid_reading` | non-finite numbers or negative uncertainty |

With several sources, the estimate of **smallest magnitude** decides (ties
broken by source name). A wrong local clock is wrong against every source, so
one broken source can never raise an alert on its own.

## Classification

| Status | Condition (inclusive thresholds) |
|---|---|
| `ok` | `|skew| < CLOCK_SKEW_WARN_MS` |
| `warning` | `CLOCK_SKEW_WARN_MS ≤ |skew| < CLOCK_SKEW_CRITICAL_MS` |
| `critical` | `|skew| ≥ CLOCK_SKEW_CRITICAL_MS` |
| `unknown` | no sample, or no sample at most `CLOCK_SKEW_MAX_SAMPLE_AGE_MS` old |

Staleness is evaluated whenever the state is read, not only when sampling, so
a sampler that stops degrades to `unknown` by itself instead of serving its
last good verdict forever.

### Unknown time health

`CLOCK_SKEW_UNKNOWN_POLICY` makes the unknown case explicit:

- `fail_open` (default) — unknown is reported in diagnostics but never counts
  as a breach.
- `fail_closed` — unknown counts as a **critical** breach, so a sustained
  unknown fails readiness under `CLOCK_SKEW_READINESS_IMPACT=critical`.

Both trusted sources are served by Horizon. Under `fail_closed`, a sustained
Horizon outage therefore drains every replica — the coupling
[health-checks.md](health-checks.md) warns against — which is why it is
opt-in.

## Sustained-deviation alerting

A breach (warning, critical, or unknown under `fail_closed`) raises an alert
only once it has lasted `CLOCK_SKEW_SUSTAIN_FOR_MS` without interruption
(equal duration raises). The alert clears after
`CLOCK_SKEW_CLEAR_AFTER_ASSESSMENTS` consecutive healthy assessments; a breach
that returns before then resets the streak. Severity changes while active are
reported as `escalated` / `deescalated`, not as new alerts.

Transitions are logged once each as structured events
(`clock_skew.alert_raised`, `_escalated`, `_deescalated`, `_cleared`) carrying
status, skew, source and reason only. The state machine is a pure function,
so replaying the same assessments always reproduces the same alerts.

## Readiness and diagnostics

`CLOCK_SKEW_READINESS_IMPACT`:

- `critical` (default) — `/health/ready` includes a required `clock_skew`
  dependency that is `error` (`clock_skew_sustained_critical`) only while a
  **sustained critical** alert is active *and* the current assessment is still
  critical. One slow or lying response cannot drain a replica.
- `none` — readiness never includes clock skew.

`/health/diagnostics` (API key + `ORG_ADMIN`) always includes a `clock_skew`
entry with the instantaneous classification (`ok`, `degraded` for warning,
`error` for critical, unknown mapped by policy), the alert state, the policy
and per-source outcome codes. It is `required` only while it blocks readiness,
so the diagnostics verdict never disagrees with readiness. Readiness carries
reason codes only; the measured numbers appear in diagnostics only.

Errors from a source are reported as codes the module minted itself
(`upstream_status_503`, `ledger_response_malformed`, `probe_timeout`, ...).
Anything else collapses to `probe_failed`, so a URL or response fragment is
never echoed.

## Concurrency

Measurements are single-flight: concurrent callers share one in-flight
measurement, so a burst of polls cannot fan out into a burst of Horizon
requests and the alert state advances exactly once per measurement. Sampling
runs every `CLOCK_SKEW_INTERVAL_MS` on an `unref`'d timer.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLOCK_SKEW_MONITOR_ENABLED` | `true` (`false` under `NODE_ENV=test`) | Switches sampling off entirely. |
| `CLOCK_SKEW_INTERVAL_MS` | `60000` | Sampling interval. |
| `CLOCK_SKEW_PROBE_TIMEOUT_MS` | `2000` | Per-source timeout. |
| `CLOCK_SKEW_WARN_MS` | `2000` | Warning threshold. |
| `CLOCK_SKEW_CRITICAL_MS` | `10000` | Critical threshold; must exceed the warning threshold. |
| `CLOCK_SKEW_MAX_ROUND_TRIP_MS` | `5000` | Samples with a longer round trip are discarded. |
| `CLOCK_SKEW_MAX_SAMPLE_AGE_MS` | `180000` | Freshness bound; must be at least the interval. |
| `CLOCK_SKEW_SUSTAIN_FOR_MS` | `300000` | How long a breach lasts before alerting. |
| `CLOCK_SKEW_CLEAR_AFTER_ASSESSMENTS` | `2` | Healthy assessments needed to clear. |
| `CLOCK_SKEW_LEDGER_CLOSE_ALLOWANCE_MS` | `10000` | How far the newest ledger may trail network time. |
| `CLOCK_SKEW_UNKNOWN_POLICY` | `fail_open` | `fail_open` or `fail_closed`. |
| `CLOCK_SKEW_READINESS_IMPACT` | `critical` | `critical` or `none`. |

Startup validation refuses a critical threshold at or below the warning
threshold, and a sample age shorter than the sampling interval.
