import { RevocationCachePolicy } from "./revocation-cache.policy";

describe("RevocationCachePolicy", () => {
  let policy: RevocationCachePolicy;

  beforeEach(() => {
    policy = new RevocationCachePolicy();
  });

  it("caches fresh entries and returns freshness metadata", async () => {
    let fetchCount = 0;
    const fetchAuthoritative = async () => {
      fetchCount++;
      return { value: { proofId: "proof-1", valid: true }, epoch: 1 };
    };

    const first = await policy.getOrFetch("testnet", "contract-1", "proof-1", fetchAuthoritative);
    expect(first.metadata.freshness).toBe("authoritative");
    expect(first.metadata.source).toBe("contract");
    expect(fetchCount).toBe(1);

    const second = await policy.getOrFetch("testnet", "contract-1", "proof-1", fetchAuthoritative);
    expect(second.metadata.freshness).toBe("fresh");
    expect(second.metadata.source).toBe("cache");
    expect(fetchCount).toBe(1);
  });

  it("invalidates cache when contract epoch advances", async () => {
    let fetchCount = 0;
    const fetchAuthoritative = async () => {
      fetchCount++;
      return { value: { proofId: "proof-1" }, epoch: 1 };
    };

    await policy.getOrFetch("testnet", "contract-1", "proof-1", fetchAuthoritative);
    expect(fetchCount).toBe(1);

    // Advance epoch
    policy.updateContractEpoch("testnet", "contract-1", 2);

    const second = await policy.getOrFetch("testnet", "contract-1", "proof-1", fetchAuthoritative);
    expect(second.metadata.freshness).toBe("authoritative");
    expect(fetchCount).toBe(2);
  });

  it("fails closed on revocation transition event", async () => {
    let fetchCount = 0;
    const fetchAuthoritative = async () => {
      fetchCount++;
      return { value: { proofId: "proof-1", revoked: fetchCount > 1 }, epoch: 1, isRevoked: fetchCount > 1 };
    };

    await policy.getOrFetch("testnet", "contract-1", "proof-1", fetchAuthoritative);
    expect(fetchCount).toBe(1);

    // Record revocation event
    policy.recordTransitionEvent("testnet", "contract-1", "proof-1", { revoked: true });

    // Next read must fetch authoritative source immediately and not use cache
    const second = await policy.getOrFetch("testnet", "contract-1", "proof-1", fetchAuthoritative);
    expect(second.metadata.freshness).toBe("authoritative");
    expect(fetchCount).toBe(2);
  });

  it("protects against thundering herd with concurrent queries", async () => {
    let fetchCount = 0;
    const fetchAuthoritative = async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 20));
      return { value: { proofId: "proof-herd" }, epoch: 1 };
    };

    const results = await Promise.all([
      policy.getOrFetch("testnet", "contract-1", "proof-herd", fetchAuthoritative),
      policy.getOrFetch("testnet", "contract-1", "proof-herd", fetchAuthoritative),
      policy.getOrFetch("testnet", "contract-1", "proof-herd", fetchAuthoritative),
    ]);

    expect(fetchCount).toBe(1);
    expect(results).toHaveLength(3);
  });
});
