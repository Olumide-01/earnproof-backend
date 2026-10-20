import {
  HorizonFault,
  HorizonFaultKind,
  classifyStatus,
  classifyThrown,
  isRetryable,
} from "./horizon-fault";
import {
  FetchHorizonTransport,
  HorizonTransport,
  retryAfterFrom,
} from "./horizon-transport";
import {
  HorizonLedgerSummary,
  HorizonOperationSummary,
  HorizonPaymentRecord,
  NormalizedPayment,
} from "./stellar.types";
import { operationIndexFromToid } from "./operation-identity";

/**
 * Cursor-paginated, fault-classifying reader for a Horizon payments feed.
 *
 * ## Why pagination needs bounds
 *
 * Horizon will page forever. An account with a long history, a cursor that
 * loops, or a Horizon replaying the same page all produce a read that never
 * terminates, and the symptom is a request that hangs rather than an error
 * anybody can act on. Every loop here therefore has an explicit bound — pages,
 * records, and time — and the result says which one stopped it.
 *
 * ## Ordering
 *
 * Pages are walked newest-first (`order=desc`) by default. That keeps the
 * existing product behaviour, where a bounded sync returns the most recent
 * activity rather than the oldest, and it makes the time and ledger bounds
 * meaningful: once a page's oldest record precedes the boundary, nothing further
 * back can be in range.
 *
 * A caller resuming from a verified checkpoint asks for `order=asc` instead.
 * Walking forward from the checkpoint is the only order in which a bounded read
 * cannot leave a gap: whatever the page bound cuts off is still ahead of the
 * cursor the read hands back.
 *
 * ## Cursors are rebuilt, never followed
 *
 * Horizon supplies `_links.next.href` as an absolute URL. This client extracts
 * only the `cursor` parameter from it and rebuilds the request against the
 * configured Horizon origin. Following the href directly would let a
 * compromised or misconfigured upstream redirect the sync at a host of its
 * choosing, which is a request-forgery primitive handed over for free.
 */

/** Records requested per page. Horizon's own maximum. */
const DEFAULT_PAGE_LIMIT = 200;

/** Pages walked in one read, before `page_bound` stops it. */
const DEFAULT_MAX_PAGES = 10;

/** Records accumulated in one read, before `record_bound` stops it. */
const DEFAULT_MAX_RECORDS = 2_000;

/** Attempts per page, including the first. */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Backoff base. Deliberately small: this runs inside a request the user is
 * waiting on, and the surrounding request deadline is measured in seconds. Two
 * retries cost 600ms, which is worth spending; 7 seconds is not.
 */
const DEFAULT_BACKOFF_MS = 200;

/** Deadline for one HTTP request. */
const DEFAULT_TIMEOUT_MS = 5_000;

export type StopReason =
  /** Horizon ran out of pages. The feed was read to its end. */
  | "exhausted"
  | "page_bound"
  | "record_bound"
  | "time_bound"
  /** The same cursor came back twice — Horizon is looping. */
  | "repeated_cursor"
  /** A record predated `minPagingToken`. Only reachable newest-first. */
  | "ledger_bound";

export interface HorizonReadOptions {
  /** Cancels the read between and during requests. */
  signal?: AbortSignal;
  /** Stop once records predate this instant. */
  notBefore?: Date;
  /** Resume from a cursor a previous read returned. */
  cursor?: string;
  /** Walk direction. Defaults to `desc` (newest first). */
  order?: HorizonReadOrder;
  /**
   * Stop once a record's paging token is below this one. Newest-first only;
   * bounds a reconciliation read to the configured ledger history.
   */
  minPagingToken?: string;
  pageLimit?: number;
  maxPages?: number;
  maxRecords?: number;
  maxAttemptsPerPage?: number;
}

export type HorizonReadOrder = "asc" | "desc";

