import { HorizonClient } from "./horizon-client";
import { StellarService } from "./stellar.service";
import {
  RecordingSleep,
  ScriptedHorizonTransport,
  ScriptedStep,
} from "../testing/horizon/scripted-horizon-transport";

/**
 * The Horizon client surface that checkpoint finality depends on: forward
 * reads, the ledger-floor bound, and ledger/operation lookups.
 *
 * Scripts are inline rather than in the shared fixture file because each one
 * pins a single decision and reads better next to its assertion.
 */

const HORIZON = "https://horizon.synthetic.invalid";
const ACCOUNT = "GSYNTHETIC0RECEIVER0000000000000000000000000000000000000";
const SENDER = "GSYNTHETIC0SENDER000000000000000000000000000000000000000";
const HASH = "c".repeat(64);

function toid(ledger: number, tx = 1, op = 1): string {
  return ((BigInt(ledger) << BigInt(32)) | (BigInt(tx) << BigInt(12)) | BigInt(op)).toString();
}

function record(ledger: number, overrides: Record<string, unknown> = {}) {
  const token = toid(ledger);
  return {
    id: token,
    paging_token: token,
    type: "payment",
    transaction_hash: `tx-${ledger}`,
    created_at: "2026-01-01T00:00:00.000Z",
    from: SENDER,
    to: ACCOUNT,
    asset_type: "native",
    amount: "1.0000000",
    ...overrides,
  };
}

function page(records: unknown[], next?: string): ScriptedStep["response"] {
  return {
    status: 200,
    body: {
      _embedded: { records },
      _links: next ? { next: { href: `${HORIZON}/next?cursor=${next}` } } : {},
    },
  };
}

function client(steps: ScriptedStep[]) {
  const transport = new ScriptedHorizonTransport("inline", {
    description: "inline",
    steps,
  });
  const horizon = new HorizonClient({
    horizonUrl: HORIZON,
    transport,
    sleep: new RecordingSleep().sleep,
  });
  return { transport, horizon };
}

describe("forward reads from a checkpoint", () => {
  it("asks Horizon for ascending order and starts at the checkpoint cursor", async () => {
    const { transport, horizon } = client([
      { expectCursor: toid(500), response: page([record(501), record(502)]) },
    ]);

    const result = await horizon.listIncomingPayments(ACCOUNT, {
      order: "asc",
      cursor: toid(500),
    });

    expect(transport.requests[0].order).toBe("asc");
    expect(result.payments.map((p) => p.pagingToken)).toEqual([toid(501), toid(502)]);
    expect(result.stopReason).toBe("exhausted");
  });

  it("keeps the default newest-first order when none is given", async () => {
    const { transport, horizon } = client([{ response: page([]) }]);
    await horizon.listIncomingPayments(ACCOUNT);
    expect(transport.requests[0].order).toBe("desc");
  });

  it("does not treat an old record as a time boundary when walking forward", async () => {
    const { horizon } = client([
      {
        response: page([
          record(501, { created_at: "2020-01-01T00:00:00.000Z" }),
          record(502),
        ]),
      },
    ]);

    const result = await horizon.listIncomingPayments(ACCOUNT, {
      order: "asc",
      cursor: toid(500),
      notBefore: new Date("2025-01-01T00:00:00.000Z"),
    });

    expect(result.stopReason).toBe("exhausted");
    expect(result.payments.map((p) => p.pagingToken)).toEqual([toid(502)]);
  });

  it("does not coalesce reads that differ only in direction", async () => {
    const { transport, horizon } = client([{ response: page([]) }, { response: page([]) }]);

    await Promise.all([
      horizon.listIncomingPayments(ACCOUNT, { cursor: toid(500) }),
      horizon.listIncomingPayments(ACCOUNT, { cursor: toid(500), order: "asc" }),
    ]);

    expect(transport.requestCount).toBe(2);
  });
});

describe("ledger floor bound", () => {
  it("stops a newest-first read once records predate the floor", async () => {
    const { transport, horizon } = client([
      { response: page([record(900), record(800)], toid(800)) },
      { expectCursor: toid(800), response: page([record(700), record(99)], toid(99)) },
    ]);

    const result = await horizon.listIncomingPayments(ACCOUNT, {
      minPagingToken: toid(100, 0, 0),
    });

    expect(result.stopReason).toBe("ledger_bound");
    expect(result.payments.map((p) => p.pagingToken)).toEqual([
      toid(900),
      toid(800),
      toid(700),
    ]);
    expect(transport.unusedSteps).toBe(0);
  });

  it("is ignored on a forward read, which cannot cross a floor", async () => {
    const { horizon } = client([{ response: page([record(1)]) }]);

    const result = await horizon.listIncomingPayments(ACCOUNT, {
      order: "asc",
      minPagingToken: toid(100),
    });

    expect(result.payments).toHaveLength(1);
    expect(result.stopReason).toBe("exhausted");
  });
});

