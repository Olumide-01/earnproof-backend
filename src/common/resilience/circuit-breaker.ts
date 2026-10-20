/**
 * A deterministic circuit breaker for outbound dependency calls.
 *
 * ## Why a breaker, and not just retries
 *
 * Retries answer "this call failed, might the next one succeed?". They say
 * nothing about "should I be making this call at all right now?". When a
 * dependency is already on the floor, every worker that keeps calling it — and
 * every worker that keeps *retrying* those calls — adds load to the exact system
 * that is failing, and ties up its own capacity waiting on timeouts. That is how
 * one upstream incident becomes an outage across every job that touches it.
 *
 * The breaker is the second control. Once failures cross a threshold it *opens*:
 * calls are rejected immediately, cheaply, without touching the dependency, for
 * a bounded cool-off. After the cool-off it allows a small, bounded number of
 * *probes* through (half-open); if they succeed it closes and normal traffic
 * resumes, and if they fail it re-opens. The dependency gets room to recover
 * instead of a stampede.
 *
 * ## The classification that makes it correct
 *
 * A breaker that counts *every* failure is actively harmful: a validation error
 * or an authorization rejection means the dependency answered — it is healthy —
 * so counting it toward opening the circuit would take a working dependency
 * offline because callers sent bad input. Every call therefore reports one of
 * three {@link CallOutcome}s, and only `trip` moves the breaker toward open.
 * This is the same transient-vs-permanent distinction the Horizon fault
 * taxonomy already draws, expressed as circuit policy.
 *
 * ## Determinism
 *
 * Time is injected. Given the same sequence of outcomes at the same instants,
 * the breaker takes the same transitions every run, which is what lets the
 * opening, half-open, closing, and cancellation paths be tested without sleeps
 * or wall-clock races.
 */

/** How a completed call should be counted by the breaker. */
export type CallOutcome =
  /** The dependency did its job. Closes the circuit / counts a probe success. */
  | "success"
  /**
   * The dependency itself failed transiently — timeout, 5xx, connection reset.
   * This is the only outcome that moves the breaker toward open.
   */
  | "trip"
  /**
   * The call failed, but for a reason that does not reflect dependency health:
   * a validation error, an authorization rejection, a not-found. The breaker
   * ignores it entirely — it neither opens the circuit nor counts as a probe
   * success, because a rejected-bad-request tells us nothing about recovery.
   */
  | "ignore";

export type CircuitState = "closed" | "open" | "half_open";

