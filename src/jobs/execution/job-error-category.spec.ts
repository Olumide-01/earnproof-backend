import { CircuitOpenError } from "../../common/resilience/circuit-breaker";
import { categorizeJobError } from "./job-error-category";
import { JobCancelledError } from "./job-execution.service";

describe("categorizeJobError", () => {
  it("classifies known error types without reading their message", () => {
    expect(categorizeJobError(new JobCancelledError())).toBe("cancelled");
    expect(categorizeJobError(new CircuitOpenError("horizon", "open"))).toBe(
      "circuit_open",
    );

    const timeout = new Error("secret in message");
    timeout.name = "TimeoutError";
    expect(categorizeJobError(timeout)).toBe("timeout");
  });

  it("maps HTTP-status-bearing errors to dependency categories", () => {
    const make = (status: number) =>
      Object.assign(new Error("GABC...secret"), { status });
    expect(categorizeJobError(make(503))).toBe("dependency_unavailable");
    expect(categorizeJobError(make(404))).toBe("not_found");
    expect(categorizeJobError(make(409))).toBe("conflict");
    expect(categorizeJobError(make(400))).toBe("validation");
  });

  it("maps well-known NestJS exception names", () => {
    const named = (name: string) => {
      const error = new Error("payload");
      error.name = name;
      return error;
    };
    expect(categorizeJobError(named("ServiceUnavailableException"))).toBe(
      "dependency_unavailable",
    );
    expect(categorizeJobError(named("NotFoundException"))).toBe("not_found");
  });

  it("falls back to unknown rather than guessing from the message", () => {
    expect(categorizeJobError(new Error("timeout happened"))).toBe("unknown");
    expect(categorizeJobError("a bare string with a G-address")).toBe("unknown");
    expect(categorizeJobError(undefined)).toBe("unknown");
  });
});
