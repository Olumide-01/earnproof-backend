/**
 * Bounded exponential backoff with jitter.
 *
 * Two failures at the same instant retried on the same deterministic schedule
 * retry again at the same instant, and again, and again — a thundering herd that
 * synchronises every worker onto the same retry ticks and hammers a recovering
 * dependency in lockstep. Jitter breaks the synchronisation by spreading retries
 * across a window instead of a point.
 *
 * The schedule is "full jitter": the delay is a uniform random value in
 * `[0, cap]`, where `cap` is the exponential term clamped to {@link maxDelayMs}.
 * Full jitter spreads retries the most and is the variant AWS's own guidance
 * settled on; the alternatives (equal jitter, decorrelated) trade a little
 * spread for a higher floor, which is not worth it inside a request-bound retry.
 *
 * Randomness is injected so tests are deterministic: pass a fixed `random` and
 * the delay is exact.
 */

export interface BackoffOptions {
  /** Delay for attempt 1's retry, before jitter. Doubles each attempt. */
  readonly baseMs: number;
  /** Ceiling the exponential term is clamped to before jitter is applied. */
  readonly maxDelayMs: number;
  /** Injected source of [0, 1). Defaults to `Math.random`. */
  readonly random?: () => number;
}

/**
 * Delay in milliseconds before retrying after `attempt` failed attempts.
 *
 * `attempt` is 1-based: `1` is the wait after the first failure. The returned
 * value is always a non-negative integer no larger than `maxDelayMs`.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions): number {
  const random = options.random ?? Math.random;

  // Clamp the exponent before computing the power: 2 ** 60 is Infinity, and a
  // long-lived retry loop must not overflow into a NaN delay.
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  const uncapped = options.baseMs * 2 ** exponent;
  const cap = Math.min(uncapped, options.maxDelayMs);

  // Full jitter: uniform in [0, cap]. `random()` is in [0, 1), so the result is
  // in [0, cap); flooring keeps it an integer millisecond count.
  return Math.floor(random() * cap);
}
