import type { MetricsRegistry } from "./metrics.registry";

/**
 * The service-level indicator catalog.
 *
 * Every metric the service emits is declared here, in one place, so that the
 * set of things an operator can alert on is reviewable as a whole rather than
 * discovered by grepping call sites. The names correspond one-to-one with the
 * SLI table in `docs/observability.md`, and the runbook for each alert is
 * reachable from that table.
 *
 * Each entry names its labels explicitly. The registry rejects anything outside
 * the vocabulary in `metric-labels.ts`, so the declarations below are also the
 * proof that no SLI carries an identifying or unbounded dimension.
 */
export const METRIC_NAMES = {
  // ─── API availability and latency ───────────────────────────────────────
  httpRequestsTotal: "http_requests_total",
  httpRequestDurationMs: "http_request_duration_ms",

  // ─── Horizon sync freshness ─────────────────────────────────────────────
  horizonSyncRunsTotal: "horizon_sync_runs_total",
  horizonSyncDurationMs: "horizon_sync_duration_ms",
  horizonSyncLagSeconds: "horizon_sync_lag_seconds",

  // ─── Anchoring backlog ──────────────────────────────────────────────────
  anchoringIntentsTotal: "anchoring_intents_total",
  anchoringAttemptDurationMs: "anchoring_attempt_duration_ms",
  anchoringBacklogSize: "anchoring_backlog_size",

  // ─── Webhook delivery ───────────────────────────────────────────────────
  webhookDeliveriesTotal: "webhook_deliveries_total",
  webhookDeliveryDurationMs: "webhook_delivery_duration_ms",

  // ─── Database health ────────────────────────────────────────────────────
  databaseProbesTotal: "database_probes_total",
  databaseProbeDurationMs: "database_probe_duration_ms",

  // ─── Verification outcomes ──────────────────────────────────────────────
  verificationsTotal: "verifications_total",

  // ─── Background jobs, including retention ───────────────────────────────
  jobRunsTotal: "job_runs_total",
  jobDurationMs: "job_duration_ms",
  jobRecordsAffectedTotal: "job_records_affected_total",

  // ─── Organization quotas ────────────────────────────────────────────────
  quotaRejectionsTotal: "quota_rejections_total",

  // ─── Revocation propagation ─────────────────────────────────────────────
  revocationPropagationChecksTotal: "revocation_propagation_checks_total",
  revocationPropagationLagSeconds: "revocation_propagation_lag_seconds",
} as const;

/**
 * Registers every SLI on the supplied registry.
 *
 * Called once at module initialisation. Registration is idempotent, so a second
 * call during test setup is harmless.
 */
