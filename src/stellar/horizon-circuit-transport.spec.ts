import { CircuitBreaker, CircuitOpenError } from "../common/resilience/circuit-breaker";
import { CircuitHorizonTransport } from "./horizon-circuit-transport";
import {
  HorizonHttpResponse,
  HorizonRequest,
  HorizonTransport,
} from "./horizon-transport";

/** A transport whose every response is scripted, and which records its calls. */
class StubTransport implements HorizonTransport {
  calls = 0;
  constructor(
    private readonly script: () =>
      | HorizonHttpResponse
      | Promise<HorizonHttpResponse>,
  ) {}

  async get(): Promise<HorizonHttpResponse> {
    this.calls += 1;
    return this.script();
  }
}

class FakeClock {
  private t = 0;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

const response = (status: number): HorizonHttpResponse => ({
  status,
  body: {},
  headers: {},
});

const request = (signal?: AbortSignal): HorizonRequest => ({
  url: "https://horizon.example/accounts/x/payments",
  timeoutMs: 1_000,
  signal,
});

function build(
  clock: FakeClock,
  script: () => HorizonHttpResponse | Promise<HorizonHttpResponse>,
) {
  const inner = new StubTransport(script);
  const breaker = new CircuitBreaker({
    name: "horizon:testnet",
    failureThreshold: 3,
    openDurationMs: 1_000,
    successThreshold: 1,
    now: clock.now,
  });
  return { transport: new CircuitHorizonTransport(inner, breaker), inner, breaker };
}

describe("CircuitHorizonTransport", () => {
  it("passes a healthy response through and leaves the circuit closed", async () => {
    const { transport, breaker } = build(new FakeClock(), () => response(200));

    await expect(transport.get(request())).resolves.toMatchObject({ status: 200 });
    expect(breaker.snapshot().state).toBe("closed");
  });

  it("opens after repeated 5xx responses, then refuses without calling Horizon", async () => {
    const { transport, inner, breaker } = build(new FakeClock(), () =>
      response(503),
    );

    for (let i = 0; i < 3; i += 1) {
      await expect(transport.get(request())).resolves.toMatchObject({
        status: 503,
      });
    }
    expect(breaker.snapshot().state).toBe("open");

    const callsBefore = inner.calls;
    await expect(transport.get(request())).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    // The refused call never reached the inner transport.
    expect(inner.calls).toBe(callsBefore);
  });

  it("counts 429 rate limits toward opening the circuit", async () => {
    const { transport, breaker } = build(new FakeClock(), () => response(429));

    for (let i = 0; i < 3; i += 1) {
      await transport.get(request());
    }
    expect(breaker.snapshot().state).toBe("open");
  });

  it("never trips on a 4xx that is not a rate limit", async () => {
    const { transport, breaker } = build(new FakeClock(), () => response(400));

    for (let i = 0; i < 10; i += 1) {
      await expect(transport.get(request())).resolves.toMatchObject({
        status: 400,
      });
    }
    // Horizon answered every time; our request was wrong. Dependency is healthy.
    expect(breaker.snapshot().state).toBe("closed");
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });

  it("trips on a thrown transport error (timeout, reset connection)", async () => {
    const { transport, breaker } = build(new FakeClock(), () => {
      throw new Error("network down");
    });

    for (let i = 0; i < 3; i += 1) {
      await expect(transport.get(request())).rejects.toThrow("network down");
    }
    expect(breaker.snapshot().state).toBe("open");
  });

  it("ignores a caller cancellation — an aborted request is not Horizon's fault", async () => {
    const controller = new AbortController();
    controller.abort();
    const { transport, breaker } = build(new FakeClock(), () => {
      throw new Error("aborted");
    });

    for (let i = 0; i < 10; i += 1) {
      await expect(
        transport.get(request(controller.signal)),
      ).rejects.toThrow("aborted");
    }
    expect(breaker.snapshot().state).toBe("closed");
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });

  it("recovers via a half-open probe after the cooldown", async () => {
    const clock = new FakeClock();
    let status = 503;
    const { transport, breaker } = build(clock, () => response(status));

    for (let i = 0; i < 3; i += 1) await transport.get(request());
    expect(breaker.snapshot().state).toBe("open");

    clock.advance(1_000);
    status = 200; // Horizon has recovered.
    await expect(transport.get(request())).resolves.toMatchObject({ status: 200 });
    expect(breaker.snapshot().state).toBe("closed");
  });
});
