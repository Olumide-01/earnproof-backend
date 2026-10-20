/**
 * Bounded label vocabulary for operational metrics.
 *
 * Two failure modes are prevented here, and they are different problems:
 *
 * 1. **Privacy.** A wallet address, proof ID, amount, memo, URL, signature, or
 *    raw error text must never become a metric dimension. Metrics are scraped,
 *    retained, and often shipped to third-party systems with weaker access
 *    controls than the database.
 *
 * 2. **Cardinality.** A label whose value set is unbounded multiplies series
 *    without limit. Even a privacy-safe identifier such as a request ID would
 *    make the metric useless and the backend expensive.
 *
 * Both are enforced at registration time rather than by convention, because a
 * convention that is only documented is a convention that eventually gets
 * violated by a well-meaning change under time pressure.
 */

/**
 * Label names permitted on operational metrics, each with the closed set of
 * values it may take.
 *
 * Adding an entry is a deliberate act: the value set must be finite, small, and
 * knowable at code-review time. If you cannot write the values down, the
 * dimension does not belong in a metric.
 */
export const ALLOWED_METRIC_LABELS = {
  /** Logical workflow the measurement belongs to. */
  workflow: [
    "auth",
    "horizon_sync",
    "anchoring",
    "credentials",
    "webhooks",
    "proofs",
    "retention",
  ],

  /** Coarse outcome. Never a message, never an error class name. */
  outcome: ["success", "client_error", "server_error", "rejected", "timeout"],

  /**
   * HTTP status family, not the status code. `2xx` has five possible values
   * where a raw code has dozens and invites per-code alerting on noise.
   */
  status_class: ["2xx", "3xx", "4xx", "5xx"],

  /**
   * Route template — never a concrete path. `/proofs/:id` is bounded by the
   * number of routes; `/proofs/abc123` is bounded by the number of proofs.
   */
  route: [
    "/health",
    "/auth/challenge",
    "/auth/verify",
    "/auth/logout",
    "/auth/rotate",
    "/auth/sessions",
    "/organizations",
    "/issuers",
    "/payments",
    "/proofs",
    "/proof-shares",
    "/credentials",
    "/trusted-sources",
    "/api-keys",
    "/webhooks",
    "other",
  ],

  /** HTTP method. Closed by the specification. */
  method: ["GET", "POST", "PATCH", "PUT", "DELETE"],

  /** Background job identity. */
  job: [
    "anchoring_worker",
    "anchoring_reconciler",
    "session_cleanup",
    "retention_cleanup",
    "revocation_propagation_reconciler",
  ],

  /** Terminal state of a queued or retried unit of work. */
  job_result: ["completed", "retried", "failed_permanent", "skipped"],

  /** Revocation propagation channel. */
  channel: ["anchoring", "webhook"],

  /** Observed state of one revocation-propagation channel at reconcile time. */
  propagation_state: ["confirmed", "pending", "remediated"],

  /** Verification outcome, mirroring the persisted enum. */
  verification_outcome: ["valid", "invalid", "expired", "revoked", "not_found"],

  /** Dependency being probed by a health check. */
  dependency: ["database", "horizon", "stellar_rpc"],

  /** Health verdict. */
  health: ["up", "down", "degraded"],

  /** Organization operational quota. Names the quota, never the tenant. */
  quota: ["api_keys", "webhooks", "proof_requests", "sync_frequency"],
} as const;

export type MetricLabelName = keyof typeof ALLOWED_METRIC_LABELS;

/** A label set that has been validated against {@link ALLOWED_METRIC_LABELS}. */
export type MetricLabels = Partial<Record<MetricLabelName, string>>;

/**
 * Label names that are explicitly forbidden, listed so that an attempt to use
 * one produces an error naming the privacy rule rather than a generic
 * "unknown label" message.
 *
 * This is a usability affordance, not the security boundary — the allowlist
 * above is what actually enforces the rule. Anything absent from the allowlist
 * is rejected whether or not it appears here.
 */