export function registerCoreMetrics(registry: MetricsRegistry): void {
  // ─── API availability and latency ───────────────────────────────────────
  // SLI: availability = 1 - (5xx / total). Latency read from the histogram.
  // `route` is a template and `status_class` a family, so the series count is
  // the number of routes times four, not the number of requests.
  registry.registerCounter({
    name: METRIC_NAMES.httpRequestsTotal,
    help: "HTTP requests served, by route template, method, and status family.",
    labelNames: ["route", "method", "status_class"],
  });

  registry.registerHistogram({
    name: METRIC_NAMES.httpRequestDurationMs,
    help: "HTTP request handling latency in milliseconds, by route template.",
    labelNames: ["route", "method"],
  });

  // ─── Horizon sync freshness ─────────────────────────────────────────────
  // SLI: freshness = seconds since the last successful sync. A counter of runs
  // alone cannot answer that, which is why the lag gauge exists alongside it.
  registry.registerCounter({
    name: METRIC_NAMES.horizonSyncRunsTotal,
    help: "Horizon synchronisation runs, by outcome.",
    labelNames: ["outcome"],
  });

  registry.registerHistogram({
    name: METRIC_NAMES.horizonSyncDurationMs,
    help: "Horizon synchronisation run duration in milliseconds.",
    labelNames: ["outcome"],
  });

  registry.registerHistogram({
    name: METRIC_NAMES.horizonSyncLagSeconds,
    help: "Seconds between the newest synced ledger and the observation, at sync completion.",
    labelNames: ["workflow"],
    // Freshness buckets in seconds, bracketing the 60s and 300s SLO thresholds.
    buckets: [5, 15, 30, 60, 120, 300, 600, 1_800, 3_600],
  });

  // ─── Anchoring backlog ──────────────────────────────────────────────────
  registry.registerCounter({
    name: METRIC_NAMES.anchoringIntentsTotal,
    help: "Anchoring intents reaching a terminal or retried state.",
    labelNames: ["job_result"],
  });

  registry.registerHistogram({
    name: METRIC_NAMES.anchoringAttemptDurationMs,
    help: "Duration of one anchoring attempt in milliseconds.",
    labelNames: ["outcome"],
  });

  registry.registerHistogram({
    name: METRIC_NAMES.anchoringBacklogSize,
    help: "Pending anchoring intents observed at the start of a worker poll.",
    labelNames: ["workflow"],
    // Backlog depth, not milliseconds. Bracketed around the alert threshold.
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000],
  });

  // ─── Webhook delivery ───────────────────────────────────────────────────
  // Deliberately not labelled by webhook URL or organisation: either would make
  // the series count grow with tenant count.
  registry.registerCounter({
    name: METRIC_NAMES.webhookDeliveriesTotal,
    help: "Webhook delivery attempts, by outcome and response status family.",
    labelNames: ["outcome", "status_class"],
  });

  registry.registerHistogram({
    name: METRIC_NAMES.webhookDeliveryDurationMs,
    help: "Webhook delivery round-trip duration in milliseconds.",
    labelNames: ["outcome"],
  });

  // ─── Database health ────────────────────────────────────────────────────
  registry.registerCounter({
    name: METRIC_NAMES.databaseProbesTotal,
    help: "Database connectivity probes, by verdict.",
    labelNames: ["dependency", "health"],
  });

  registry.registerHistogram({
    name: METRIC_NAMES.databaseProbeDurationMs,
    help: "Database connectivity probe duration in milliseconds.",
    labelNames: ["dependency"],
  });

  // ─── Verification outcomes ──────────────────────────────────────────────
  // The outcome enum is closed and carries no proof identity, so the
  // distribution is safe to expose. Which specific proof failed is a log
  // question, answered by correlation ID.
  registry.registerCounter({
    name: METRIC_NAMES.verificationsTotal,
    help: "Credential verification attempts, by outcome.",
    labelNames: ["verification_outcome"],
  });

  // ─── Background jobs ────────────────────────────────────────────────────
  registry.registerCounter({
    name: METRIC_NAMES.jobRunsTotal,
    help: "Scheduled job executions, by job and outcome.",
    labelNames: ["job", "outcome"],
  });

  registry.registerHistogram({
    name: METRIC_NAMES.jobDurationMs,
    help: "Scheduled job execution duration in milliseconds.",
    labelNames: ["job", "outcome"],
  });

  // Counts only. The identity of a deleted record is never a metric dimension
  // and never appears in the accompanying log line.
  registry.registerCounter({
    name: METRIC_NAMES.jobRecordsAffectedTotal,
    help: "Records affected by a scheduled job. A count only; never record content.",
    labelNames: ["job", "workflow"],
  });

  // ─── Organization quotas ────────────────────────────────────────────────
  // Separate from http_requests_total so a quota rejection is never mistaken
  // for throttling: both answer 429, only this counter names the quota.
  // Labelled by quota, never by organization — that would scale with tenants.
  registry.registerCounter({
    name: METRIC_NAMES.quotaRejectionsTotal,
    help: "Operations rejected because an organization quota was exhausted, by quota.",
    labelNames: ["quota"],
  });

  // ─── Revocation propagation ─────────────────────────────────────────────
  // Carries no proof identity: which proof is lagging is a log question,
  // answered by correlation ID, same as verificationsTotal above.
  registry.registerCounter({
    name: METRIC_NAMES.revocationPropagationChecksTotal,
    help: "Revocation propagation channel checks, by channel and observed state.",
    labelNames: ["channel", "propagation_state"],
  });

  registry.registerHistogram({
    name: METRIC_NAMES.revocationPropagationLagSeconds,
    help: "Seconds since local revocation for a channel observed not yet confirmed, at reconcile time.",
    labelNames: ["channel"],
    // Lag buckets from one minute to three days, bracketing the channels'
    // own retry/dead-letter horizons.
    buckets: [60, 300, 900, 1_800, 3_600, 21_600, 86_400, 259_200],
  });
}
