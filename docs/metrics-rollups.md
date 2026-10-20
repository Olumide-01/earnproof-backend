# Operational Metric Rollups

Long-term usage and capacity charts need history without keeping raw events.
The rollup pipeline downsamples the in-process SLI registry
([observability.md](observability.md)) into minute, hour and day aggregates
with bounded retention.

Code: [`src/metrics/metric-rollup.ts`](../src/metrics/metric-rollup.ts) (pure
rules), [`src/metrics/metric-rollup.service.ts`](../src/metrics/metric-rollup.service.ts),
[`src/jobs/metrics-rollup.job.ts`](../src/jobs/metrics-rollup.job.ts) (schedule).

## What is stored

Only metrics from the SLI catalog (`METRIC_NAMES`), with label sets from the
closed vocabulary in `metric-labels.ts`, and numbers. Labels are re-validated
on the way in and on the way out. There is no request payload, wallet,
account, proof, organization or user anywhere in the pipeline. `sourceId` is a
random per-process UUID, not a hostname.

| Table | Contents | Default retention |
|---|---|---|
| `OperationalMetricContribution` | per-series delta from one capture | 6 hours (`METRICS_ROLLUP_RAW_RETENTION_HOURS`) |
| `OperationalMetricRollup` (`MINUTE`) | sum of a sealed minute's contributions | 3 days |
| `OperationalMetricRollup` (`HOUR`) | sum of a sealed hour's minutes | 90 days |
| `OperationalMetricRollup` (`DAY`) | sum of a sealed UTC day's hours | 730 days |
| `OperationalMetricWatermark` | exclusive end of the newest rolled-up bucket per tier | kept |

Counters store `sum` (increments). Histograms store `sum`, `count` and
cumulative `bucketCounts` (`+Inf` last). `sampleCount` is the number of
contributions folded in.

## Pipeline

1. **Capture** (second 0 of every minute). The registry is cumulative; each
   capture stores the per-series *delta* since the previous capture. A series
   whose value went down was reset and contributes its current value, never a
   negative delta. Idle series store nothing. The delta is attributed to the
   minute in which the captured interval began. Activity before the process
   booted is never attributed: boot takes a baseline.
2. **Minute rollup** (second 30). Every sealed minute is recomputed from its
   contributions and **set** — never incremented.
3. **Hour and day rollups** follow the same rule from the tier below, once
   that tier's watermark covers the whole bucket.
4. **Retention** (hourly) deletes data past its retention.

## Retries cannot double-count

Each contribution is keyed by `(sourceId, captureSeq, metric, seriesKey)`.

- A capture whose write **fails** stays in a bounded in-memory buffer and is
  retried with the *same* keys on the next capture. The baseline has already
  moved past it, so it is never recomputed.
- A write that **landed but whose acknowledgement was lost** is retried and
  skipped as a duplicate (`createMany … skipDuplicates`).
- Concurrent collections in one process are serialised.

## Late-sample policy

A contribution for minute `m` is accepted while
`now < m + 60s + METRICS_ROLLUP_LATENESS_GRACE_MS` and rejected from that
instant on (exact boundary: equal is late). Late contributions are dropped
and counted (`lateContributionsDropped` in `/metrics/rollups/status`), never
merged into an aggregate. The retry buffer holds at most 10 captures; older
ones are dropped and counted (`overflowCapturesDropped`).

## Sealing, replay and concurrency

A minute is rolled up once `now ≥ m + 60s + grace + METRICS_ROLLUP_SETTLE_DELAY_MS`
(exact boundary: equal is sealed). Because rejection starts strictly before
sealing, a sealed bucket's inputs never change after it is aggregated.

- Aggregation sorts inputs by their idempotency key before summing, so the
  result is bit-identical regardless of read order (floating-point addition is
  not associative).
- Replaying a rollup — or running it on several replicas at once — writes the
  same values: every write is a deterministic set from sealed inputs, and
  watermarks only move forward.
- Inputs whose histogram shape disagrees with their group (bucket bounds
  changed) are excluded and counted, never merged.
- A run processes a bounded number of buckets per tier; a backlog after an
  outage is absorbed over several runs.

The settle delay also absorbs clock skew between replicas. The guarantee
holds while inter-replica skew stays below the settle delay, which
[clock-skew.md](clock-skew.md) monitors.

## Retention never loses unrolled data

Each tier is deleted only below `min(now − retention, watermark of the tier
above)`. If the hour rollup stalls, minute cleanup pauses instead of deleting
minutes no hour has absorbed. Startup validation requires retention to
increase strictly from raw to day, and each tier to outlive the sealing
horizon of the tier above.

## API

Admin only (`AuthGuard` + `RoleGuard`, role `ADMIN`).

- `GET /api/v1/metrics/rollups?tier=HOUR&metric=http_requests_total&from=…&to=…`
  returns aggregates with `from ≤ bucketStart < to`, grouped by label set.
  Unknown tier or metric, an inverted range, or a span over 1 day (`MINUTE`),
  31 days (`HOUR`) or 731 days (`DAY`) is a `400`. Buckets with no activity
  are absent, not zero.
- `GET /api/v1/metrics/rollups/status` returns collector and watermark
  progress.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `METRICS_ROLLUP_ENABLED` | `true` | Switches capture, rollup and retention off. |
| `METRICS_ROLLUP_LATENESS_GRACE_MS` | `120000` | How long after a minute its contributions are accepted. |
| `METRICS_ROLLUP_SETTLE_DELAY_MS` | `30000` | Extra wait before a minute is sealed. |
| `METRICS_ROLLUP_RAW_RETENTION_HOURS` | `6` | Contribution retention. |
| `METRICS_ROLLUP_MINUTE_RETENTION_DAYS` | `3` | Minute tier retention. |
| `METRICS_ROLLUP_HOUR_RETENTION_DAYS` | `90` | Hour tier retention. |
| `METRICS_ROLLUP_DAY_RETENTION_DAYS` | `730` | Day tier retention. |

## Limitations

- Attribution is at capture granularity: activity is assigned to the minute
  its capture interval began in. With minute-aligned captures this is exact
  up to scheduler jitter.
- Histogram `count` is a 32-bit integer per bucket and series.