export interface HorizonReadResult {
  payments: NormalizedPayment[];
  pagesFetched: number;
  /** Records Horizon returned, before filtering. */
  recordsSeen: number;
  /** Records rejected as permanently invalid. Never retried. */
  malformedRecords: number;
  /** Records already seen in this read — Horizon replayed or overlapped a page. */
  duplicateRecords: number;
  /** Total HTTP attempts, including retries. */
  attempts: number;
  /** Cursor to resume from. `null` when the feed was exhausted. */
  lastCursor: string | null;
  stopReason: StopReason;
}

/** One record of an ascending page, keyed by its Horizon paging token. */
export interface AscendingPaymentRecord {
  /**
   * The record's paging token as a TOID (ledger << 32 | tx << 12 | op), or
   * null when Horizon returned a non-numeric id. TOIDs order records by
   * ledger, which is what makes a ledger-bounded scan possible.
   */
  toid: bigint | null;
  /** The normalized incoming payment, or null for any other record. */
  payment: NormalizedPayment | null;
}

export interface AscendingPaymentsPage {
  records: AscendingPaymentRecord[];
  /** Cursor for the following page; null when Horizon offers none. */
  nextCursor: string | null;
  attempts: number;
}

export interface AscendingPageOptions {
  /** Exclusive lower bound: records strictly after this paging token. */
  cursor: string;
  pageLimit?: number;
  maxAttemptsPerPage?: number;
  signal?: AbortSignal;
}

export interface HorizonClientOptions {
  horizonUrl: string;
  transport?: HorizonTransport;
  /** Injected so backoff costs no wall-clock time in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  backoffMs?: number;
  /**
   * Source of [0, 1) for backoff jitter. Injected so a test can pin the delay;
   * defaults to `Math.random` in production. See {@link HorizonClient} for why
   * the retry delay is jittered rather than deterministic.
   */
  random?: () => number;
}

/** Raised when the caller's signal aborts the read. Never retried. */
export class HorizonCancelledError extends Error {
  constructor() {
    super("Horizon read was cancelled");
    this.name = "HorizonCancelledError";
  }
}

export class HorizonClient {
  private readonly horizonUrl: string;
  private readonly transport: HorizonTransport;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly random: () => number;

  /**
   * Reads already running, keyed by account and options.
   *
   * Two concurrent syncs of the same account are the common case, not an edge
   * one: a client retrying a slow request, or two app instances reacting to the
   * same event. Without this they each walk the whole feed and each write the
   * same rows, doubling Horizon load to produce one result. Coalescing them
   * makes the second caller await the first read instead.
   */
  private readonly inFlight = new Map<string, Promise<HorizonReadResult>>();

  constructor(options: HorizonClientOptions) {
    this.horizonUrl = options.horizonUrl.replace(/\/$/, "");
    this.transport = options.transport ?? new FetchHorizonTransport();
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.random = options.random ?? Math.random;
  }

