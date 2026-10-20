import { CircuitOpenError } from "../common/resilience/circuit-breaker";
import {
  classifyContractError,
  isPermanentContractError,
} from "./contract-error";

describe("isPermanentContractError", () => {
  it("recognises settled, non-retryable contract outcomes", () => {
    expect(isPermanentContractError("proof already registered")).toBe(true);
    expect(isPermanentContractError("ACCESS DENIED for source")).toBe(true);
    expect(isPermanentContractError("invalid contract id CABC")).toBe(true);
  });

  it("treats transient RPC/CLI failures as non-permanent", () => {
    expect(isPermanentContractError("rpc request timed out")).toBe(false);
    expect(isPermanentContractError("connection reset by peer")).toBe(false);
  });
});

describe("classifyContractError", () => {
  it("ignores permanent errors so they never open the circuit", () => {
    expect(classifyContractError(new Error("already exists"))).toBe("ignore");
    expect(classifyContractError(new Error("unauthorized"))).toBe("ignore");
  });

  it("trips on transient errors that indicate dependency ill-health", () => {
    expect(classifyContractError(new Error("rpc timeout"))).toBe("trip");
    expect(classifyContractError("network unreachable")).toBe("trip");
  });

  it("trips on an unrecognised error rather than assuming it is settled", () => {
    expect(classifyContractError(new CircuitOpenError("x", "open"))).toBe("trip");
    expect(classifyContractError(undefined)).toBe("trip");
  });
});
