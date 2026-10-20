import { Injectable } from "@nestjs/common";
import {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitSnapshot,
} from "./circuit-breaker";

/**
 * Process-wide store of named circuit breakers.
 *
 * A breaker's value is entirely in being *shared*: every worker calling the same
 * dependency must consult the same circuit, or one worker's breaker opens while
 * the others keep hammering the dependency it just protected. Holding the
 * breakers in one injectable, resolved once per process, is what makes the
 * circuit a property of the dependency rather than of a call site.
 *
 * The registry also owns the read side. {@link snapshotAll} is what the health
 * diagnostics endpoint renders, so circuit state is observable without any call
 * site having to plumb its breaker through to the health module.
 */
@Injectable()
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  /**
   * Returns the breaker for `options.name`, creating it on first request.
   *
   * The options are honoured only when the breaker is first created; later
   * callers get the existing instance regardless of the options they pass. That
   * is deliberate — a shared circuit cannot have two thresholds — but it means
   * the *owner* of a dependency should be the one that first registers it, at
   * startup, so its configuration wins. Call sites that merely participate pass
   * the same name and take what they are given.
   */
  getOrCreate(options: CircuitBreakerOptions): CircuitBreaker {
    const existing = this.breakers.get(options.name);
    if (existing) return existing;

    const breaker = new CircuitBreaker(options);
    this.breakers.set(options.name, breaker);
    return breaker;
  }

  /** The breaker registered under `name`, or undefined if none is. */
  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  /**
   * Privacy-safe state of every registered circuit, sorted by name for a stable
   * diagnostics ordering. Counts and states only — never a dependency payload.
   */
  snapshotAll(): CircuitSnapshot[] {
    return [...this.breakers.values()]
      .map((breaker) => breaker.snapshot())
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Clears every breaker. For tests and deliberate operator intervention. */
  resetAll(): void {
    for (const breaker of this.breakers.values()) breaker.reset();
  }
}
