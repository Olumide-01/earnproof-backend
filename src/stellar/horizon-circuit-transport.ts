import {
  CallOutcome,
  CallResult,
} from "../common/resilience/circuit-breaker";
import { CircuitBreaker } from "../common/resilience/circuit-breaker";
import {
  HorizonHttpResponse,
  HorizonRequest,
  HorizonTransport,
} from "./horizon-transport";

/**
 * A {@link HorizonTransport} that consults a per-network circuit breaker before
 * every request, and reports each request's outcome back to it.
 *
 * ## Where this sits
 *
 * It wraps the real transport, below {@link HorizonClient} and its retry loop.
 * That placement matters: the retry loop retries a *page*, the breaker governs
 * whether the dependency should be touched *at all*. When Horizon is down, the
 * breaker opens and the very first request of the next read is refused
 * instantly — the retry loop never even starts, so a broken Horizon stops
 * costing the caller three timeouts per page.
 *
 * ## What counts against the circuit
 *
 * Horizon reports its own ill health in-band: a rate limit is a `429`, an
 * overloaded backend a `5xx`, both delivered as a resolved response rather than
 * a thrown error. Those are the outcomes that open the circuit. A `4xx` that is
 * not `429`, by contrast, means Horizon answered and *our* request was wrong —
 * the dependency is healthy — so it must never move the breaker. This is the
 * same transient-vs-permanent line the fault taxonomy draws, applied one layer
 * lower so the classification survives even when {@link HorizonClient} turns the
 * response into a fault.
 *
 * A caller cancellation is invisible to the circuit: an aborted request tells us
 * nothing about Horizon, and counting it would let a burst of client
 * disconnects open a circuit against a perfectly healthy dependency.
 */
export class CircuitHorizonTransport implements HorizonTransport {
  constructor(
    private readonly inner: HorizonTransport,
    private readonly breaker: CircuitBreaker,
  ) {}

  async get(request: HorizonRequest): Promise<HorizonHttpResponse> {
    return this.breaker.run(
      () => this.inner.get(request),
      (result) => this.classify(request, result),
    );
  }

  private classify(
    request: HorizonRequest,
    result: CallResult<HorizonHttpResponse>,
  ): CallOutcome {
    if (result.ok) {
      const { status } = result.value;
      // 429 and 5xx are Horizon reporting its own overload or failure.
      if (status === 429 || status >= 500) return "trip";
      // Any other status — 2xx, 3xx, or a 4xx that is our fault — means Horizon
      // answered. The dependency is healthy regardless of the verdict.
      return "success";
    }

    // A cancelled request is the caller's decision, not Horizon's health.
    if (request.signal?.aborted) return "ignore";

    // Everything else that escapes the transport — a timeout, a reset
    // connection, a DNS failure — is the dependency failing to answer.
    return "trip";
  }
}
