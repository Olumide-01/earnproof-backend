import { FIELD_LIMITS } from "../common/limits/request-limits";

/**
 * Aggregate-earnings policy, version 1.
 *
 * An aggregate-earnings proof states "this wallet earned at least X of asset A
 * between S and E", where X is the sum of the wallet's eligible income payments
 * rounded *down* to a disclosure increment. Every rule that decides X lives in
 * this file as a pure function, so the same inputs produce the same X no matter
 * how the database ordered its rows, and every rule can be tested without one.
 *
 * The rules, in order:
 *
 * 1. **Asset.** One asset per proof. Aggregating across assets needs a
 *    conversion policy (rate source, timestamp, rounding); none is defined, so
 *    a request naming more than one distinct asset is refused rather than
 *    summed as though 1 XLM were 1 USDC.
 * 2. **Period.** Half-open `[periodStart, periodEnd)`: a payment exactly at the
 *    end belongs to the next period, so consecutive proofs never count a
 *    boundary payment twice. The period must be non-empty, at most
 *    {@link MAX_PERIOD_DAYS} long, and must not end in the future.
 * 3. **Components.** Each payment counts once, keyed by its Stellar operation
 *    id. Between {@link MIN_COMPONENT_PAYMENTS} and {@link MAX_COMPONENT_PAYMENTS}
 *    payments are required; a single payment would make the aggregate a
 *    rounded copy of that payment's amount.
 * 4. **Normalisation.** Amounts are Stellar decimal strings with at most seven
 *    fractional digits, summed exactly as integer stroops. An amount that
 *    cannot be read fails the whole proof: silently skipping it would
 *    understate, and guessing would overstate.
 * 5. **Rounding.** The exact total is floored to the requested increment, so
 *    the disclosed figure never overstates earnings and hides the exact sum.
 *    A total that floors to zero is refused.
 */

export const AGGREGATE_EARNINGS_POLICY_VERSION = "earnproof.aggregate-earnings.policy.v1";

export const SOURCE_SCOPES = ["income", "trusted_sources", "verified_issuers"] as const;
export type SourceScope = (typeof SOURCE_SCOPES)[number];

/** Disclosure granularities. Smallest is one stroop (exact disclosure). */
export const ROUNDING_INCREMENTS = [
  "0.0000001",
  "0.01",
  "1",
  "10",
  "100",
  "1000",
] as const;
export type RoundingIncrement = (typeof ROUNDING_INCREMENTS)[number];
export const DEFAULT_ROUNDING_INCREMENT: RoundingIncrement = "1";

export const MIN_COMPONENT_PAYMENTS = 2;
export const MAX_COMPONENT_PAYMENTS = FIELD_LIMITS.paymentIdsPerProof;
export const MAX_PERIOD_DAYS = 366;

const STROOPS_PER_UNIT = BigInt(10_000_000);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Conversion policies that would permit cross-asset aggregation. Deliberately
 * empty: adding one is a policy-version change, not a code tweak.
 */
const CONVERSION_POLICIES: ReadonlySet<string> = new Set();

export type AggregationRejection =
  | "invalid_period"
  | "future_period"
  | "period_too_long"
  | "cross_asset_unsupported"
  | "invalid_source"
  | "insufficient_payments"
  | "limit_exceeded"
  | "amount_unavailable"
  | "below_rounding_increment";

/** A policy refusal. Messages never contain amounts, addresses or ids. */
export class AggregationPolicyError extends Error {
  constructor(
    readonly reason: AggregationRejection,
    message: string,
  ) {
    super(message);
    this.name = "AggregationPolicyError";
  }
}

export interface AssetRef {
  code: string;
  issuer: string | null;
}

export interface AggregationPeriod {
  start: Date;
  /** Exclusive. */
  end: Date;
}

export interface AggregationComponent {
  operationId: string;
  /** Decrypted amount, or `null` when it could not be decrypted. */
  amount: string | null;
  occurredAt: Date;
  assetCode: string;
  assetIssuer: string | null;
}

export interface AggregationResult {
  /** Floored to the increment; the only figure that is ever disclosed. */
  disclosedAmount: string;
  paymentCount: number;
  /** Operation ids and stroop amounts, sorted by id, for the private digest. */
  canonicalComponents: Array<[string, string]>;
}

/**
 * The single asset a request aggregates. Duplicate mentions of the same asset
 * collapse; distinct assets are refused without a conversion policy.
 */
