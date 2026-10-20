import { Injectable, NotFoundException } from "@nestjs/common";
import {
  PaymentClassification,
  PaymentEligibilityDecision,
  Prisma,
  ResourceStatus,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import {
  DecisionTrigger,
  ELIGIBILITY_POLICY_VERSION,
  EligibilityFactors,
  REASON_CODES,
  evaluateEligibility,
  knownReasonCodes,
  proofUsage,
} from "./eligibility-policy";

/** Payments evaluated per query when re-evaluating a larger set. */
export const REEVALUATION_BATCH_SIZE = 200;

/** Historical decisions returned by the explanation endpoint. */
export const EXPLANATION_HISTORY_LIMIT = 20;

type EvaluablePayment = {
  id: string;
  userId: string;
  assetCode: string;
  assetIssuer: string | null;
  classification: PaymentClassification;
  sourceAddress: string | null;
};

const EVALUABLE_SELECT = {
  id: true,
  userId: true,
  assetCode: true,
  assetIssuer: true,
  classification: true,
  sourceAddress: true,
} satisfies Prisma.PaymentSelect;

/**
 * Records, re-evaluates and explains payment eligibility decisions.
 *
 * ## One active decision per payment
 *
 * Superseding the old decision and inserting the new one happen in a single
 * transaction, and PostgreSQL enforces at most one active decision per payment
 * with a unique index on `(paymentId, isActive)`. Two concurrent
 * re-evaluations therefore cannot both win: the loser's insert violates the
 * index, its transaction rolls back, and the winner's decision stands. Both
 * evaluate the same inputs under the same policy, so the outcome is the same
 * whichever wins.
 *
 * ## Idempotence
 *
 * A decision whose policy version and inputs hash match the active one is not
 * written again, so repeated syncs do not grow the history.
 */
@Injectable()
export class PaymentEligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Re-evaluates the given payments of one owner. Returns decisions written. */
  async evaluatePayments(
    userId: string,
    paymentIds: readonly string[],
    trigger: DecisionTrigger,
  ): Promise<number> {
    let written = 0;
    const ids = [...new Set(paymentIds)].sort();
    for (let offset = 0; offset < ids.length; offset += REEVALUATION_BATCH_SIZE) {
      const payments = await this.prisma.payment.findMany({
        where: { userId, id: { in: ids.slice(offset, offset + REEVALUATION_BATCH_SIZE) } },
        select: EVALUABLE_SELECT,
        orderBy: { id: "asc" },
      });
      written += await this.evaluate(payments, trigger);
    }
    return written;
  }

  /**
   * Re-evaluates an owner's payments from one sender, after that sender's
   * trusted-source status or issuer link changed.
   */
  async reevaluateSource(userId: string, sourceAddress: string): Promise<number> {
    let written = 0;
    let cursor: string | undefined;
    for (;;) {
      const payments = await this.prisma.payment.findMany({
        where: { userId, sourceAddress, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: EVALUABLE_SELECT,
        orderBy: { id: "asc" },
        take: REEVALUATION_BATCH_SIZE,
      });
      if (payments.length === 0) return written;
      written += await this.evaluate(payments, "trusted_source_changed");
      cursor = payments[payments.length - 1].id;
    }
  }

  /**
   * One bounded, resumable pass over all payments, for operators after the
   * supported-asset list changes or when the policy version is bumped. Call
   * again with the returned cursor until it is `null`.
   */
  async reevaluateBatch(options: {
    trigger: Extract<DecisionTrigger, "asset_policy_changed" | "policy_migration">;
    afterId?: string;
    limit?: number;
  }): Promise<{ processed: number; written: number; nextCursor: string | null }> {
    const limit = Math.min(Math.max(1, options.limit ?? REEVALUATION_BATCH_SIZE), 1_000);
    const payments = await this.prisma.payment.findMany({
      where: options.afterId ? { id: { gt: options.afterId } } : {},
      select: EVALUABLE_SELECT,
      orderBy: { id: "asc" },
      take: limit,
    });
    const written = await this.evaluate(payments, options.trigger);
    return {
      processed: payments.length,
      written,
      nextCursor: payments.length === limit ? payments[payments.length - 1].id : null,
    };
  }

  /**
   * The owner's explanation of a payment's current eligibility.
   *
   * A payment with no decision under the current policy (synced before
   * decisions existed, or decided under an older version) is evaluated now,
   * so the answer always reflects the current policy.
   */
  async explain(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, userId },
      select: EVALUABLE_SELECT,
    });
    if (!payment) throw new NotFoundException("Payment not found");

    let active = await this.activeDecision(payment.id);
    if (!active || active.policyVersion !== ELIGIBILITY_POLICY_VERSION) {
      await this.evaluate([payment], "policy_migration");
      active = await this.activeDecision(payment.id);
    }
    if (!active) throw new NotFoundException("Payment not found");

    const history = await this.prisma.paymentEligibilityDecision.findMany({
      where: { paymentId: payment.id, userId },
      orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
      take: EXPLANATION_HISTORY_LIMIT,
    });

    const factors = active.factors as unknown as EligibilityFactors;
    return {
      paymentId: payment.id,
      eligible: active.eligible,
      policyVersion: active.policyVersion,
      evaluatedAt: active.evaluatedAt,
      trigger: active.trigger,
      factors,
      reasons: knownReasonCodes(active.reasonCodes).map((code) => ({
        code,
        effect: REASON_CODES[code].effect,
        message: REASON_CODES[code].message,
      })),
      usage: proofUsage(active.eligible, factors.classification),
      history: history.map((decision) => ({
        policyVersion: decision.policyVersion,
        eligible: decision.eligible,
        reasonCodes: decision.reasonCodes,
        trigger: decision.trigger,
        evaluatedAt: decision.evaluatedAt,
        supersededAt: decision.supersededAt,
      })),
    };
  }

  private activeDecision(paymentId: string): Promise<PaymentEligibilityDecision | null> {
    return this.prisma.paymentEligibilityDecision.findFirst({
      where: { paymentId, isActive: true },
    });
  }

  /** Evaluates payments against current policy inputs; writes what changed. */
  private async evaluate(payments: EvaluablePayment[], trigger: DecisionTrigger): Promise<number> {
    if (payments.length === 0) return 0;

    const userIds = [...new Set(payments.map((payment) => payment.userId))];
    const [assets, trusted, actives] = await Promise.all([
      this.prisma.supportedAsset.findMany({
        where: { status: ResourceStatus.ACTIVE },
        select: { code: true, issuer: true },
      }),
      this.prisma.trustedSource.findMany({
        where: { userId: { in: userIds }, status: ResourceStatus.ACTIVE },
        select: { userId: true, sourceAddress: true, issuer: { select: { status: true } } },
      }),
      this.prisma.paymentEligibilityDecision.findMany({
        where: { paymentId: { in: payments.map((payment) => payment.id) }, isActive: true },
        select: { paymentId: true, policyVersion: true, inputsHash: true },
      }),
    ]);

    const supported = new Set(assets.map((asset) => assetKey(asset.code, asset.issuer)));
    const trustedByOwner = new Map(
      trusted.map((source) => [
        `${source.userId}:${source.sourceAddress}`,
        source.issuer?.status === ResourceStatus.ACTIVE,
      ]),
    );
    const activeByPayment = new Map(actives.map((decision) => [decision.paymentId, decision]));

    let written = 0;
    for (const payment of [...payments].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const trustKey = `${payment.userId}:${payment.sourceAddress}`;
      const decision = evaluateEligibility({
        assetSupported: supported.has(assetKey(payment.assetCode, payment.assetIssuer)),
        classification: payment.classification,
        sourceTrusted: trustedByOwner.has(trustKey),
        sourceIssuerVerified: trustedByOwner.get(trustKey) === true,
      });

      const active = activeByPayment.get(payment.id);
      if (
        active &&
        active.policyVersion === decision.policyVersion &&
        active.inputsHash === decision.inputsHash
      ) {
        continue;
      }

      if (await this.record(payment, decision, trigger)) written += 1;
    }
    return written;
  }

  /**
   * Supersedes the active decision and inserts the new one atomically.
   * Returns false when a concurrent evaluation won the race.
   */
  private async record(
    payment: EvaluablePayment,
    decision: ReturnType<typeof evaluateEligibility>,
    trigger: DecisionTrigger,
  ): Promise<boolean> {
    const now = new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Re-read inside the transaction: an evaluation that committed after
        // this one read the active decisions may already have recorded the
        // same decision, and superseding it with a duplicate adds nothing.
        const current = await tx.paymentEligibilityDecision.findFirst({
          where: { paymentId: payment.id, isActive: true },
          select: { policyVersion: true, inputsHash: true },
        });
        if (
          current &&
          current.policyVersion === decision.policyVersion &&
          current.inputsHash === decision.inputsHash
        ) {
          return false;
        }

        await tx.paymentEligibilityDecision.updateMany({
          where: { paymentId: payment.id, isActive: true },
          data: { isActive: null, supersededAt: now },
        });
        await tx.paymentEligibilityDecision.create({
          data: {
            paymentId: payment.id,
            userId: payment.userId,
            policyVersion: decision.policyVersion,
            eligible: decision.eligible,
            factors: decision.factors as unknown as Prisma.InputJsonValue,
            reasonCodes: decision.reasonCodes,
            inputsHash: decision.inputsHash,
            trigger,
            evaluatedAt: now,
            isActive: true,
          },
        });
        // The column clients and proof issuance already read stays in step
        // with the active decision.
        await tx.payment.update({
          where: { id: payment.id },
          data: { isEligible: decision.eligible },
        });
        return true;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return false;
      }
      throw error;
    }
  }
}

function assetKey(code: string, issuer: string | null) {
  return `${code}:${issuer ?? "native"}`;
}