  /**
   * Reads incoming payments for `address`, following cursors until a bound.
   *
   * Only payments *to* `address` are returned: Horizon's payments feed for an
   * account includes both directions, and the caller wants received funds.
   */
  async listIncomingPayments(
    address: string,
    options: HorizonReadOptions = {},
  ): Promise<HorizonReadResult> {
    // A cancelled read must not be coalesced with, or into, another caller's:
    // aborting one would abort the other. These run on their own.
    if (options.signal) {
      return this.read(address, options);
    }

    const key = coalescingKey(address, options);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const started = this.read(address, options).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, started);
    return started;
  }

  /**
   * Reads exactly one page of an account's payments in ascending order,
   * starting strictly after `cursor`.
   *
   * Used by ledger-range backfills, which walk history oldest-first from
   * their own checkpoint. It is deliberately separate from
   * {@link listIncomingPayments}: it never coalesces, never walks further
   * than one page, and shares no cursor with the forward sync.
   */
  async readPaymentsPageAscending(
    address: string,
    options: AscendingPageOptions,
  ): Promise<AscendingPaymentsPage> {
    const url = this.pageUrl(
      address,
      options.pageLimit ?? DEFAULT_PAGE_LIMIT,
      "asc",
      options.cursor,
    );
    let attempts = 0;
    const page = await this.fetchPage(
      url,
      options.maxAttemptsPerPage ?? DEFAULT_MAX_ATTEMPTS,
      options.signal,
      (used) => {
        attempts += used;
      },
    );

    const records = page.records.map((record): AscendingPaymentRecord => {
      const id =
        record && typeof record === "object" && !Array.isArray(record)
          ? (record as { id?: unknown }).id
          : undefined;
      const toid =
        typeof id === "string" && /^\d{1,20}$/.test(id) ? BigInt(id) : null;
      const normalized = normalizeRecord(record, address);
      return {
        toid,
        payment: typeof normalized === "object" ? normalized : null,
      };
    });

    return { records, nextCursor: page.nextCursor, attempts };
  }

  private async read(
    address: string,
    options: HorizonReadOptions,
  ): Promise<HorizonReadResult> {
    const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    const maxAttempts = options.maxAttemptsPerPage ?? DEFAULT_MAX_ATTEMPTS;
    const order = options.order ?? "desc";
    const notBefore = options.notBefore?.getTime();
    const minPagingToken =
      order === "desc" && options.minPagingToken !== undefined
        ? parsePagingToken(options.minPagingToken)
        : undefined;

    const payments: NormalizedPayment[] = [];
    /** Operation ids already accepted, so a replayed page cannot double-count. */
    const seenOperationIds = new Set<string>();
    const seenCursors = new Set<string>();

    let cursor = options.cursor;
    let pagesFetched = 0;
    let recordsSeen = 0;
    let malformedRecords = 0;
    let duplicateRecords = 0;
    let attempts = 0;
    let lastCursor: string | null = cursor ?? null;
    let stopReason: StopReason = "exhausted";

    while (true) {
      if (pagesFetched >= maxPages) {
        stopReason = "page_bound";
        break;
      }

      this.assertNotCancelled(options.signal);

      const url = this.pageUrl(address, pageLimit, order, cursor);
      const page = await this.fetchPage(url, maxAttempts, options.signal, (used) => {
        attempts += used;
      });

      pagesFetched += 1;

      const records = page.records;
      if (records.length === 0) {
        // An empty page is the end of the feed, whether or not Horizon still
        // offers a next link. Continuing would loop on an empty cursor.
        stopReason = "exhausted";
        lastCursor = page.nextCursor ?? lastCursor;
        break;
      }

      let crossedTimeBound = false;
      let crossedLedgerBound = false;

      for (const record of records) {
        recordsSeen += 1;

        const normalized = normalizeRecord(record, address);
        if (normalized === "malformed") {
          // Permanent: the record cannot become valid, so it is counted and
          // skipped rather than retried or allowed to fail the whole read.
          malformedRecords += 1;
          continue;
        }
        if (normalized === "not-incoming") continue;

        if (notBefore !== undefined && normalized.occurredAt.getTime() < notBefore) {
          // Walking forward, an older record is simply out of range; only a
          // newest-first walk can conclude that nothing further is in range.
          if (order === "desc") crossedTimeBound = true;
          continue;
        }

        if (
          minPagingToken !== undefined &&
          normalized.pagingToken !== undefined &&
          BigInt(normalized.pagingToken) < minPagingToken
        ) {
          crossedLedgerBound = true;
          continue;
        }

        if (seenOperationIds.has(normalized.operationId)) {
          duplicateRecords += 1;
          continue;
        }

        seenOperationIds.add(normalized.operationId);
        payments.push(normalized);

        if (payments.length >= maxRecords) break;
      }

      lastCursor = page.nextCursor ?? lastCursor;

      if (payments.length >= maxRecords) {
        stopReason = "record_bound";
        break;
      }

      if (crossedTimeBound) {
        // Pages are newest-first, so once a record precedes the boundary every
        // later page does too.
        stopReason = "time_bound";
        break;
      }

      if (crossedLedgerBound) {
        stopReason = "ledger_bound";
        break;
      }

      if (!page.nextCursor) {
        stopReason = "exhausted";
        lastCursor = null;
        break;
      }

      if (seenCursors.has(page.nextCursor) || page.nextCursor === cursor) {
        // Horizon handed back a cursor already used. Following it would fetch
        // the same page forever.
        stopReason = "repeated_cursor";
        break;
      }

      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    return {
      payments,
      pagesFetched,
      recordsSeen,
      malformedRecords,
      duplicateRecords,
      attempts,
      lastCursor,
      stopReason,
    };
  }

  /**
   * Fetches one page, retrying only transient faults.
   *
   * The retry budget is per page, so a read that survives a rate limit on page
   * one still has its full budget for page two — a shared budget would let one
   * unlucky page starve the rest of the sync.
   */
  private fetchPage(
    url: string,
    maxAttempts: number,
    signal: AbortSignal | undefined,
    countAttempts: (used: number) => void,
  ): Promise<ParsedPage> {
    return this.fetchResource(url, maxAttempts, signal, countAttempts, parsePage);
  }

  /**
   * Reads one ledger's sequence and hash, or `null` when Horizon has no such
   * ledger.
   *
   * This is the anchor of checkpoint finality: a checkpoint records the hash of
   * the ledger it was taken at, and a later read of the same sequence that
   * yields a different hash means Horizon's view of history has changed.
   */
  async getLedger(
    sequence: number,
    signal?: AbortSignal,
  ): Promise<HorizonLedgerSummary | null> {
    return this.fetchSingle(
      `${this.horizonUrl}/ledgers/${encodeURIComponent(String(sequence))}`,
      signal,
      parseLedger,
    );
  }

  /** Reads one operation's identity, or `null` when Horizon has no such operation. */
  async getOperation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<HorizonOperationSummary | null> {
    return this.fetchSingle(
      `${this.horizonUrl}/operations/${encodeURIComponent(operationId)}`,
      signal,
      parseOperation,
    );
  }

  /**
   * One non-paginated resource. A 404 is an answer — the resource is absent —
   * not a fault, so it comes back as `null` instead of an error.
   */
  private async fetchSingle<T>(
    url: string,
    signal: AbortSignal | undefined,
    parse: (body: unknown) => T | null,
  ): Promise<T | null> {
    try {
      return await this.fetchResource(url, DEFAULT_MAX_ATTEMPTS, signal, () => undefined, parse);
    } catch (error) {
      if (error instanceof HorizonFault && error.kind === "not_found") return null;
      throw error;
    }
  }

  private async fetchResource<T>(
    url: string,
    maxAttempts: number,
    signal: AbortSignal | undefined,
    countAttempts: (used: number) => void,
    parse: (body: unknown) => T | null,
  ): Promise<T> {
    let lastFault: HorizonFault | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.assertNotCancelled(signal);
      countAttempts(1);

      let fault: HorizonFault;

      try {
        const response = await this.transport.get({
          url,
          signal,
          timeoutMs: this.timeoutMs,
        });

        if (response.status >= 200 && response.status < 300) {
          const parsed = parse(response.body);
          if (parsed) return parsed;

          // A 2xx whose body is not a Horizon collection will not become one on
          // a retry.
          throw new HorizonFault("malformed_page", "Horizon returned an unreadable page", {
            status: response.status,
          });
        }

        const kind = classifyStatus(response.status);
        fault = new HorizonFault(kind, faultMessage(kind), {
          status: response.status,
          retryAfterSeconds: retryAfterFrom(response),
        });
      } catch (error) {
        // A caller-initiated cancellation looks like a timeout at the transport
        // level. Checking the caller's signal first keeps the two apart, so a
        // cancelled read is not retried as though Horizon were slow.
        if (signal?.aborted) throw new HorizonCancelledError();
        if (error instanceof HorizonCancelledError) throw error;

        const kind = classifyThrown(error);
        fault = error instanceof HorizonFault
          ? error
          : new HorizonFault(kind, faultMessage(kind), { cause: error });
      }

      lastFault = fault;

      if (!isRetryable(fault.kind) || attempt === maxAttempts) break;

      // Retry-After is obeyed exactly — Horizon told us how long to wait, and
      // jittering a server-supplied delay would only disobey it. The client's
      // own exponential backoff, by contrast, is jittered (full jitter, uniform
      // in [0, cap]): without it, every worker that hit the same outage retries
      // on the same ticks and stampedes the recovering dependency in lockstep.
      const delay =
        fault.retryAfterSeconds !== undefined
          ? fault.retryAfterSeconds * 1000
          : Math.floor(this.random() * this.backoffMs * Math.pow(2, attempt - 1));

      await this.sleep(delay, signal);
    }

    throw lastFault ?? new HorizonFault("network_error", faultMessage("network_error"));
  }

  private pageUrl(
    address: string,
    limit: number,
    order: HorizonReadOrder,
    cursor?: string,
  ): string {
    const url = new URL(
      `${this.horizonUrl}/accounts/${encodeURIComponent(address)}/payments`,
    );
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("order", order);
    if (cursor) url.searchParams.set("cursor", cursor);
    return url.toString();
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new HorizonCancelledError();
  }
}