export function resolveAsset(assets: readonly AssetRef[], conversionPolicy?: string): AssetRef {
  const distinct = new Map<string, AssetRef>();
  for (const asset of assets) {
    const normalized = { code: asset.code, issuer: asset.issuer ?? null };
    distinct.set(`${normalized.code}:${normalized.issuer ?? "native"}`, normalized);
  }

  if (distinct.size === 0) {
    throw new AggregationPolicyError("cross_asset_unsupported", "At least one asset is required");
  }
  if (distinct.size > 1 && !(conversionPolicy && CONVERSION_POLICIES.has(conversionPolicy))) {
    throw new AggregationPolicyError(
      "cross_asset_unsupported",
      "Aggregating across different assets requires a conversion policy, and none is supported",
    );
  }
  return [...distinct.values()][0];
}

export function resolvePeriod(periodStart: string, periodEnd: string, now: Date): AggregationPeriod {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw new AggregationPolicyError("invalid_period", "periodStart must be before periodEnd");
  }
  if (end.getTime() > now.getTime()) {
    throw new AggregationPolicyError("future_period", "periodEnd must not be in the future");
  }
  if (end.getTime() - start.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    throw new AggregationPolicyError(
      "period_too_long",
      `The aggregation period must not exceed ${MAX_PERIOD_DAYS} days`,
    );
  }
  return { start, end };
}

/** Parses a Stellar decimal amount into stroops, or `null` if it is not one. */
export function parseStroops(amount: string): bigint | null {
  const match = /^(\d{1,19})(?:\.(\d{1,7}))?$/.exec(amount);
  if (!match) return null;
  return BigInt(match[1]) * STROOPS_PER_UNIT + BigInt((match[2] ?? "").padEnd(7, "0"));
}

/** Formats stroops as a canonical seven-decimal string. */
export function formatStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  const fraction = (stroops % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${whole.toString()}.${fraction}`;
}

/** Largest multiple of `increment` that does not exceed `total`. */
export function floorToIncrement(total: bigint, increment: RoundingIncrement): bigint {
  const step = parseStroops(increment) as bigint;
  return (total / step) * step;
}

/**
 * Applies the policy to candidate payments.
 *
 * Candidates outside the asset or the half-open period are ignored even though
 * the query should already have excluded them: the result must depend on the
 * policy, not on how carefully a caller filtered.
 */
export function aggregateEarnings(
  candidates: readonly AggregationComponent[],
  rules: { asset: AssetRef; period: AggregationPeriod; roundingIncrement: RoundingIncrement },
): AggregationResult {
  const byOperation = new Map<string, AggregationComponent>();
  for (const candidate of candidates) {
    if (candidate.assetCode !== rules.asset.code) continue;
    if ((candidate.assetIssuer ?? null) !== rules.asset.issuer) continue;
    const at = candidate.occurredAt.getTime();
    if (at < rules.period.start.getTime() || at >= rules.period.end.getTime()) continue;

    const existing = byOperation.get(candidate.operationId);
    if (existing && existing.amount !== candidate.amount) {
      // The same operation cannot have two amounts; refuse rather than pick one.
      throw new AggregationPolicyError(
        "amount_unavailable",
        "A payment appears more than once with conflicting amounts",
      );
    }
    byOperation.set(candidate.operationId, candidate);
  }

  if (byOperation.size < MIN_COMPONENT_PAYMENTS) {
    throw new AggregationPolicyError(
      "insufficient_payments",
      `An aggregate requires at least ${MIN_COMPONENT_PAYMENTS} eligible payments in the period`,
    );
  }
  if (byOperation.size > MAX_COMPONENT_PAYMENTS) {
    throw new AggregationPolicyError(
      "limit_exceeded",
      `An aggregate may include at most ${MAX_COMPONENT_PAYMENTS} payments; narrow the period`,
    );
  }

  const canonicalComponents: Array<[string, string]> = [];
  let total = BigInt(0);
  for (const operationId of [...byOperation.keys()].sort()) {
    const component = byOperation.get(operationId) as AggregationComponent;
    const stroops = component.amount === null ? null : parseStroops(component.amount);
    if (stroops === null) {
      throw new AggregationPolicyError(
        "amount_unavailable",
        "One or more payment amounts are unavailable",
      );
    }
    total += stroops;
    canonicalComponents.push([operationId, stroops.toString()]);
  }

  const disclosed = floorToIncrement(total, rules.roundingIncrement);
  if (disclosed === BigInt(0)) {
    throw new AggregationPolicyError(
      "below_rounding_increment",
      "The aggregate is below the requested rounding increment",
    );
  }

  return {
    disclosedAmount: formatStroops(disclosed),
    paymentCount: byOperation.size,
    canonicalComponents,
  };
}
