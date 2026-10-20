import {
  PaymentClassification,
  Prisma,
  PrismaClient,
  ResourceStatus,
} from "@prisma/client";
import { createHmac } from "crypto";
import { canonicalize } from "../common/crypto/canonicalize";
import {
  AGGREGATE_EARNINGS_POLICY_VERSION,
  AggregationPeriod,
  AggregationPolicyError,
  AssetRef,
  MAX_COMPONENT_PAYMENTS,
  RoundingIncrement,
  SourceScope,
  aggregateEarnings,
  resolveAsset,
  resolvePeriod,
} from "./aggregate-earnings.policy";

export interface AggregateEarningsRequest {
  assets: AssetRef[];
  periodStart: string;
  periodEnd: string;
  sourceScope: SourceScope;
  /** Only with `verified_issuers`: restrict to these issuers. */
  issuerIds?: string[];
  roundingIncrement: RoundingIncrement;
}

export interface AggregateEarningsComputation {
  asset: AssetRef;
  period: AggregationPeriod;
  sourceScope: SourceScope;
  roundingIncrement: RoundingIncrement;
  policyVersion: typeof AGGREGATE_EARNINGS_POLICY_VERSION;
  disclosedAmount: string;
  paymentCount: number;
  /**
   * Keyed digest of the exact components (operation ids and amounts). Stored
   * server-side so an operator can later re-derive and audit the aggregate;
   * never disclosed, and useless without the signing secret.
   */
  inputsDigest: string;
}

/** Prisma surface this calculator uses, so a transaction client also fits. */
type AggregationPrisma = Pick<PrismaClient, "payment" | "issuer" | "trustedSource">;

/**
 * Selects a wallet's eligible income and applies the aggregate-earnings policy.
 *
 * Every query is scoped to the requesting user. Issuer and trusted-source
 * lookups only produce source *addresses* to match against that user's own
 * payments; they never read another user's rows.
 */
export class AggregateEarningsCalculator {
  constructor(
    private readonly prisma: AggregationPrisma,
    private readonly decryptAmount: (amountEncrypted: string) => string,
    private readonly digestSecret: string,
  ) {}

  async compute(
    userId: string,
    request: AggregateEarningsRequest,
    now: Date = new Date(),
  ): Promise<AggregateEarningsComputation> {
    const asset = resolveAsset(request.assets);
    const period = resolvePeriod(request.periodStart, request.periodEnd, now);
    const sourceAddresses = await this.sourceAddresses(userId, request);

    if (sourceAddresses !== null && sourceAddresses.length === 0) {
      throw new AggregationPolicyError(
        "insufficient_payments",
        "No eligible payment sources match the requested scope",
      );
    }

    const where: Prisma.PaymentWhereInput = {
      userId,
      classification: PaymentClassification.INCOME,
      isEligible: true,
      assetCode: asset.code,
      assetIssuer: asset.issuer,
      occurredAt: { gte: period.start, lt: period.end },
      ...(sourceAddresses !== null ? { sourceAddress: { in: sourceAddresses } } : {}),
    };

    // One more than the cap, so exceeding it is detected rather than truncated
    // into a silently smaller (and still "valid") aggregate. The order only
    // decides which rows are loaded when the cap is exceeded, and then the
    // request is refused anyway.
    const rows = await this.prisma.payment.findMany({
      where,
      select: {
        operationId: true,
        amountEncrypted: true,
        occurredAt: true,
        assetCode: true,
        assetIssuer: true,
      },
      orderBy: [{ occurredAt: "asc" }, { operationId: "asc" }],
      take: MAX_COMPONENT_PAYMENTS + 1,
    });

    const result = aggregateEarnings(
      rows.map((row) => ({
        operationId: row.operationId,
        amount: this.readAmount(row.amountEncrypted),
        occurredAt: row.occurredAt,
        assetCode: row.assetCode,
        assetIssuer: row.assetIssuer,
      })),
      { asset, period, roundingIncrement: request.roundingIncrement },
    );

    return {
      asset,
      period,
      sourceScope: request.sourceScope,
      roundingIncrement: request.roundingIncrement,
      policyVersion: AGGREGATE_EARNINGS_POLICY_VERSION,
      disclosedAmount: result.disclosedAmount,
      paymentCount: result.paymentCount,
      inputsDigest: `hmac-sha256:${createHmac("sha256", this.digestSecret)
        .update(
          canonicalize({
            policyVersion: AGGREGATE_EARNINGS_POLICY_VERSION,
            components: result.canonicalComponents,
          }),
        )
        .digest("base64url")}`,
    };
  }

  /**
   * Source addresses the scope admits, or `null` when every source counts.
   * Sorted and de-duplicated so the query itself is deterministic.
   */
  private async sourceAddresses(
    userId: string,
    request: AggregateEarningsRequest,
  ): Promise<string[] | null> {
    if (request.sourceScope === "income") return null;

    if (request.sourceScope === "trusted_sources") {
      const sources = await this.prisma.trustedSource.findMany({
        where: { userId, status: ResourceStatus.ACTIVE },
        select: { sourceAddress: true },
      });
      return [...new Set(sources.map((source) => source.sourceAddress))].sort();
    }

    const issuerIds = request.issuerIds ? [...new Set(request.issuerIds)] : undefined;
    const issuers = await this.prisma.issuer.findMany({
      where: {
        status: ResourceStatus.ACTIVE,
        ...(issuerIds ? { id: { in: issuerIds } } : {}),
      },
      select: { id: true, stellarAddress: true },
    });

    if (issuerIds && issuers.length !== issuerIds.length) {
      throw new AggregationPolicyError(
        "invalid_source",
        "One or more requested issuers are unknown or not active",
      );
    }
    return [...new Set(issuers.map((issuer) => issuer.stellarAddress))].sort();
  }

  private readAmount(amountEncrypted: string | null): string | null {
    if (!amountEncrypted) return null;
    try {
      return this.decryptAmount(amountEncrypted);
    } catch {
      return null;
    }
  }
}
