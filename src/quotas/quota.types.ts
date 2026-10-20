import { HttpException, HttpStatus } from "@nestjs/common";
import { ApiErrorCode } from "../common/dto/api-error.dto";

/**
 * Organization-scoped operational quotas.
 *
 * Two kinds, enforced differently:
 * - **Concurrent** quotas cap how many of a resource exist at once (active API
 *   keys, webhooks). They are derived from the owning table under an
 *   organization row lock, so they need no separate counter.
 * - **Windowed** quotas cap how many operations happen per fixed UTC window
 *   (proof requests per day, payment syncs per hour). They use an atomic
 *   upsert-with-limit on `OrganizationQuotaUsage`.
 */
export const QUOTA_KINDS = [
  "api_keys",
  "webhooks",
  "proof_requests",
  "sync_frequency",
] as const;

export type QuotaKind = (typeof QUOTA_KINDS)[number];
export type ConcurrentQuota = Extract<QuotaKind, "api_keys" | "webhooks">;
export type WindowedQuota = Extract<QuotaKind, "proof_requests" | "sync_frequency">;

/** ISO-8601 duration of each windowed quota's fixed window. */
export const QUOTA_WINDOWS: Record<WindowedQuota, { iso: string; ms: number }> = {
  proof_requests: { iso: "P1D", ms: 24 * 60 * 60 * 1000 },
  sync_frequency: { iso: "PT1H", ms: 60 * 60 * 1000 },
};

export interface QuotaLimits {
  api_keys: number;
  webhooks: number;
  proof_requests: number;
  sync_frequency: number;
}

/** Documented defaults; each is overridable by environment (docs/quotas.md). */
export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  api_keys: 25,
  webhooks: 10,
  proof_requests: 1_000,
  sync_frequency: 12,
};

/** Start of the fixed UTC window containing `now`. */
export function windowStart(quota: WindowedQuota, now: Date): Date {
  const ms = QUOTA_WINDOWS[quota].ms;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

const HUMAN_NAMES: Record<QuotaKind, string> = {
  api_keys: "active API key",
  webhooks: "webhook",
  proof_requests: "proof request",
  sync_frequency: "payment sync",
};

/**
 * Quota rejection. Deliberately distinct from ordinary rate limiting: same
 * 429 status, but code `QUOTA_EXCEEDED` rather than `TOO_MANY_REQUESTS`, and
 * counted on `quota_rejections_total` rather than only as an HTTP 4xx.
 */
export class QuotaExceededException extends HttpException {
  constructor(
    readonly quota: QuotaKind,
    readonly limit: number,
    readonly resetsAt: Date | null,
  ) {
    super(
      {
        code: ApiErrorCode.QUOTA_EXCEEDED,
        message: resetsAt
          ? `Organization ${HUMAN_NAMES[quota]} quota of ${limit} reached; resets at ${resetsAt.toISOString()}.`
          : `Organization ${HUMAN_NAMES[quota]} quota of ${limit} reached; remove unused resources to free capacity.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
