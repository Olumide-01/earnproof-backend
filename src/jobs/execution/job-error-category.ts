import { CircuitOpenError } from "../../common/resilience/circuit-breaker";
import { JobCancelledError } from "./job-execution.service";

/**
 * The bounded vocabulary of job failure categories.
 *
 * Storing a *category* rather than a message is the whole privacy story of the
 * execution history: an error message can carry a signing seed, a connection
 * string, or a subject address, none of which belongs in a durable operational
 * record. A category is a fixed, non-identifying label an operator can still
 * alert and group on. Keeping the set closed — rather than deriving free text —
 * is what makes it safe.
 */
export const JOB_ERROR_CATEGORIES = [
  "cancelled",
  "timeout",
  "circuit_open",
  "dependency_unavailable",
  "validation",
  "not_found",
  "conflict",
  "crash_recovery",
  "unknown",
] as const;

export type JobErrorCategory = (typeof JOB_ERROR_CATEGORIES)[number];

/**
 * Maps an arbitrary thrown value onto one of {@link JOB_ERROR_CATEGORIES}.
 *
 * The classification is by *type and name*, never by scanning the message: a
 * substring match on message text would be exactly the leak this exists to
 * prevent, because deciding a category from the message means reading — and
 * potentially retaining a fragment of — the very string that may hold a secret.
 * Anything unrecognised is `unknown`; that is a feature, not a gap, because an
 * unrecognised error must never be guessed into a more specific bucket.
 */
export function categorizeJobError(error: unknown): JobErrorCategory {
  if (error instanceof JobCancelledError) return "cancelled";
  if (error instanceof CircuitOpenError) return "circuit_open";

  if (error instanceof Error) {
    const name = error.name;

    // Node/undefined-fetch abort and timeout error names.
    if (name === "TimeoutError" || name === "AbortError") return "timeout";

    // NestJS HttpException subclasses expose a numeric status; map the common
    // dependency-signalling ones without reading the message.
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      if (status === 400 || status === 422) return "validation";
      if (status === 404) return "not_found";
      if (status === 409) return "conflict";
      if (status === 503 || status === 502 || status === 504) {
        return "dependency_unavailable";
      }
    }

    // A few well-known error type names, matched exactly.
    if (name === "ServiceUnavailableException") return "dependency_unavailable";
    if (name === "NotFoundException") return "not_found";
    if (name === "ConflictException") return "conflict";
    if (name === "BadRequestException") return "validation";
  }

  return "unknown";
}
