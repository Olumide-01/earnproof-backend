import type { TimeSourceReading } from "../common/time/clock-skew";

/**
 * Trusted network time sources for clock skew monitoring (earnproof-backend#328).
 *
 * Each source answers one question — "what time does the network say it is?" —
 * as a {@link TimeSourceReading} that states its own uncertainty. Sources only
 * read; nothing here can influence the local clock.
 */
export interface TimeSource {
  /** Stable, non-identifying source name used in diagnostics. */
  readonly name: string;
  read(signal: AbortSignal): Promise<TimeSourceReading>;
}

/** Raised when a source answered but its answer cannot be used. */
export class TimeSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TimeSourceError";
  }
}

/**
 * Upper bound on how far the newest closed ledger trails network time.
 *
 * Ledgers close roughly every 5–6 seconds; under load an interval can stretch.
 * Ten seconds keeps a healthy network from ever looking like local skew.
 */
export const DEFAULT_LEDGER_CLOSE_ALLOWANCE_MS = 10_000;

/** Horizon reports ledger close times and HTTP dates to whole seconds. */
const SECOND_RESOLUTION_MS = 1_000;

type FetchLike = (
  input: string,
  init: { method: string; signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/**
 * Close time of the newest ledger, read from Horizon.
 *
 * The ledger close time is agreed by the network's validators, so it is the
 * reference that ledger-finality and expiry decisions are ultimately judged
 * against. The ledger sequence travels with the reading so a cached or
 * replayed response (an older ledger) is discarded rather than trusted.
 */
export class HorizonLedgerTimeSource implements TimeSource {
  readonly name = "horizon_ledger_close";

  constructor(
    private readonly horizonUrl: string,
    private readonly closeAllowanceMs: number = DEFAULT_LEDGER_CLOSE_ALLOWANCE_MS,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async read(signal: AbortSignal): Promise<TimeSourceReading> {
    const base = this.horizonUrl.replace(/\/$/, "");
    const response = await this.fetchImpl(`${base}/ledgers?order=desc&limit=1`, {
      method: "GET",
      signal,
      headers: { accept: "application/hal+json, application/json" },
    });
    if (!response.ok) {
      // The status code is a stable signal; the body is discarded unread.
      throw new TimeSourceError(`upstream_status_${response.status}`);
    }
    return parseLatestLedgerTime(await response.json(), this.closeAllowanceMs);
  }
}

/**
 * The HTTP `Date` header of a Horizon response (RFC 9110 §6.6.1).
 *
 * Independent of ledger cadence, so it still bounds skew while the network is
 * halted and no new ledgers close.
 */
export class HorizonHttpDateTimeSource implements TimeSource {
  readonly name = "horizon_http_date";

  constructor(
    private readonly horizonUrl: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async read(signal: AbortSignal): Promise<TimeSourceReading> {
    const response = await this.fetchImpl(this.horizonUrl, { method: "GET", signal });
    const header = response.headers.get("date");
    return parseHttpDate(header);
  }
}

/** Parses Horizon's `/ledgers?order=desc&limit=1` body. Exported for tests. */
export function parseLatestLedgerTime(
  body: unknown,
  closeAllowanceMs: number,
): TimeSourceReading {
  const records = (body as { _embedded?: { records?: unknown } } | null)?._embedded
    ?.records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new TimeSourceError("ledger_response_malformed");
  }
  const ledger = records[0] as { sequence?: unknown; closed_at?: unknown };
  const sequence = typeof ledger.sequence === "number" ? ledger.sequence : Number(ledger.sequence);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new TimeSourceError("ledger_response_malformed");
  }
  if (typeof ledger.closed_at !== "string") {
    throw new TimeSourceError("ledger_response_malformed");
  }
  const referenceMs = parseStrictIsoInstant(ledger.closed_at);
  if (referenceMs === null) {
    throw new TimeSourceError("ledger_response_malformed");
  }
  return {
    referenceMs,
    resolutionMs: SECOND_RESOLUTION_MS,
    maxReferenceLagMs: closeAllowanceMs,
    sequence,
  };
}

/** Parses an HTTP `Date` header value. Exported for tests. */
export function parseHttpDate(header: string | null): TimeSourceReading {
  if (!header) throw new TimeSourceError("date_header_absent");
  // IMF-fixdate only: "Sun, 06 Nov 1994 08:49:37 GMT". The obsolete formats
  // RFC 9110 tolerates are ambiguous about the century and are refused.
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) {
    throw new TimeSourceError("date_header_malformed");
  }
  const referenceMs = Date.parse(header);
  if (!Number.isFinite(referenceMs)) throw new TimeSourceError("date_header_malformed");
  return { referenceMs, resolutionMs: SECOND_RESOLUTION_MS, maxReferenceLagMs: 0 };
}

/** UTC ISO-8601 instants only (`Z` suffix), so a zone-less value cannot be misread. */
function parseStrictIsoInstant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
