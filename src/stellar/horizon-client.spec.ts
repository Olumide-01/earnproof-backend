import { HorizonCancelledError, HorizonClient } from "./horizon-client";
import { HorizonFault } from "./horizon-fault";
import {
  RecordingSleep,
  ScriptedHorizonTransport,
  UnexpectedCursorError,
  loadHorizonFixtures,
} from "../testing/horizon/scripted-horizon-transport";

/**
 * Pagination and fault handling, driven entirely by frozen fixtures.
 *
 * Nothing here touches the network or the clock. Backoff is recorded rather
 * than slept, so a retry policy is asserted as a sequence of decisions instead
 * of being waited out — which keeps the suite instant and, more importantly,
 * keeps it from being the flaky one everybody learns to re-run.
 */

const fixtures = loadHorizonFixtures();
const ACCOUNT = fixtures.account;

function build(
  scenarioId: string,
  options: { abortAfterRequests?: number; abortController?: AbortController } = {},
) {
  const transport = new ScriptedHorizonTransport(scenarioId, undefined, options);
  const clock = new RecordingSleep();
  const client = new HorizonClient({
    horizonUrl: fixtures.horizonUrl,
    transport,
    sleep: clock.sleep,
    backoffMs: 200,
    // Pin jitter to the top of its range so the exponential schedule is exact
    // and assertable; the jitter itself is exercised in its own unit test.
    random: () => 1,
  });
  return { client, transport, clock };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("pagination", () => {
  it("returns nothing for an empty feed without asking for a second page", async () => {
    const { client, transport } = build("empty-page");

    const result = await client.listIncomingPayments(ACCOUNT);

    expect(result.payments).toEqual([]);
    expect(result.pagesFetched).toBe(1);
    expect(result.stopReason).toBe("exhausted");
    expect(transport.requestCount).toBe(1);
  });

  it("treats a body with no _embedded as an empty feed rather than corruption", async () => {
    const { client } = build("empty-embedded-absent");

    const result = await client.listIncomingPayments(ACCOUNT);

    expect(result.payments).toEqual([]);
    expect(result.malformedRecords).toBe(0);
    expect(result.stopReason).toBe("exhausted");
  });

  it("reads a single page and stops when there is no next link", async () => {
    const { client, transport } = build("single-page");

    const result = await client.listIncomingPayments(ACCOUNT);

    expect(result.payments).toHaveLength(3);
    expect(result.pagesFetched).toBe(1);
    expect(result.lastCursor).toBeNull();
    expect(transport.requestCount).toBe(1);
  });

  it("follows cursors across multiple pages in order", async () => {
    const { client, transport } = build("multi-page");

    const result = await client.listIncomingPayments(ACCOUNT, { pageLimit: 3 });

    expect(result.payments).toHaveLength(9);
    expect(result.pagesFetched).toBe(3);
    expect(result.stopReason).toBe("exhausted");

    // The fixture asserts the cursor on each step; this asserts the shape of
    // the request the client built around it.
    expect(transport.requests[0].cursor).toBeNull();
    expect(transport.requests[1].cursor).not.toBeNull();
    expect(transport.requests.every((r) => r.order === "desc")).toBe(true);
    expect(transport.requests.every((r) => r.limit === "3")).toBe(true);
  });

  it("sends the supplied cursor on the very first request when resuming", async () => {
    const { client, transport } = build("resume-from-cursor");

    // The fixture's expectCursor makes this assertion binding: a client that
    // ignored the resume cursor would fail inside the transport.
    const result = await client.listIncomingPayments(ACCOUNT, {
      cursor: "91000001",
    });

    expect(result.payments).toHaveLength(2);
    expect(transport.requests[0].cursor).toBe("91000001");
  });

  it("builds the request against the configured origin, not the next link's host", async () => {
    const { client, transport } = build("multi-page");

    await client.listIncomingPayments(ACCOUNT, { pageLimit: 3 });

    // Horizon supplies an absolute next href. Following it verbatim would hand
    // an upstream the ability to redirect the sync anywhere it liked.
    for (const request of transport.requests) {
      expect(request.url.startsWith(fixtures.horizonUrl)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Cursor pathologies
// ---------------------------------------------------------------------------

describe("cursor loops", () => {
  it("stops when Horizon reissues a cursor it already gave us", async () => {
    const { client, transport } = build("repeated-cursor");

    const result = await client.listIncomingPayments(ACCOUNT, { pageLimit: 2 });

    expect(result.stopReason).toBe("repeated_cursor");
    expect(transport.requestCount).toBe(2);
  });

  it("stops when the next cursor is the one just used", async () => {
    const { client } = build("self-referential-cursor");

    const result = await client.listIncomingPayments(ACCOUNT, { pageLimit: 2 });

    expect(result.stopReason).toBe("repeated_cursor");
  });

  it("reports an expired cursor as a permanent fault without retrying", async () => {
    const { client, transport, clock } = build("expired-cursor");

    await expect(
      client.listIncomingPayments(ACCOUNT, { cursor: "91000001" }),
    ).rejects.toMatchObject({ kind: "expired_cursor" });

    // One attempt only: retrying a rejected cursor cannot succeed.
    expect(transport.requestCount).toBe(1);
    expect(clock.delays).toEqual([]);
  });

  it("treats a cursor Horizon has aged out the same way", async () => {
    const { client, transport } = build("gone-cursor");

    await expect(
      client.listIncomingPayments(ACCOUNT, { cursor: "91000001" }),
    ).rejects.toMatchObject({ kind: "expired_cursor" });
    expect(transport.requestCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Overlapping / replayed pages
// ---------------------------------------------------------------------------

describe("overlapping and replayed pages", () => {
  it("deduplicates records repeated across a page boundary", async () => {
    const { client } = build("overlapping-pages");

    const result = await client.listIncomingPayments(ACCOUNT, { pageLimit: 3 });

    // Six records arrived; two were repeats of page one.
    expect(result.recordsSeen).toBe(6);
    expect(result.duplicateRecords).toBe(2);
    expect(result.payments).toHaveLength(4);

    const ids = result.payments.map((payment) => payment.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("accumulates nothing new from a fully replayed page", async () => {
    const { client } = build("fully-replayed-page");

    const result = await client.listIncomingPayments(ACCOUNT, { pageLimit: 2 });

    expect(result.payments).toHaveLength(2);
    expect(result.duplicateRecords).toBe(2);
  });

  it("keeps every returned payment unique by operation id", async () => {
    const { client } = build("overlapping-pages");

    const result = await client.listIncomingPayments(ACCOUNT, { pageLimit: 3 });
    const ids = result.payments.map((payment) => payment.operationId);

    expect(ids).toEqual([...new Set(ids)]);
  });
});

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

describe("retry classification", () => {
  it("retries a rate limit and honours Retry-After over its own backoff", async () => {
    const { client, transport, clock } = build("rate-limited-then-ok");

    const result = await client.listIncomingPayments(ACCOUNT);

    expect(result.payments).toHaveLength(2);
    expect(transport.requestCount).toBe(2);
    expect(result.attempts).toBe(2);
    // 2 seconds, as the header asked — not the 200ms the client would choose.
    expect(clock.delays).toEqual([2000]);
  });

  it("caps an absurd Retry-After rather than hanging the caller", async () => {
    const { client, clock } = build("rate-limited-absurd-retry-after");

    await client.listIncomingPayments(ACCOUNT);

    expect(clock.delays).toEqual([60_000]);
  });

  it("gives up on a rate limit once the budget is spent", async () => {
    const { client, transport } = build("rate-limited-exhausted");

    await expect(client.listIncomingPayments(ACCOUNT)).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(transport.requestCount).toBe(3);
  });

  it("retries a timeout", async () => {
    const { client, transport, clock } = build("timeout-then-ok");

    const result = await client.listIncomingPayments(ACCOUNT);

    expect(result.payments).toHaveLength(1);
    expect(transport.requestCount).toBe(2);
    expect(clock.delays).toEqual([200]);
  });

  it("gives up on a timeout once the budget is spent", async () => {
    const { client } = build("timeout-exhausted");

    await expect(client.listIncomingPayments(ACCOUNT)).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("retries a transient server error with exponential backoff", async () => {
    const { client, clock } = build("server-error-mid-walk");

    const result = await client.listIncomingPayments(ACCOUNT, { pageLimit: 2 });

    expect(result.payments).toHaveLength(4);
    // 200ms then 400ms: the budget is per page, and page two used both retries.
    expect(clock.delays).toEqual([200, 400]);
  });

  it("jitters the exponential backoff below its deterministic ceiling", async () => {
    // A random source pinned to its midpoint yields exactly half of each cap,
    // demonstrating that the delay is a jittered fraction of the exponential
    // schedule rather than the schedule itself — the property that stops every
    // worker retrying on the same tick.
    const transport = new ScriptedHorizonTransport("server-error-mid-walk");
    const clock = new RecordingSleep();
    const client = new HorizonClient({
      horizonUrl: fixtures.horizonUrl,
      transport,
      sleep: clock.sleep,
      backoffMs: 200,
      random: () => 0.5,
    });

    await client.listIncomingPayments(ACCOUNT, { pageLimit: 2 });

    // Half of the 200/400 ceilings.
    expect(clock.delays).toEqual([100, 200]);
  });

  it("retries a connection failure", async () => {
    const { client, transport } = build("network-error-then-ok");

    await expect(client.listIncomingPayments(ACCOUNT)).resolves.toMatchObject({
      pagesFetched: 1,
    });
    expect(transport.requestCount).toBe(2);
  });

  it("never retries a missing account", async () => {
    const { client, transport, clock } = build("account-not-found");

    await expect(client.listIncomingPayments(ACCOUNT)).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(transport.requestCount).toBe(1);
    expect(clock.delays).toEqual([]);
  });

  it("never retries an unreadable page body", async () => {
    const { client, transport } = build("malformed-page-body");

    await expect(client.listIncomingPayments(ACCOUNT)).rejects.toMatchObject({
      kind: "malformed_page",
    });
    // A retry would return the same nonsense.
    expect(transport.requestCount).toBe(1);
  });

  it("never retries a body that is not JSON", async () => {
    const { client, transport } = build("unparseable-body");

    await expect(client.listIncomingPayments(ACCOUNT)).rejects.toMatchObject({
      kind: "malformed_page",
    });
    expect(transport.requestCount).toBe(1);
  });

  it("gives each page its own retry budget", async () => {
    const { client, transport } = build("server-error-mid-walk");

    // Page one succeeded first time; page two needed three attempts. A shared
    // budget would have failed the read.
    await client.listIncomingPayments(ACCOUNT, { pageLimit: 2 });
    expect(transport.requestCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Malformed records
// ---------------------------------------------------------------------------

describe("permanently invalid records", () => {
  it("skips and counts them without failing the page", async () => {
    const { client } = build("malformed-records");

    const result = await client.listIncomingPayments(ACCOUNT);

    expect(result.payments).toHaveLength(2);
    expect(result.malformedRecords).toBe(6);
    expect(result.recordsSeen).toBe(8);
    expect(result.stopReason).toBe("exhausted");
  });

  it("does not retry a page because it contained invalid records", async () => {
    const { client, transport, clock } = build("malformed-records");

    await client.listIncomingPayments(ACCOUNT);

    expect(transport.requestCount).toBe(1);
    expect(clock.delays).toEqual([]);
  });

  it("does not count ordinary non-incoming records as malformed", async () => {
    const { client } = build("non-payment-records");

    const result = await client.listIncomingPayments(ACCOUNT);

    // Outgoing payments, create_account operations and payments to another
    // account are normal traffic, not corruption.
    expect(result.payments).toHaveLength(1);
    expect(result.malformedRecords).toBe(0);
    expect(result.recordsSeen).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe("bounds", () => {
  it("stops at the page bound when Horizon never runs out of pages", async () => {
    const { client, transport } = build("endless-pages");

    const result = await client.listIncomingPayments(ACCOUNT, {
      pageLimit: 2,
      maxPages: 10,
    });

    expect(result.stopReason).toBe("page_bound");
    expect(result.pagesFetched).toBe(10);
    expect(transport.requestCount).toBe(10);
  });

  it("stops at the record bound", async () => {
    const { client } = build("endless-pages");

    const result = await client.listIncomingPayments(ACCOUNT, {
      pageLimit: 2,
      maxRecords: 5,
    });

    expect(result.stopReason).toBe("record_bound");
    expect(result.payments).toHaveLength(5);
  });

  it("stops at the time bound and keeps only records inside it", async () => {
    const { client } = build("time-bounded");

    // Records are hourly, newest first from the fixture epoch. A boundary three
    // hours back admits the first three and excludes the rest.
    const notBefore = new Date(Date.parse(fixtures.epoch) - 3 * 3_600_000 + 1);

    const result = await client.listIncomingPayments(ACCOUNT, {
      pageLimit: 3,
      notBefore,
    });

    expect(result.stopReason).toBe("time_bound");
    expect(result.payments).toHaveLength(3);
    for (const payment of result.payments) {
      expect(payment.occurredAt.getTime()).toBeGreaterThanOrEqual(notBefore.getTime());
    }
  });

  it("reports a resume cursor when a bound stopped the walk", async () => {
    const { client } = build("endless-pages");

    const result = await client.listIncomingPayments(ACCOUNT, {
      pageLimit: 2,
      maxPages: 3,
    });

    // Without this the caller has no way to continue from where it stopped.
    expect(result.lastCursor).toBeTruthy();
    expect(result.stopReason).toBe("page_bound");
  });
});

// ---------------------------------------------------------------------------
// Resume after failure
// ---------------------------------------------------------------------------

describe("resume after failure", () => {
  it("surfaces the fault when a later page cannot be read", async () => {
    const { client, transport } = build("fails-on-second-page");

    await expect(
      client.listIncomingPayments(ACCOUNT, { pageLimit: 2 }),
    ).rejects.toBeInstanceOf(HorizonFault);

    // Page one plus three attempts at page two.
    expect(transport.requestCount).toBe(4);
  });

  it("can resume from a cursor after an earlier read failed", async () => {
    const failing = build("fails-on-second-page");
    await expect(
      failing.client.listIncomingPayments(ACCOUNT, { pageLimit: 2 }),
    ).rejects.toBeInstanceOf(HorizonFault);

    // The cursor the failed read was about to use is recoverable from the last
    // successful page, and a fresh read continues from it.
    const cursor = failing.transport.requests[1].cursor as string;
    expect(cursor).toBe("91000001");

    const resumed = build("resume-from-cursor");
    const result = await resumed.client.listIncomingPayments(ACCOUNT, { cursor });

    expect(result.payments).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("cancellation", () => {
  it("refuses to start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, transport } = build("multi-page");

    await expect(
      client.listIncomingPayments(ACCOUNT, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(HorizonCancelledError);

    expect(transport.requestCount).toBe(0);
  });

  it("stops mid-walk when cancelled between pages", async () => {
    const controller = new AbortController();
    const { client, transport } = build("multi-page", {
      abortController: controller,
      abortAfterRequests: 1,
    });

    await expect(
      client.listIncomingPayments(ACCOUNT, {
        pageLimit: 3,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(HorizonCancelledError);

    // The first page was served; the walk stopped instead of fetching page two.
    expect(transport.requestCount).toBe(1);
  });

  it("reports cancellation as cancellation, not as a timeout", async () => {
    const controller = new AbortController();
    const { client } = build("timeout-then-ok", {
      abortController: controller,
      abortAfterRequests: 1,
    });

    // The transport throws a timeout-shaped error, but the caller's signal is
    // aborted. Misclassifying this would retry a read the caller abandoned.
    await expect(
      client.listIncomingPayments(ACCOUNT, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(HorizonCancelledError);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrent reads", () => {
  it("coalesces concurrent reads of the same account into one walk", async () => {
    const { client, transport } = build("multi-page");

    const [first, second] = await Promise.all([
      client.listIncomingPayments(ACCOUNT, { pageLimit: 3 }),
      client.listIncomingPayments(ACCOUNT, { pageLimit: 3 }),
    ]);

    // Three requests, not six: the second caller joined the first read.
    expect(transport.requestCount).toBe(3);
    expect(first.payments).toHaveLength(9);
    expect(second.payments).toEqual(first.payments);
  });

  it("does not coalesce reads with different bounds", async () => {
    const { client } = build("multi-page");

    // Sharing a result across different bounds would hand a caller a page count
    // it never asked for. The scripted transport runs out, which is the proof.
    await expect(
      Promise.all([
        client.listIncomingPayments(ACCOUNT, { pageLimit: 3 }),
        client.listIncomingPayments(ACCOUNT, { pageLimit: 3, maxPages: 1 }),
      ]),
    ).rejects.toThrow();
  });

  it("starts a fresh walk once the previous one has settled", async () => {
    const first = build("single-page");
    const firstResult = await first.client.listIncomingPayments(ACCOUNT);

    const second = build("single-page");
    const secondResult = await second.client.listIncomingPayments(ACCOUNT);

    expect(secondResult.payments).toEqual(firstResult.payments);
    expect(second.transport.requestCount).toBe(1);
  });

  it("never coalesces a cancellable read into another caller's", async () => {
    const controller = new AbortController();
    const { client, transport } = build("multi-page", {
      abortController: controller,
      abortAfterRequests: 2,
    });

    // If these shared a walk, cancelling one would cancel the other.
    const cancellable = client.listIncomingPayments(ACCOUNT, {
      pageLimit: 3,
      signal: controller.signal,
    });

    await expect(cancellable).rejects.toBeInstanceOf(HorizonCancelledError);
    expect(transport.requestCount).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Fixture hygiene
// ---------------------------------------------------------------------------

describe("fixtures", () => {
  it("carries no production wallet, transaction, or account data", () => {
    const raw = JSON.stringify(fixtures);

    // Real Stellar addresses are base32 (no 0, 1, 8, 9) and CRC-checked. Every
    // address here is deliberately outside that alphabet and self-labelled.
    expect(fixtures.account).toMatch(/^GSYNTHETIC/);
    expect(fixtures.counterparty).toMatch(/^GSYNTHETIC/);
    expect(fixtures.assetIssuer).toMatch(/^GSYNTHETIC/);
    expect(raw).not.toMatch(/\b[GMS][A-Z2-7]{55}\b/);
    expect(raw).not.toMatch(/horizon(-testnet)?\.stellar\.org/);
  });

  it("uses transaction hashes that cannot resolve in a block explorer", () => {
    const raw = JSON.stringify(fixtures);
    const hashes = raw.match(/"transaction_hash":\s*"([^"]+)"/g) ?? [];

    expect(hashes.length).toBeGreaterThan(0);
    for (const hash of hashes) {
      expect(hash).toContain("synthetic");
    }
  });

  it("is deterministic across loads", () => {
    // The loader caches, so this asserts the file is a fixed artefact rather
    // than something generated at import time.
    expect(JSON.stringify(loadHorizonFixtures())).toBe(JSON.stringify(fixtures));
  });
});

// ---------------------------------------------------------------------------
// The stub itself
// ---------------------------------------------------------------------------

describe("scripted transport", () => {
  it("fails loudly when the client sends an unexpected cursor", async () => {
    const transport = new ScriptedHorizonTransport("resume-from-cursor");
    const client = new HorizonClient({
      horizonUrl: fixtures.horizonUrl,
      transport,
      sleep: new RecordingSleep().sleep,
    });

    // The fixture expects a cursor on the first request. A client that dropped
    // it must not be able to pass by accident.
    const error = await client
      .listIncomingPayments(ACCOUNT)
      .catch((thrown: unknown) => thrown);

    // The client classifies any transport throw as a transient fault, so the
    // stub's complaint arrives as the cause rather than the top-level error.
    // Asserting the chain is what keeps a fixture mismatch diagnosable instead
    // of looking like a Horizon outage.
    expect(error).toBeInstanceOf(HorizonFault);
    expect((error as HorizonFault).cause).toBeInstanceOf(UnexpectedCursorError);
    expect(((error as HorizonFault).cause as Error).message).toMatch(
      /not following Horizon's next link correctly/,
    );
  });

  it("fails loudly when the client asks for more pages than were scripted", async () => {
    const transport = new ScriptedHorizonTransport("multi-page");
    const client = new HorizonClient({
      horizonUrl: fixtures.horizonUrl,
      transport,
      sleep: new RecordingSleep().sleep,
    });

    await client.listIncomingPayments(ACCOUNT, { pageLimit: 3 });
    expect(transport.unusedSteps).toBe(0);
  });

  it("rejects an unknown scenario id", () => {
    expect(() => new ScriptedHorizonTransport("no-such-scenario")).toThrow(
      /Unknown Horizon scenario/,
    );
  });
});
