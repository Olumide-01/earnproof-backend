import { CallOutcome } from "../common/resilience/circuit-breaker";

/**
 * Error-message substrings that indicate a *permanent* contract failure.
 *
 * A permanent error is our-fault or a settled on-chain fact — the proof is
 * already registered, the contract id is wrong, the caller is unauthorized. It
 * will never succeed on a retry, so it must be *quarantined* (failed and left
 * alone), never retried. Critically for the circuit breaker, a permanent error
 * also says nothing about whether the RPC/CLI dependency is healthy: the
 * dependency answered, and gave a definitive no. Counting it toward opening the
 * circuit would take a working dependency offline because a caller sent an
 * already-registered proof.
 *
 * Matched case-insensitively against the *sanitised* error text.
 */
export const PERMANENT_CONTRACT_ERROR_PATTERNS: readonly RegExp[] = [
  /already registered/i,
  /already exists/i,
  /proof not found/i,
  /invalid contract id/i,
  /contract not found/i,
  /unauthorized/i,
  /access denied/i,
];

/** True when a contract error is permanent and must be quarantined, not retried. */
export function isPermanentContractError(message: string): boolean {
  return PERMANENT_CONTRACT_ERROR_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
}

/**
 * Circuit-breaker classification for a thrown contract-invocation error.
 *
 * Permanent errors are `ignore`d — they are settled outcomes, not dependency
 * ill-health. Everything else (an RPC timeout, a CLI that could not reach the
 * network, a transient node failure) is a `trip`: those are exactly the
 * repeated failures that would otherwise exhaust the anchoring workers.
 */
export function classifyContractError(error: unknown): CallOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return isPermanentContractError(message) ? "ignore" : "trip";
}