// ---------------------------------------------------------------------------
// Page and record parsing
// ---------------------------------------------------------------------------

interface ParsedPage {
  records: unknown[];
  nextCursor: string | null;
}

/**
 * Reads a Horizon collection, or returns null if the body is not one.
 *
 * An absent `_embedded.records` is treated as an empty page rather than a
 * malformed one: Horizon answers that way for an account with no activity, and
 * failing there would make an empty account indistinguishable from an outage.
 */
function parsePage(body: unknown): ParsedPage | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const collection = body as {
    _embedded?: { records?: unknown };
    _links?: { next?: { href?: unknown } };
  };

  const embedded = collection._embedded;
  if (embedded !== undefined && (typeof embedded !== "object" || embedded === null)) {
    return null;
  }

  const records = embedded?.records;
  if (records !== undefined && !Array.isArray(records)) return null;

  return {
    records: records ?? [],
    nextCursor: extractCursor(collection._links?.next?.href),
  };
}

function parseLedger(body: unknown): HorizonLedgerSummary | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const ledger = body as { sequence?: unknown; hash?: unknown };
  const sequence =
    typeof ledger.sequence === "number" ? ledger.sequence : Number(ledger.sequence);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
  if (typeof ledger.hash !== "string" || !/^[0-9a-f]{64}$/i.test(ledger.hash)) return null;
  return { sequence, hash: ledger.hash.toLowerCase() };
}

