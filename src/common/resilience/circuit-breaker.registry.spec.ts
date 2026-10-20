import { CircuitBreakerRegistry } from "./circuit-breaker.registry";

describe("CircuitBreakerRegistry", () => {
  it("returns the same breaker instance for a repeated name", () => {
    const registry = new CircuitBreakerRegistry();

    const first = registry.getOrCreate({ name: "horizon:testnet" });
    const second = registry.getOrCreate({ name: "horizon:testnet" });

    expect(second).toBe(first);
  });

  it("keeps distinct breakers for distinct names", () => {
    const registry = new CircuitBreakerRegistry();

    const testnet = registry.getOrCreate({ name: "horizon:testnet" });
    const mainnet = registry.getOrCreate({ name: "horizon:mainnet" });

    expect(mainnet).not.toBe(testnet);
    expect(registry.get("horizon:testnet")).toBe(testnet);
  });

  it("snapshots every circuit, sorted by name", () => {
    const registry = new CircuitBreakerRegistry();
    registry.getOrCreate({ name: "b" });
    registry.getOrCreate({ name: "a" });

    const snapshots = registry.snapshotAll();
    expect(snapshots.map((snapshot) => snapshot.name)).toEqual(["a", "b"]);
    expect(snapshots[0].state).toBe("closed");
  });

  it("returns undefined for an unregistered name", () => {
    expect(new CircuitBreakerRegistry().get("missing")).toBeUndefined();
  });
});
