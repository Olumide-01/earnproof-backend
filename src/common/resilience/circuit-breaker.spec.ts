import {
  CircuitBreaker,
  CircuitOpenError,
  type CallOutcome,
} from "./circuit-breaker";

/** A hand-cranked clock so every transition is pinned to an exact instant. */
class FakeClock {
  private t = 0;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Classifier used by most tests: any Error trips unless tagged otherwise. */
function classify(error: unknown): CallOutcome {
  if (error instanceof Error && error.message === "ignore") return "ignore";
  return "trip";
}

const ok = () => Promise.resolve("ok");
const fail = (message = "boom") => () => Promise.reject(new Error(message));

function makeBreaker(clock: FakeClock, overrides = {}) {
  return new CircuitBreaker({
    name: "test",
    failureThreshold: 3,
    openDurationMs: 1_000,
    halfOpenMaxProbes: 1,
    successThreshold: 2,
    now: clock.now,
    ...overrides,
  });
}

describe("CircuitBreaker", () => {
  describe("closed state", () => {
    it("passes calls through and returns their result", async () => {
      const breaker = makeBreaker(new FakeClock());
      await expect(breaker.execute(ok, classify)).resolves.toBe("ok");
      expect(breaker.snapshot().state).toBe("closed");
    });

    it("opens only after the failure threshold of consecutive trips", async () => {
      const breaker = makeBreaker(new FakeClock());

      await expect(breaker.execute(fail(), classify)).rejects.toThrow("boom");
      await expect(breaker.execute(fail(), classify)).rejects.toThrow("boom");
      expect(breaker.snapshot().state).toBe("closed");
      expect(breaker.snapshot().consecutiveFailures).toBe(2);

      await expect(breaker.execute(fail(), classify)).rejects.toThrow("boom");
      expect(breaker.snapshot().state).toBe("open");
    });

    it("resets the failure streak on any success", async () => {
      const breaker = makeBreaker(new FakeClock());

      await expect(breaker.execute(fail(), classify)).rejects.toThrow();
      await expect(breaker.execute(fail(), classify)).rejects.toThrow();
      await breaker.execute(ok, classify);

      expect(breaker.snapshot().consecutiveFailures).toBe(0);

      // Two more trips must not open it: the streak restarted from zero.
      await expect(breaker.execute(fail(), classify)).rejects.toThrow();
      await expect(breaker.execute(fail(), classify)).rejects.toThrow();
      expect(breaker.snapshot().state).toBe("closed");
    });

    it("never opens on ignored (validation/authorization) failures", async () => {
      const breaker = makeBreaker(new FakeClock());

      for (let i = 0; i < 10; i += 1) {
        await expect(breaker.execute(fail("ignore"), classify)).rejects.toThrow(
          "ignore",
        );
      }

      expect(breaker.snapshot().state).toBe("closed");
      expect(breaker.snapshot().consecutiveFailures).toBe(0);
    });
  });

  describe("open state", () => {
    it("refuses calls without invoking the operation", async () => {
      const clock = new FakeClock();
      const breaker = makeBreaker(clock);
      await open(breaker);

      const operation = jest.fn(ok);
      await expect(breaker.execute(operation, classify)).rejects.toBeInstanceOf(
        CircuitOpenError,
      );
      expect(operation).not.toHaveBeenCalled();
    });

    it("reports a shrinking cooldown while open", async () => {
      const clock = new FakeClock();
      const breaker = makeBreaker(clock);
      await open(breaker);

      expect(breaker.snapshot().cooldownRemainingMs).toBe(1_000);
      clock.advance(400);
      expect(breaker.snapshot().cooldownRemainingMs).toBe(600);
    });
  });

  describe("half-open state", () => {
    it("admits a probe once the cooldown elapses", async () => {
      const clock = new FakeClock();
      const breaker = makeBreaker(clock);
      await open(breaker);

      clock.advance(1_000);
      const operation = jest.fn(ok);
      await breaker.execute(operation, classify);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("closes after the success threshold of probes", async () => {
      const clock = new FakeClock();
      const breaker = makeBreaker(clock);
      await open(breaker);
      clock.advance(1_000);

      await breaker.execute(ok, classify);
      expect(breaker.snapshot().state).toBe("half_open");
      await breaker.execute(ok, classify);
      expect(breaker.snapshot().state).toBe("closed");
    });

    it("re-opens on a single probe failure and starts a fresh cooldown", async () => {
      const clock = new FakeClock();
      const breaker = makeBreaker(clock);
      await open(breaker);
      clock.advance(1_000);

      await expect(breaker.execute(fail(), classify)).rejects.toThrow("boom");
      expect(breaker.snapshot().state).toBe("open");
      expect(breaker.snapshot().cooldownRemainingMs).toBe(1_000);
    });

    it("bounds concurrent probes to halfOpenMaxProbes", async () => {
      const clock = new FakeClock();
      const breaker = makeBreaker(clock);
      await open(breaker);
      clock.advance(1_000);

      // Hold the first probe open so the slot is not yet released.
      let releaseProbe!: () => void;
      const gated = new Promise<string>((resolve) => {
        releaseProbe = () => resolve("ok");
      });
      const first = breaker.execute(() => gated, classify);

      // A second concurrent probe finds the single slot taken and is refused
      // without touching the dependency.
      const operation = jest.fn(ok);
      await expect(breaker.execute(operation, classify)).rejects.toBeInstanceOf(
        CircuitOpenError,
      );
      expect(operation).not.toHaveBeenCalled();

      releaseProbe();
      await first;
      // The slot is released, so the next probe is admitted.
      await expect(breaker.execute(ok, classify)).resolves.toBe("ok");
    });

    it("ignored errors during half-open neither close nor re-open it", async () => {
      const clock = new FakeClock();
      const breaker = makeBreaker(clock);
      await open(breaker);
      clock.advance(1_000);

      await expect(breaker.execute(fail("ignore"), classify)).rejects.toThrow(
        "ignore",
      );
      // Still half-open: the ignored error said nothing about recovery, and the
      // probe slot was released so a real probe can still be admitted.
      expect(breaker.snapshot().state).toBe("half_open");
      await expect(breaker.execute(ok, classify)).resolves.toBe("ok");
    });
  });

  describe("nested breakers", () => {
    it("passes a CircuitOpenError through without recording it as a failure", async () => {
      const breaker = makeBreaker(new FakeClock());

      const refuse = () =>
        Promise.reject(new CircuitOpenError("inner", "open"));
      for (let i = 0; i < 5; i += 1) {
        await expect(breaker.execute(refuse, classify)).rejects.toBeInstanceOf(
          CircuitOpenError,
        );
      }

      // The inner refusal is not this dependency's failure, so it never opens.
      expect(breaker.snapshot().state).toBe("closed");
      expect(breaker.snapshot().consecutiveFailures).toBe(0);
    });
  });

  it("reset() forces the circuit closed", async () => {
    const clock = new FakeClock();
    const breaker = makeBreaker(clock);
    await open(breaker);
    expect(breaker.snapshot().state).toBe("open");

    breaker.reset();
    expect(breaker.snapshot().state).toBe("closed");
    await expect(breaker.execute(ok, classify)).resolves.toBe("ok");
  });
});

/** Drives a fresh breaker to the open state via its failure threshold. */
async function open(breaker: CircuitBreaker): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await breaker.execute(fail(), classify).catch(() => undefined);
  }
  expect(breaker.snapshot().state).toBe("open");
}
