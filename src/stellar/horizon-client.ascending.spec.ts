import { HorizonClient } from "./horizon-client";
import { HorizonFault } from "./horizon-fault";
import {
  HorizonHttpResponse,
  HorizonRequest,
  HorizonTransport,
} from "./horizon-transport";

/**
 * The single-page ascending read used by ledger-range backfills
 * (earnproof-backend#177). Separate from the forward reader on purpose; these
 * tests pin that it asks for oldest-first order from the given cursor, reads
 * exactly one page, and keys every record by its paging token.
 */

const ACCOUNT = "GACCOUNTUNDERTEST";
const HORIZON = "https://horizon.example.test";

class QueueTransport implements HorizonTransport {
  readonly requests: string[] = [];
  constructor(private readonly responses: HorizonHttpResponse[]) {}

  async get(request: HorizonRequest): Promise<HorizonHttpResponse> {
    this.requests.push(request.url);
    const next = this.responses.shift();
    if (!next) throw new Error("no scripted response left");
    return next;
  }
}

function ok(records: unknown[], next?: string): HorizonHttpResponse {
  return {
    status: 200,
    headers: {},
    body: {
      _embedded: { records },
      _links: next ? { next: { href: `${HORIZON}/accounts/${ACCOUNT}/payments?cursor=${next}` } } : {},
    },
  };
}

function incoming(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    paging_token: id,
    type: "payment",
    transaction_hash: `tx-${id}`,
    created_at: "2026-01-01T00:00:00Z",
    from: "GPAYER",
    to: ACCOUNT,
    asset_type: "native",
    amount: "5.0000000",
    ...overrides,
  };
}

function client(transport: HorizonTransport) {
  return new HorizonClient({
    horizonUrl: HORIZON,
    transport,
    sleep: async () => undefined,
  });
}

describe("HorizonClient.readPaymentsPageAscending", () => {
  it("requests one ascending page strictly after the cursor", async () => {
    const transport = new QueueTransport([ok([incoming("429496729601")], "429496729601")]);

    await client(transport).readPaymentsPageAscending(ACCOUNT, {
      cursor: "429496729600",
      pageLimit: 50,
    });

    expect(transport.requests).toHaveLength(1);
    const url = new URL(transport.requests[0]);
    expect(url.origin).toBe(HORIZON);
    expect(url.pathname).toBe(`/accounts/${ACCOUNT}/payments`);
    expect(url.searchParams.get("order")).toBe("asc");
    expect(url.searchParams.get("cursor")).toBe("429496729600");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("keys records by paging token and normalizes only incoming payments", async () => {
    const transport = new QueueTransport([
      ok(
        [
          incoming("429496733697"),
          incoming("429496733698", { to: "GSOMEONEELSE", from: ACCOUNT }),
          { id: "429496733699", type: "create_account" },
          { id: "not-a-number", type: "payment" },
        ],
        "429496733699",
      ),
    ]);

    const page = await client(transport).readPaymentsPageAscending(ACCOUNT, {
      cursor: "0",
    });

    expect(page.records.map((record) => record.toid)).toEqual([
      429496733697n,
      429496733698n,
      429496733699n,
      null,
    ]);
    expect(page.records[0].payment).toMatchObject({
      operationId: "429496733697",
      destinationAddress: ACCOUNT,
      assetCode: "XLM",
    });
    expect(page.records.slice(1).every((record) => record.payment === null)).toBe(true);
    expect(page.nextCursor).toBe("429496733699");
  });

  it("reports an exhausted feed as no next cursor", async () => {
    const page = await client(new QueueTransport([ok([])])).readPaymentsPageAscending(
      ACCOUNT,
      { cursor: "0" },
    );
    expect(page).toMatchObject({ records: [], nextCursor: null });
  });

  it("retries a transient fault within the page budget", async () => {
    const transport = new QueueTransport([
      { status: 503, headers: {}, body: undefined },
      ok([incoming("429496729601")]),
    ]);

    const page = await client(transport).readPaymentsPageAscending(ACCOUNT, {
      cursor: "0",
    });

    expect(page.attempts).toBe(2);
    expect(page.records).toHaveLength(1);
  });

  it("does not follow a next link to another host", async () => {
    const transport = new QueueTransport([
      {
        status: 200,
        headers: {},
        body: {
          _embedded: { records: [] },
          _links: { next: { href: "https://attacker.example/x?cursor=99" } },
        },
      },
    ]);

    const page = await client(transport).readPaymentsPageAscending(ACCOUNT, {
      cursor: "0",
    });

    // Only the cursor value is taken; the next request is always rebuilt
    // against the configured Horizon.
    expect(page.nextCursor).toBe("99");
    expect(transport.requests).toHaveLength(1);
  });

  it("surfaces a permanent fault", async () => {
    const transport = new QueueTransport([{ status: 404, headers: {}, body: undefined }]);

    await expect(
      client(transport).readPaymentsPageAscending(ACCOUNT, { cursor: "0" }),
    ).rejects.toBeInstanceOf(HorizonFault);
  });
});
