import {
  CheckpointClaim,
  DIVERGENCE_REASONS,
  checkpointDivergence,
  isReadOrdered,
  ledgerSequenceFromPagingToken,
  newestAnchor,
  pagingTokenFloorForLedger,
  reconciliationCoverageLedger,
  reconciliationFloorLedger,
  replacedOperationIds,
} from "./ledger-finality";
import { NormalizedPayment } from "./stellar.types";

/** A real-shaped TOID: ledger in the high 32 bits, then tx order and op index. */
function toid(ledger: number, tx = 1, op = 1): string {
  return ((BigInt(ledger) << BigInt(32)) | (BigInt(tx) << BigInt(12)) | BigInt(op)).toString();
}

function payment(ledger: number, overrides: Partial<NormalizedPayment> = {}): NormalizedPayment {
  const pagingToken = toid(ledger);
  return {
    operationId: pagingToken,
    pagingToken,
    stellarTransactionHash: `tx-${ledger}`,
    sourceAddress: "GSENDER",
    destinationAddress: "GRECEIVER",
    assetCode: "XLM",
    assetIssuer: null,
    amount: "1.0000000",
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const checkpoint: CheckpointClaim = {
  pagingToken: toid(500),
  operationId: toid(500),
  transactionHash: "tx-500",
  ledgerSequence: 500,
  ledgerHash: HASH_A,
};

describe("ledgerSequenceFromPagingToken", () => {
  it("decodes the ledger from a TOID", () => {
    expect(ledgerSequenceFromPagingToken(toid(1))).toBe(1);
    expect(ledgerSequenceFromPagingToken(toid(54_321_000, 7, 3))).toBe(54_321_000);
  });

  it("accepts the largest ledger a signed 32-bit column can hold", () => {
    expect(ledgerSequenceFromPagingToken(toid(0x7fffffff))).toBe(0x7fffffff);
  });

  it.each([
    ["ledger zero", "91000000"],
    ["a ledger beyond the column range", toid(0x80000000)],
    ["a non-numeric token", "abc"],
    ["a negative token", "-4294967296"],
    ["a token over 64 bits", "18446744073709551616"],
    ["an empty token", ""],
    ["an absent token", undefined],
    ["a null token", null],
  ])("rejects %s", (_label, token) => {
    expect(ledgerSequenceFromPagingToken(token as string | undefined | null)).toBeNull();
  });
});

describe("pagingTokenFloorForLedger", () => {
  it("is the lowest token in the ledger and above every token of the previous one", () => {
    const floor = BigInt(pagingTokenFloorForLedger(500));
    expect(floor <= BigInt(toid(500, 0, 0))).toBe(true);
    expect(floor > BigInt(toid(499, 0xfffff, 0xfff))).toBe(true);
  });

  it("never goes below ledger one", () => {
    expect(pagingTokenFloorForLedger(0)).toBe(pagingTokenFloorForLedger(1));
    expect(pagingTokenFloorForLedger(-10)).toBe(pagingTokenFloorForLedger(1));
  });
});

describe("reconciliationFloorLedger", () => {
  it("reaches back the configured window", () => {
    expect(reconciliationFloorLedger(1_000, 100)).toBe(900);
  });

  it("clamps at ledger one when the window predates genesis", () => {
    expect(reconciliationFloorLedger(50, 100)).toBe(1);
  });

  it("treats a zero, negative or non-finite window as the checkpoint ledger alone", () => {
    expect(reconciliationFloorLedger(1_000, 0)).toBe(1_000);
    expect(reconciliationFloorLedger(1_000, -5)).toBe(1_000);
    expect(reconciliationFloorLedger(1_000, Number.NaN)).toBe(1_000);
  });
});

describe("checkpointDivergence", () => {
  const ledger = { sequence: 500, hash: HASH_A };
  const operation = {
    id: checkpoint.operationId,
    pagingToken: checkpoint.pagingToken,
    transactionHash: checkpoint.transactionHash,
  };

  it("accepts a checkpoint Horizon still agrees with", () => {
    expect(checkpointDivergence(checkpoint, ledger, operation)).toBeNull();
  });

  it("compares ledger hashes case-insensitively", () => {
    expect(
      checkpointDivergence(checkpoint, { sequence: 500, hash: HASH_A.toUpperCase() }, operation),
    ).toBeNull();
  });

  it("detects a replaced ledger", () => {
    expect(checkpointDivergence(checkpoint, { sequence: 500, hash: HASH_B }, operation)).toBe(
      "ledger_hash_mismatch",
    );
  });

  it("detects a ledger Horizon no longer has", () => {
    expect(checkpointDivergence(checkpoint, null, operation)).toBe("ledger_missing");
  });

  it("detects a ledger answered for the wrong sequence", () => {
    expect(checkpointDivergence(checkpoint, { sequence: 501, hash: HASH_A }, operation)).toBe(
      "ledger_missing",
    );
  });

  it("reports the ledger before the operation when both changed", () => {
    expect(checkpointDivergence(checkpoint, { sequence: 500, hash: HASH_B }, null)).toBe(
      "ledger_hash_mismatch",
    );
  });

  it("detects a missing checkpoint record", () => {
    expect(checkpointDivergence(checkpoint, ledger, null)).toBe("checkpoint_record_missing");
  });

  it.each([
    ["transaction", { transactionHash: "tx-other" }],
    ["paging position", { pagingToken: toid(500, 2) }],
    ["identity", { id: "other-op" }],
  ])("detects a checkpoint record with a different %s", (_label, change) => {
    expect(checkpointDivergence(checkpoint, ledger, { ...operation, ...change })).toBe(
      "checkpoint_record_replaced",
    );
  });

  it("names every reason it can return", () => {
    expect(DIVERGENCE_REASONS).toEqual(
      expect.arrayContaining([
        "ledger_hash_mismatch",
        "ledger_missing",
        "checkpoint_record_missing",
        "checkpoint_record_replaced",
        "out_of_order",
        "record_replaced",
      ]),
    );
  });
});

describe("isReadOrdered", () => {
  it("accepts a strictly ascending forward read past the checkpoint", () => {
    expect(isReadOrdered([payment(501), payment(502)], "asc", toid(500))).toBe(true);
  });

  it("accepts an empty read", () => {
    expect(isReadOrdered([], "asc", toid(500))).toBe(true);
    expect(isReadOrdered([], "desc")).toBe(true);
  });

  it("rejects a forward read that returns the checkpoint itself", () => {
    expect(isReadOrdered([payment(500)], "asc", toid(500))).toBe(false);
  });

  it("rejects a forward read that returns records behind the checkpoint", () => {
    expect(isReadOrdered([payment(499)], "asc", toid(500))).toBe(false);
  });

  it("rejects a reordered forward read", () => {
    expect(isReadOrdered([payment(502), payment(501)], "asc", toid(500))).toBe(false);
  });

  it("accepts a strictly descending read", () => {
    expect(isReadOrdered([payment(502), payment(501), payment(500)], "desc")).toBe(true);
  });

  it("rejects a reordered newest-first read", () => {
    expect(isReadOrdered([payment(500), payment(502)], "desc")).toBe(false);
  });

  it("rejects equal tokens, which only a corrupt feed can produce", () => {
    const token = toid(501);
    expect(
      isReadOrdered(
        [payment(501), payment(501, { operationId: "other", pagingToken: token })],
        "desc",
      ),
    ).toBe(false);
  });

  it("rejects a record without a paging position", () => {
    expect(isReadOrdered([payment(501, { pagingToken: undefined })], "asc", toid(500))).toBe(
      false,
    );
  });
});

describe("replacedOperationIds", () => {
  const stored = new Map([
    ["op-1", { transactionHash: "tx-1", userId: "user_1" }],
    ["op-2", { transactionHash: "tx-2", userId: "user_1" }],
    ["op-3", { transactionHash: "tx-3", userId: "user_2" }],
  ]);

  it("ignores operations that still match and operations never stored", () => {
    expect(
      replacedOperationIds(
        [
          { operationId: "op-1", stellarTransactionHash: "tx-1" },
          { operationId: "op-new", stellarTransactionHash: "tx-new" },
        ],
        stored,
        "user_1",
      ),
    ).toEqual([]);
  });

  it("flags an operation now in a different transaction", () => {
    expect(
      replacedOperationIds([{ operationId: "op-2", stellarTransactionHash: "tx-x" }], stored, "user_1"),
    ).toEqual(["op-2"]);
  });

  it("flags an operation position that now pays a different owner", () => {
    expect(
      replacedOperationIds([{ operationId: "op-3", stellarTransactionHash: "tx-3" }], stored, "user_1"),
    ).toEqual(["op-3"]);
  });

  it("is independent of input order", () => {
    const incoming = [
      { operationId: "op-3", stellarTransactionHash: "tx-3" },
      { operationId: "op-2", stellarTransactionHash: "tx-x" },
    ];
    expect(replacedOperationIds(incoming, stored, "user_1")).toEqual(
      replacedOperationIds([...incoming].reverse(), stored, "user_1"),
    );
  });
});

describe("newestAnchor", () => {
  it("picks the furthest record regardless of array order", () => {
    const records = [payment(501), payment(503), payment(502)];
    expect(newestAnchor(records)?.pagingToken).toBe(toid(503));
    expect(newestAnchor([...records].reverse())?.pagingToken).toBe(toid(503));
  });

  it("skips records whose token encodes no ledger", () => {
    expect(newestAnchor([payment(1, { pagingToken: "91000000" })])).toBeNull();
    expect(newestAnchor([])).toBeNull();
  });
});

describe("reconciliationCoverageLedger", () => {
  it.each(["exhausted", "ledger_bound"])("covers down to the floor when the read %s", (stop) => {
    expect(reconciliationCoverageLedger([payment(900)], stop, 100)).toBe(100);
  });

  it("covers only the ledgers above the oldest record when a bound cut the read", () => {
    // The page bound may have split ledger 600, so 600 itself is undecided.
    expect(reconciliationCoverageLedger([payment(900), payment(600)], "page_bound", 100)).toBe(601);
  });

  it("never reports coverage below the floor", () => {
    expect(reconciliationCoverageLedger([payment(50)], "record_bound", 100)).toBe(100);
  });

  it("proves nothing when a bounded read saw no positioned record", () => {
    expect(reconciliationCoverageLedger([], "page_bound", 100)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