/** The settled result of a guarded call, for classifiers that inspect success. */
export type CallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export interface CircuitBreakerOptions {
  /** Stable, non-identifying label for this circuit (e.g. a network name). */
  readonly name: string;
  /**
   * Consecutive `trip` outcomes that open a closed circuit. The count resets on
   * any `success`, so an isolated blip never opens the circuit.
   */
  readonly failureThreshold?: number;
  /** Cool-off after opening, before the first half-open probe is allowed. */
  readonly openDurationMs?: number;
  /**
   * Probes allowed through concurrently while half-open. Kept small so recovery
   * is tested with a trickle, not a flood — see {@link tryAcquireProbe}.
   */
  readonly halfOpenMaxProbes?: number;
  /** Consecutive probe successes required to close a half-open circuit. */
  readonly successThreshold?: number;
  /** Injected clock. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Privacy-safe snapshot of a circuit. Counts and state only — never payloads. */
export interface CircuitSnapshot {
  readonly name: string;
  readonly state: CircuitState;
  /** Consecutive trip failures observed while closed. */
  readonly consecutiveFailures: number;
  /** Probe successes accumulated in the current half-open window. */
  readonly probeSuccesses: number;
  /** Probes currently in flight while half-open. */
  readonly probesInFlight: number;
  /** Total times this circuit has opened, for trend visibility. */
  readonly openCount: number;
  /** Milliseconds until the open circuit next admits a probe; 0 when not open. */
  readonly cooldownRemainingMs: number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_OPEN_DURATION_MS = 30_000;
const DEFAULT_HALF_OPEN_MAX_PROBES = 1;
const DEFAULT_SUCCESS_THRESHOLD = 2;

/**
 * Raised when a call is refused because the circuit is open, or because the
 * half-open probe budget is already spent.
 *
 * Carries no dependency payload — only the circuit name and its state — so it is
 * safe to log and to surface as a stable reason code. It is deliberately its own
 * type so callers can tell "the breaker refused this" apart from "the dependency
 * was tried and failed": the former must never be retried against the same
 * dependency, and must not itself count as a fresh failure.
 */
export class CircuitOpenError extends Error {
  readonly circuit: string;
  readonly state: CircuitState;

  constructor(circuit: string, state: CircuitState) {
    super(`Circuit "${circuit}" is ${state}; call refused`);
    this.name = "CircuitOpenError";
    this.circuit = circuit;
    this.state = state;
  }
}

export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly halfOpenMaxProbes: number;
  private readonly successThreshold: number;
  private readonly now: () => number;

  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private probeSuccesses = 0;
  private probesInFlight = 0;
  private openCount = 0;
  /** Epoch ms at which an open circuit becomes eligible for a half-open probe. */
  private openUntil = 0;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.openDurationMs = options.openDurationMs ?? DEFAULT_OPEN_DURATION_MS;
    this.halfOpenMaxProbes =
      options.halfOpenMaxProbes ?? DEFAULT_HALF_OPEN_MAX_PROBES;
    this.successThreshold = options.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD;
    this.now = options.now ?? Date.now;
  }

  /**
   * Runs `operation` under the breaker.
   *
   * `classify` turns whatever the operation threw into a {@link CallOutcome}, so
   * the breaker never has to understand dependency-specific errors: the caller
   * owns the "is this the dependency's fault?" decision and the breaker owns the
   * state machine. A thrown error is always re-thrown after being recorded — the
   * breaker changes *whether* a call is attempted, never *what* the caller sees
   * when one fails.
   *
   * @throws CircuitOpenError before `operation` runs, when the circuit refuses.
   */
  async execute<T>(
    operation: () => Promise<T>,
    classify: (error: unknown) => CallOutcome,
  ): Promise<T> {
    return this.run(operation, (result) =>
      result.ok ? "success" : classify(result.error),
    );
  }

  /**
   * Like {@link execute}, but the classifier also sees a *successful* result.
   *
   * Some dependencies report their own ill health in-band — an HTTP transport
   * resolves with a `503` rather than throwing — so "the promise resolved" is
   * not the same as "the dependency is healthy". This variant lets the caller
   * count a resolved-but-unhealthy result as a `trip` while still returning it
   * unchanged, which is exactly what wrapping a status-returning transport
   * needs.
   */
  async run<T>(
    operation: () => Promise<T>,
    classify: (result: CallResult<T>) => CallOutcome,
  ): Promise<T> {
    this.admit();

    let result: CallResult<T>;
    try {
      result = { ok: true, value: await operation() };
    } catch (error) {
      // A refusal from a *nested* breaker is not evidence about this
      // dependency; pass it straight through without recording.
      if (error instanceof CircuitOpenError) throw error;
      result = { ok: false, error };
    }

    this.record(classify(result));

    if (result.ok) return result.value;
    throw result.error;
  }

  /** Current state and counters, safe to expose in diagnostics. */
  snapshot(): CircuitSnapshot {
    // Reading the snapshot is also the moment a lapsed open circuit is observed
    // to be half-open-eligible, so diagnostics never report "open" for a
    // circuit whose cool-off has already elapsed.
    this.refresh();

    const cooldownRemainingMs =
      this.state === "open" ? Math.max(0, this.openUntil - this.now()) : 0;

    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      probeSuccesses: this.probeSuccesses,
      probesInFlight: this.probesInFlight,
      openCount: this.openCount,
      cooldownRemainingMs,
    };
  }

  /** Force the circuit closed. For tests and deliberate operator intervention. */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.probeSuccesses = 0;
    this.probesInFlight = 0;
    this.openUntil = 0;
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  /**
   * Decides whether a call may proceed, and reserves a probe slot when
   * half-open.
   *
   * Throwing here — before the operation runs — is the whole point of the open
   * state: the dependency is not touched at all.
   */
  private admit(): void {
    this.refresh();

    if (this.state === "open") {
      throw new CircuitOpenError(this.name, "open");
    }

    if (this.state === "half_open" && !this.tryAcquireProbe()) {
      // The probe budget is spent: another probe is already deciding whether
      // the dependency has recovered. Refusing the surplus is what keeps
      // half-open a trickle rather than the same flood that opened the circuit.
      throw new CircuitOpenError(this.name, "half_open");
    }
  }

  /**
   * Moves an open circuit to half-open once its cool-off has elapsed.
   *
   * This is the only place time advances the state, and it is idempotent, so
   * calling it from both {@link admit} and {@link snapshot} is safe.
   */
  private refresh(): void {
    if (this.state === "open" && this.now() >= this.openUntil) {
      this.state = "half_open";
      this.probeSuccesses = 0;
      this.probesInFlight = 0;
    }
  }

  /**
   * Reserves one of the bounded half-open probe slots.
   *
   * Single-threaded by construction: the event loop runs `admit` to completion
   * before any awaited operation resumes, so the increment and the bound check
   * cannot interleave with another call's. That is what makes "bounded and race
   * safe" hold without a lock.
   */
  private tryAcquireProbe(): boolean {
    if (this.probesInFlight >= this.halfOpenMaxProbes) return false;
    this.probesInFlight += 1;
    return true;
  }

  private record(outcome: CallOutcome): void {
    if (this.state === "half_open") {
      // Every half-open call released here reserved a slot in `admit`.
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
    }

    switch (outcome) {
      case "success":
        this.onSuccess();
        return;
      case "trip":
        this.onTrip();
        return;
      case "ignore":
        // Neither a recovery signal nor a dependency failure. A closed circuit
        // does NOT reset its failure streak on an ignored error, because an
        // ignored error is not a success; a half-open circuit does not count it
        // toward closing.
        return;
    }
  }

  private onSuccess(): void {
    if (this.state === "half_open") {
      this.probeSuccesses += 1;
      if (this.probeSuccesses >= this.successThreshold) {
        this.close();
      }
      return;
    }

    // Closed: a good call clears the failure streak so unrelated blips spread
    // over time never accumulate into an open circuit.
    this.consecutiveFailures = 0;
  }

  private onTrip(): void {
    if (this.state === "half_open") {
      // The dependency is still failing. Re-open for a fresh cool-off rather
      // than admitting more probes into a dependency that just rejected one.
      this.open();
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.state = "open";
    this.openUntil = this.now() + this.openDurationMs;
    this.openCount += 1;
    this.probeSuccesses = 0;
    this.probesInFlight = 0;
  }

  private close(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.probeSuccesses = 0;
    this.probesInFlight = 0;
    this.openUntil = 0;
  }
}