function parseOperation(body: unknown): HorizonOperationSummary | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const operation = body as {
    id?: unknown;
    paging_token?: unknown;
    transaction_hash?: unknown;
  };
  if (typeof operation.id !== "string" || operation.id.length === 0) return null;
  if (typeof operation.transaction_hash !== "string") return null;
  if (typeof operation.paging_token !== "string" || !isPagingToken(operation.paging_token)) {
    return null;
  }
  return {
    id: operation.id,
    pagingToken: operation.paging_token,
    transactionHash: operation.transaction_hash,
  };
}

const MAX_PAGING_TOKEN = BigInt("18446744073709551615");

/** Paging tokens are unsigned 64-bit decimal strings. */
export function isPagingToken(value: string): boolean {
  return /^\d{1,20}$/.test(value) && BigInt(value) <= MAX_PAGING_TOKEN;
}

function parsePagingToken(value: string): bigint | undefined {
  return isPagingToken(value) ? BigInt(value) : undefined;
}

/**
 * Pulls the `cursor` parameter out of a next link.
 *
 * Only the parameter is taken; the origin is discarded and the request is
 * rebuilt against the configured Horizon. A next link pointing somewhere else
 * yields its cursor and nothing more, so it cannot redirect the read.
 */
export function extractCursor(href: unknown): string | null {
  if (typeof href !== "string" || href.length === 0) return null;

  try {
    // The base only matters for relative hrefs; it is never used as a target.
    const url = new URL(href, "https://horizon.invalid");
    const cursor = url.searchParams.get("cursor");
    return cursor && cursor.length > 0 ? cursor : null;
  } catch {
    return null;
  }
}

