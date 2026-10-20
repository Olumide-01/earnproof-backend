import {
  LegacyPaymentRow,
  planPaymentIdentityBackfill,
} from "./payment-identity-backfill";

function toid(ledger: number, txOrder: number, opIndex: number): string {
  return (
    (BigInt(ledger) << 32n) |
    (BigInt(txOrder) << 12n) |
    BigInt(opIndex)
  ).toString();
}

function row(overrides: Partial<LegacyPaymentRow>): LegacyPaymentRow {
  return {
    id: "p1",
    operationId: toid(1, 1, 0),
    stellarTransactionHash: "tx-1",
    operationIndex: null,
    network: null,
    ...overrides,
  };
}

describe("planPaymentIdentityBackfill", () => {
  it("resolves operation indices for TOID rows", () => {
    const plan = planPaymentIdentityBackfill(
      [
        row({ id: "a", operationId: toid(1, 1, 0), stellarTransactionHash: "tx" }),
        row({ id: "b", operationId: toid(1, 1, 1), stellarTransactionHash: "tx" }),
      ],
      "testnet",
    );
    expect(plan.ambiguous).toHaveLength(0);
    expect(plan.updates).toEqual([
      { id: "a", network: "testnet", operationIndex: 0 },
      { id: "b", network: "testnet", operationIndex: 1 },
    ]);
  });

  it("reports non-TOID rows as ambiguous instead of guessing", () => {
    const plan = planPaymentIdentityBackfill(
      [row({ id: "legacy", operationId: "hand-seeded" })],
      "testnet",
    );
    expect(plan.updates).toHaveLength(0);
    expect(plan.ambiguous).toEqual([
      { id: "legacy", reason: expect.stringContaining("hand-seeded") },
    ]);
  });

  it("reports a genuine identity collision as ambiguous", () => {
    // Two different rows deriving the same (network, tx, opIndex).
    const plan = planPaymentIdentityBackfill(
      [
        row({ id: "first", operationId: toid(2, 2, 0), stellarTransactionHash: "tx" }),
        row({ id: "second", operationId: toid(2, 2, 0), stellarTransactionHash: "tx" }),
      ],
      "testnet",
    );
    expect(plan.updates).toEqual([
      { id: "first", network: "testnet", operationIndex: 0 },
    ]);
    expect(plan.ambiguous).toEqual([
      { id: "second", reason: expect.stringContaining("already claimed") },
    ]);
  });

  it("is idempotent: rows already carrying the identity are unchanged", () => {
    const plan = planPaymentIdentityBackfill(
      [
        row({
          id: "done",
          operationId: toid(3, 1, 2),
          stellarTransactionHash: "tx",
          network: "testnet",
          operationIndex: 2,
        }),
      ],
      "testnet",
    );
    expect(plan.updates).toHaveLength(0);
    expect(plan.ambiguous).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });

  it("re-networks a row backfilled under a different network", () => {
    const plan = planPaymentIdentityBackfill(
      [
        row({
          id: "moved",
          operationId: toid(4, 1, 0),
          stellarTransactionHash: "tx",
          network: "pubnet",
          operationIndex: 0,
        }),
      ],
      "testnet",
    );
    expect(plan.updates).toEqual([
      { id: "moved", network: "testnet", operationIndex: 0 },
    ]);
  });
});