export const FORBIDDEN_METRIC_LABELS = new Set<string>([
  // Directly identifying
  "wallet",
  "wallet_address",
  "walletaddress",
  "wallet_hash",
  "address",
  "subject",
  "user",
  "user_id",
  "userid",
  "account",
  // Resource identifiers — unbounded even when hashed
  "proof",
  "proof_id",
  "proofid",
  "credential",
  "credential_hash",
  "commitment",
  "payment_id",
  "transaction_hash",
  "tx_hash",
  "operation_id",
  "session",
  "session_id",
  "token",
  "token_hash",
  "api_key",
  "request_id",
  "requestid",
  "correlation_id",
  "trace_id",
  // Financial and free-form content
  "amount",
  "balance",
  "asset_amount",
  "memo",
  "message",
  "note",
  "description",
  // Network and cryptographic material
  "url",
  "endpoint",
  "webhook_url",
  "host",
  "ip",
  "ip_address",
  "user_agent",
  "signature",
  "secret",
  "nonce",
  // Raw error surfaces
  "error",
  "error_message",
  "exception",
  "stack",
  "reason",
  "detail",
]);

/** Raised when a metric is registered or observed with an unusable label set. */
export class InvalidMetricLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMetricLabelError";
  }
}

/**
 * Validates a label set, throwing {@link InvalidMetricLabelError} on the first
 * problem found.
 *
 * Throwing rather than dropping the label is deliberate. A silently discarded
 * dimension produces a metric that looks correct in a dashboard while measuring
 * something other than what its name claims; the failure surfaces in the test
 * suite instead.
 */
export function assertValidLabels(
  labels: Record<string, string> | undefined,
): asserts labels is MetricLabels | undefined {
  if (labels === undefined) return;

  for (const [name, value] of Object.entries(labels)) {
    const normalised = name.toLowerCase();

    if (FORBIDDEN_METRIC_LABELS.has(normalised)) {
      throw new InvalidMetricLabelError(
        `Label "${name}" is forbidden: it carries identifying or unbounded data. ` +
          `Use a request-scoped log field for correlation instead of a metric label.`,
      );
    }

    if (!isAllowedLabelName(normalised)) {
      throw new InvalidMetricLabelError(
        `Label "${name}" is not in the allowed vocabulary. ` +
          `Add it to ALLOWED_METRIC_LABELS with an explicit, finite value set ` +
          `if it is genuinely low-cardinality and privacy-safe.`,
      );
    }

    const permitted = ALLOWED_METRIC_LABELS[normalised] as readonly string[];
    if (!permitted.includes(value)) {
      throw new InvalidMetricLabelError(
        `Value "${value}" is not permitted for label "${name}". ` +
          `Allowed values: ${permitted.join(", ")}.`,
      );
    }
  }
}

/** Narrowing helper for {@link assertValidLabels}. */
function isAllowedLabelName(name: string): name is MetricLabelName {
  return Object.prototype.hasOwnProperty.call(ALLOWED_METRIC_LABELS, name);
}

/**
 * Total number of distinct series a metric could produce given a set of label
 * names — the product of each label's permitted value count.
 *
 * Used by the registry to reject a metric whose theoretical series count is
 * already unreasonable before a single observation is recorded.
 */
export function maxSeriesFor(labelNames: readonly MetricLabelName[]): number {
  return labelNames.reduce(
    (product, name) => product * ALLOWED_METRIC_LABELS[name].length,
    1,
  );
}

/**
 * Maps a concrete request path to a bounded `route` label value.
 *
 * Anything unrecognised collapses to `other` rather than being passed through,
 * so an unmatched or attacker-supplied path cannot create a new series.
 */
export function toRouteLabel(path: string): string {
  const routes = ALLOWED_METRIC_LABELS.route;
  const normalised = path.split("?")[0].replace(/\/+$/, "") || "/";

  // Longest match first so `/auth/sessions` is not shadowed by a shorter prefix.
  const candidates = [...routes]
    .filter((route) => route !== "other")
    .sort((a, b) => b.length - a.length);

  for (const route of candidates) {
    if (normalised === route || normalised.startsWith(`${route}/`)) {
      return route;
    }
  }

  return "other";
}

/** Maps an HTTP status code to its bounded `status_class` label value. */
export function toStatusClass(statusCode: number): string {
  if (statusCode >= 500) return "5xx";
  if (statusCode >= 400) return "4xx";
  if (statusCode >= 300) return "3xx";
  return "2xx";
}
