import {
  operationIndexFromToid,
  paymentIdentityKey,
  resolveLegacyOperationIndex,
} from "./operation-identity";

/**
 * Build a TOID from its parts, so tests read in terms of ledger / tx order /
 * op index rather than magic integers. Mirrors Stellar's layout:
 * (ledger << 32) | (txOrder << 12) | opIndex.
 */
function toid(ledger: number, txOrder: number, opIndex: number): string {
  return (
    (BigInt(ledger) << 32n) |
    (BigInt(txOrder) << 12n) |
    BigInt(opIndex)
  ).toString();
}

describe("operationIndexFromToid", () => {
  it("recovers the operation index encoded in a TOID", () => {
    expect(operationIndexFromToid(toid(1234, 7, 0))).toBe(0);
    expect(operationIndexFromToid(toid(1234, 7, 3))).toBe(3);
    expect(operationIndexFromToid(toid(9_999_999, 42, 99))).toBe(99);
  });

  it("distinguishes two payment operations in the same transaction", () => {
    // Same ledger and transaction order, different operation index.
    const opA = toid(5000, 1, 0);
    const opB = toid(5000, 1, 1);
    expect(opA).not.toBe(opB);
    expect(operationIndexFromToid(opA)).toBe(0);
    expect(operationIndexFromToid(opB)).toBe(1);
  });

  it("returns null for a non-TOID operation id", () => {
    expect(operationIndexFromToid("not-a-toid")).toBeNull();
    expect(operationIndexFromToid("")).toBeNull();
    expect(operationIndexFromToid("12.34")).toBeNull();
    expect(operationIndexFromToid("-5")).toBeNull();
  });

  it("returns null for an id larger than an unsigned 64-bit integer", () => {
    const tooBig = ((1n << 64n) + 1n).toString();
    expect(operationIndexFromToid(tooBig)).toBeNull();
  });
});

describe("paymentIdentityKey", () => {
  it("separates the same operation index across networks", () => {
    const base = { transactionHash: "abc", operationIndex: 1 };
    const testnet = paymentIdentityKey({ ...base, network: "testnet" });
    const pubnet = paymentIdentityKey({ ...base, network: "pubnet" });
    expect(testnet).not.toBe(pubnet);
  });

  it("collides only for the same identity", () => {
    const identity = {
      network: "testnet",
      transactionHash: "HASH",
      operationIndex: 2,
    };
    expect(paymentIdentityKey(identity)).toBe(
      paymentIdentityKey({ ...identity, transactionHash: "hash" }),
    );
    expect(paymentIdentityKey(identity)).not.toBe(
      paymentIdentityKey({ ...identity, operationIndex: 3 }),
    );
  });
});

describe("resolveLegacyOperationIndex", () => {
  it("resolves a TOID to its operation index", () => {
    expect(resolveLegacyOperationIndex(toid(10, 2, 4))).toEqual({
      kind: "resolved",
      operationIndex: 4,
    });
  });

  it("reports a non-TOID id as ambiguous rather than guessing", () => {
    const outcome = resolveLegacyOperationIndex("legacy-seed-id");
    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind === "ambiguous") {
      expect(outcome.reason).toContain("legacy-seed-id");
    }
  });
});