describe("paging tokens on records", () => {
  it("carries the paging token through normalisation", async () => {
    const { horizon } = client([{ response: page([record(501)]) }]);
    const result = await horizon.listIncomingPayments(ACCOUNT);
    expect(result.payments[0].pagingToken).toBe(toid(501));
  });

  it.each([
    ["non-numeric", "not-a-token"],
    ["over 64 bits", "18446744073709551616"],
    ["not a string", 42],
  ])("rejects a record whose paging token is %s as malformed", async (_label, token) => {
    const { horizon } = client([
      { response: page([record(501, { paging_token: token }), record(502)]) },
    ]);

    const result = await horizon.listIncomingPayments(ACCOUNT);

    expect(result.malformedRecords).toBe(1);
    expect(result.payments.map((p) => p.pagingToken)).toEqual([toid(502)]);
  });
});

describe("ledger lookup", () => {
  it("returns the ledger's sequence and normalised hash", async () => {
    const { transport, horizon } = client([
      { response: { status: 200, body: { sequence: 500, hash: HASH.toUpperCase() } } },
    ]);

    await expect(horizon.getLedger(500)).resolves.toEqual({ sequence: 500, hash: HASH });
    expect(new URL(transport.requests[0].url).pathname).toBe("/ledgers/500");
  });

  it("returns null when Horizon has no such ledger", async () => {
    const { horizon } = client([{ response: { status: 404, body: {} } }]);
    await expect(horizon.getLedger(500)).resolves.toBeNull();
  });

  it("retries a transient failure", async () => {
    const { transport, horizon } = client([
      { response: { status: 503, body: {} } },
      { response: { status: 200, body: { sequence: "500", hash: HASH } } },
    ]);

    await expect(horizon.getLedger(500)).resolves.toEqual({ sequence: 500, hash: HASH });
    expect(transport.requestCount).toBe(2);
  });

  it.each([
    ["a short hash", { sequence: 500, hash: "abc" }],
    ["a zero sequence", { sequence: 0, hash: HASH }],
    ["no hash", { sequence: 500 }],
    ["an array", []],
  ])("treats %s as an unreadable response", async (_label, body) => {
    const { horizon } = client([{ response: { status: 200, body } }]);
    await expect(horizon.getLedger(500)).rejects.toMatchObject({ kind: "malformed_page" });
  });
});

describe("operation lookup", () => {
  it("returns the operation's identity", async () => {
    const token = toid(500);
    const { transport, horizon } = client([
      {
        response: {
          status: 200,
          body: { id: token, paging_token: token, transaction_hash: "tx-500" },
        },
      },
    ]);

    await expect(horizon.getOperation(token)).resolves.toEqual({
      id: token,
      pagingToken: token,
      transactionHash: "tx-500",
    });
    expect(new URL(transport.requests[0].url).pathname).toBe(`/operations/${token}`);
  });

  it("returns null for an operation Horizon no longer has", async () => {
    const { horizon } = client([{ response: { status: 404, body: {} } }]);
    await expect(horizon.getOperation("1")).resolves.toBeNull();
  });

  it("encodes the operation id so it cannot redirect the request path", async () => {
    const { transport, horizon } = client([{ response: { status: 404, body: {} } }]);
    await horizon.getOperation("../accounts/x");
    expect(new URL(transport.requests[0].url).pathname).toBe("/operations/..%2Faccounts%2Fx");
  });
});

describe("StellarService finality lookups", () => {
  const config = {
    getOrThrow: jest.fn(() => HORIZON),
  };

  it("collapses a failed lookup into a dependency error", async () => {
    const { horizon } = client([
      { response: { status: 500, body: {} } },
      { response: { status: 500, body: {} } },
      { response: { status: 500, body: {} } },
    ]);
    const stellar = new StellarService(config as never, horizon);

    await expect(stellar.fetchLedger(500)).rejects.toMatchObject({ status: 503 });
  });

  it("passes an absent operation through as null", async () => {
    const { horizon } = client([{ response: { status: 404, body: {} } }]);
    const stellar = new StellarService(config as never, horizon);

    await expect(stellar.fetchOperation("1")).resolves.toBeNull();
  });
});