type RecordOutcome = NormalizedPayment | "malformed" | "not-incoming";

/**
 * Validates and normalizes one Horizon record.
 *
 * Anything structurally unusable is `malformed` — a permanent condition. A
 * well-formed record that simply is not an incoming payment to this account is
 * `not-incoming`, which is ordinary and not counted as a fault. Conflating the
 * two would make a normal outgoing payment look like data corruption.
 */
export function normalizeRecord(record: unknown, address: string): RecordOutcome {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "malformed";

  const candidate = record as HorizonPaymentRecord;

  if (typeof candidate.id !== "string" || candidate.id.length === 0) return "malformed";
  if (typeof candidate.type !== "string") return "malformed";

  if (candidate.type !== "payment") return "not-incoming";
  if (candidate.to !== address) return "not-incoming";

  if (typeof candidate.transaction_hash !== "string" || candidate.transaction_hash.length === 0) {
    return "malformed";
  }
  if (typeof candidate.from !== "string" || candidate.from.length === 0) return "malformed";
  if (typeof candidate.amount !== "string" || !isDecimalAmount(candidate.amount)) {
    return "malformed";
  }
  if (typeof candidate.created_at !== "string") return "malformed";

  const occurredAt = new Date(candidate.created_at);
  if (Number.isNaN(occurredAt.getTime())) return "malformed";

  const isNative = candidate.asset_type === "native";
  if (!isNative && typeof candidate.asset_code !== "string") return "malformed";

  // Absent on some synthetic records; present on every real Horizon record.
  // A token that is present but unreadable is corrupt, not optional.
  let pagingToken: string | undefined;
  if (candidate.paging_token !== undefined) {
    if (typeof candidate.paging_token !== "string" || !isPagingToken(candidate.paging_token)) {
      return "malformed";
    }
    pagingToken = candidate.paging_token;
  }

  return {
    operationId: candidate.id,
    ...(pagingToken !== undefined ? { pagingToken } : {}),
    operationIndex: operationIndexFromToid(candidate.id),
    stellarTransactionHash: candidate.transaction_hash,
    sourceAddress: candidate.from,
    destinationAddress: candidate.to as string,
    assetCode: isNative ? "XLM" : (candidate.asset_code as string),
    assetIssuer: isNative ? null : (candidate.asset_issuer ?? null),
    amount: candidate.amount,
    occurredAt,
  };
}

/** Amounts are decimal strings; anything else would corrupt arithmetic downstream. */
function isDecimalAmount(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value);
}

function faultMessage(kind: HorizonFaultKind): string {
  switch (kind) {
    case "rate_limited":
      return "Horizon rate limit reached";
    case "server_error":
      return "Horizon returned a server error";
    case "timeout":
      return "Horizon request timed out";
    case "network_error":
      return "Horizon could not be reached";
    case "expired_cursor":
      return "Horizon rejected the pagination cursor";
    case "not_found":
      return "Horizon has no record of this account";
    case "client_error":
      return "Horizon rejected the request";
    case "malformed_page":
      return "Horizon returned an unreadable page";
  }
}

/**
 * Identity for coalescing concurrent reads.
 *
 * Options are part of the key because two reads of the same account with
 * different bounds are different reads; sharing one result would silently give
 * a caller a page count it did not ask for.
 */
function coalescingKey(address: string, options: HorizonReadOptions): string {
  return JSON.stringify([
    address,
    options.cursor ?? null,
    options.order ?? null,
    options.minPagingToken ?? null,
    options.pageLimit ?? null,
    options.maxPages ?? null,
    options.maxRecords ?? null,
    options.maxAttemptsPerPage ?? null,
    options.notBefore?.toISOString() ?? null,
  ]);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HorizonCancelledError());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new HorizonCancelledError());
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
