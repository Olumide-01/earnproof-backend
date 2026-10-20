import {
  buildCanonicalRecord,
  canonicalStringify,
  computeAuditHash,
  CURRENT_HASH_VERSION,
  GENESIS_SENTINEL,
  resolveChainKey,
  SYSTEM_CHAIN_KEY,
} from "./audit-chain";

describe("audit-chain canonicalization", () => {
  it("sorts object keys deeply regardless of insertion order", () => {
    const a = canonicalStringify({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order (order is meaningful, keys are not)", () => {
    const value = canonicalStringify({ list: [{ y: 1, x: 2 }, { z: 3 }] });
    expect(value).toBe('{"list":[{"x":2,"y":1},{"z":3}]}');
  });

  it("drops undefined values so their presence/absence does not change the hash input", () => {
    const withUndefined = canonicalStringify({ a: 1, b: undefined });
    const without = canonicalStringify({ a: 1 });
    expect(withUndefined).toBe(without);
  });

  it("excludes mutable/presentation fields (id, hash) from the canonical record", () => {
    const canonical = buildCanonicalRecord({
      chainKey: "org-1",
      sequence: BigInt(1),
      hashVersion: 1,
      actorType: "USER",
      actorId: "user-1",
      action: "DO_THING",
      resourceType: "Resource",
      resourceId: "res-1",
      metadata: { foo: "bar" },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(canonical).not.toContain('"id"');
    expect(canonical).not.toContain('"hash"');
  });
});

describe("audit-chain hashing", () => {
  const baseInput = {
    chainKey: "org-1",
    sequence: BigInt(1),
    hashVersion: CURRENT_HASH_VERSION,
    actorType: "USER",
    actorId: "user-1",
    action: "LOGIN",
    resourceType: "Session",
    resourceId: "session-1",
    metadata: { ip: "redacted" },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("produces a fixed, deterministic vector for known input (regression)", () => {
    // Locks the algorithm: sha256("GENESIS|" + canonicalJSON). If this test
    // ever needs to change, hashVersion must be bumped rather than editing
    // version 1's behavior in place, since existing stored records depend on
    // this exact output for their given inputs.
    const hash = computeAuditHash(null, baseInput);
    expect(hash).toBe(
      "6dacfaa8e9bca68fa99e4436f8e646e69a191720ef2b13147aa8fd9c219e7fd6",
    );
    expect(hash).toHaveLength(64);
  });

  it("is deterministic for identical input", () => {
    const first = computeAuditHash(null, baseInput);
    const second = computeAuditHash(null, baseInput);
    expect(first).toBe(second);
  });

  it("changes when prevHash changes (chain linkage)", () => {
    const genesisHash = computeAuditHash(null, baseInput);
    const linkedHash = computeAuditHash("some-prev-hash", baseInput);
    expect(genesisHash).not.toBe(linkedHash);
  });

  it("uses the GENESIS sentinel when prevHash is null", () => {
    const withNull = computeAuditHash(null, baseInput);
    const withSentinel = computeAuditHash(GENESIS_SENTINEL, {
      ...baseInput,
    });
    // These are NOT expected to match because computeAuditHash always
    // substitutes the sentinel for a null prevHash internally; passing the
    // literal sentinel string as `prevHash` produces the same linked string
    // and therefore the same hash.
    expect(withNull).toBe(withSentinel);
  });

  it("changes when any hashed field changes", () => {
    const base = computeAuditHash(null, baseInput);
    const changedAction = computeAuditHash(null, { ...baseInput, action: "LOGOUT" });
    const changedMetadata = computeAuditHash(null, {
      ...baseInput,
      metadata: { ip: "different" },
    });
    const changedSequence = computeAuditHash(null, {
      ...baseInput,
      sequence: BigInt(2),
    });
    expect(changedAction).not.toBe(base);
    expect(changedMetadata).not.toBe(base);
    expect(changedSequence).not.toBe(base);
  });

  it("does not change when metadata key order changes", () => {
    const a = computeAuditHash(null, {
      ...baseInput,
      metadata: { b: 1, a: 2 },
    });
    const b = computeAuditHash(null, {
      ...baseInput,
      metadata: { a: 2, b: 1 },
    });
    expect(a).toBe(b);
  });

  it("throws on an unsupported hash version", () => {
    expect(() => computeAuditHash(null, baseInput, 999)).toThrow(
      /Unsupported audit hash version/,
    );
  });
});

describe("resolveChainKey", () => {
  it("uses the organization id when present", () => {
    expect(resolveChainKey("org-1")).toBe("org-1");
  });

  it("falls back to the SYSTEM sentinel for null/undefined/empty", () => {
    expect(resolveChainKey(null)).toBe(SYSTEM_CHAIN_KEY);
    expect(resolveChainKey(undefined)).toBe(SYSTEM_CHAIN_KEY);
    expect(resolveChainKey("")).toBe(SYSTEM_CHAIN_KEY);
  });
});
