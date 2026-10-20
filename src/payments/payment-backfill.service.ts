import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  PaymentBackfillJob,
  PaymentBackfillStatus,
  PaymentClassification,
  Prisma,
  ResourceStatus,
} from "@prisma/client";
import { randomUUID } from "crypto";
import { AuthenticatedUser } from "../auth/auth.types";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { ApiErrorCode } from "../common/dto/api-error.dto";
import { PrismaService } from "../database/prisma.service";
import { AscendingPaymentsPage } from "../stellar/horizon-client";
import { StellarService } from "../stellar/stellar.service";
import { NormalizedPayment } from "../stellar/stellar.types";

/**
 * Bounded ledger-range payment backfills (earnproof-backend#177).
 *
 * A backfill rescans one user's incoming payments over an inclusive ledger
 * range. It is operational recovery, so it is deliberately isolated from the
 * normal forward synchronization:
 *
 * - it walks Horizon oldest-first from its own per-job checkpoint and never
 *   reads or writes any shared sync cursor;
 * - it only inserts payments that do not exist yet (`skipDuplicates` on the
 *   unique operation id), so rows written by normal sync are never rewritten;
 * - it runs in a background worker under a lease, one bounded page per
 *   transaction, so API requests are never blocked on it.
 *
 * See docs/payment-backfills.md.
 */

/** Genesis is ledger 1 and carries no payments. */
export const MIN_BACKFILL_LEDGER = 2;
/** Ledger columns are Postgres INTEGER. */
export const MAX_BACKFILL_LEDGER = 2_147_483_647;
/** Largest inclusive range per job: about one week at ~5s per ledger. */
export const MAX_BACKFILL_LEDGER_SPAN = 120_960;
/** Horizon records per page. */
export const BACKFILL_PAGE_LIMIT = 200;
/** Pages processed per lease before the worker yields. */
export const BACKFILL_PAGES_PER_LEASE = 5;
/** Lease length; renewed on every committed page. */
export const BACKFILL_LEASE_MS = 2 * 60_000;
/** Consecutive claims without a committed page before a job is FAILED. */
export const MAX_BACKFILL_ATTEMPTS = 5;

const ACTIVE_STATUSES: PaymentBackfillStatus[] = [
  PaymentBackfillStatus.PENDING,
  PaymentBackfillStatus.RUNNING,
];

export type CreatePaymentBackfillInput = {
  userId: string;
  startLedger: number;
  endLedger: number;
};

export type BackfillRangeViolation =
  | "not_integer"
  | "below_minimum"
  | "above_maximum"
  | "inverted"
  | "too_large";

/** Validates an inclusive `[startLedger, endLedger]` range. */
export function validateBackfillRange(
  startLedger: number,
  endLedger: number,
): BackfillRangeViolation | null {
  if (!Number.isInteger(startLedger) || !Number.isInteger(endLedger)) {
    return "not_integer";
  }
  if (startLedger < MIN_BACKFILL_LEDGER) return "below_minimum";
  if (endLedger > MAX_BACKFILL_LEDGER) return "above_maximum";
  if (endLedger < startLedger) return "inverted";
  if (endLedger - startLedger + 1 > MAX_BACKFILL_LEDGER_SPAN) {
    return "too_large";
  }
  return null;
}

/** Paging token strictly before every operation in `ledger`. */
export function ledgerStartCursor(ledger: number): bigint {
  return BigInt(ledger) << 32n;
}

/** First paging token after every operation in `ledger`. */
export function ledgerEndExclusive(ledger: number): bigint {
  return (BigInt(ledger) + 1n) << 32n;
}

export type BackfillPagePlan = {
  /** Incoming payments inside the range, after the checkpoint. */
  payments: NormalizedPayment[];
  /** Records inside the range consumed by this page. */
  recordsSeen: number;
  /** Checkpoint to commit; never behind the current one. */
  nextCheckpoint: bigint;
  /** The range end was reached or the feed was exhausted. */
  done: boolean;
  /** The page made no forward progress although more was promised. */
  stalled: boolean;
};

/**
 * Plans one page. Records at or before the checkpoint are ignored, so a
 * replayed page cannot move the checkpoint backward or double-count; the
 * first record at or beyond the range end stops the job.
 */
export function planBackfillPage(
  page: AscendingPaymentsPage,
  checkpoint: bigint,
  endExclusive: bigint,
): BackfillPagePlan {
  const payments: NormalizedPayment[] = [];
  let recordsSeen = 0;
  let lastToid: bigint | null = null;
  let reachedEnd = false;

  for (const record of page.records) {
    if (record.toid === null) continue;
    if (record.toid >= endExclusive) {
      reachedEnd = true;
      break;
    }
    if (record.toid <= checkpoint) continue;
    recordsSeen += 1;
    lastToid = record.toid;
    if (record.payment) payments.push(record.payment);
  }

  const exhausted = page.records.length === 0 || page.nextCursor === null;
  let nextCheckpoint = lastToid ?? checkpoint;
  let stalled = false;

  if (!reachedEnd && !exhausted && lastToid === null) {
    // A page of only malformed or already-seen records: advance by Horizon's
    // own cursor if it moves forward, otherwise refuse to loop on it.
    const cursor = /^\d{1,20}$/.test(page.nextCursor ?? "")
      ? BigInt(page.nextCursor as string)
      : null;
    if (cursor !== null && cursor > checkpoint && cursor < endExclusive) {
      nextCheckpoint = cursor;
    } else if (cursor !== null && cursor >= endExclusive) {
      reachedEnd = true;
    } else {
      stalled = true;
    }
  }

  return {
    payments,
    recordsSeen,
    nextCheckpoint,
    done: reachedEnd || exhausted,
    stalled,
  };
}

type ClaimedJob = Pick<
  PaymentBackfillJob,
  | "id"
  | "userId"
  | "startLedger"
  | "endLedger"
  | "checkpointCursor"
  | "attempts"
  | "accountId"
>;

export type BackfillLeaseOutcome =
  | "idle"
  | "yielded"
  | "completed"
  | "cancelled"
  | "lease_lost"
  | "retrying"
  | "failed";

class LeaseLostError extends Error {}

@Injectable()
export class PaymentBackfillService {
  private readonly keyring: PaymentEncryptionKeyringService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellarService: StellarService,
    configService: ConfigService,
  ) {
    this.keyring = new PaymentEncryptionKeyringService(configService);
  }

  // ---------------------------------------------------------------------------
  // Operator API
  // ---------------------------------------------------------------------------

  /**
   * Persists a new job. Overlapping active jobs for the same user are
   * rejected; the user row is locked so two concurrent requests cannot both
   * pass the overlap check.
   */
  async createJob(actor: AuthenticatedUser, input: CreatePaymentBackfillInput) {
    const violation = validateBackfillRange(input.startLedger, input.endLedger);
    if (violation) {
      throw new BadRequestException({
        code: ApiErrorCode.INVALID_INPUT,
        message: RANGE_MESSAGES[violation],
      });
    }

    const job = await this.prisma.$transaction(async (tx) => {
      const [user] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE
      `;
      if (!user) {
        throw new NotFoundException({
          code: ApiErrorCode.NOT_FOUND,
          message: "User not found",
        });
      }

      const overlapping = await tx.paymentBackfillJob.findFirst({
        where: {
          userId: input.userId,
          status: { in: ACTIVE_STATUSES },
          startLedger: { lte: input.endLedger },
          endLedger: { gte: input.startLedger },
        },
        select: { id: true },
      });
      if (overlapping) {
        throw new ConflictException({
          code: ApiErrorCode.CONFLICT,
          message:
            "An active backfill for this user already covers part of the requested ledger range",
        });
      }

      const created = await tx.paymentBackfillJob.create({
        data: {
          userId: input.userId,
          requestedById: actor.id,
          startLedger: input.startLedger,
          endLedger: input.endLedger,
          status: PaymentBackfillStatus.PENDING,
        },
      });

      // Inside the transaction: an unaudited backfill must not exist.
      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId: actor.id,
          action: "payment_backfill.requested",
          resourceType: "payment_backfill",
          resourceId: created.id,
          metadata: {
            startLedger: input.startLedger,
            endLedger: input.endLedger,
          },
        },
      });
      return created;
    });

    return this.toDto(job);
  }

  async getJob(jobId: string) {
    const job = await this.prisma.paymentBackfillJob.findUnique({
      where: { id: jobId },
    });
    if (!job) {
      throw new NotFoundException({
        code: ApiErrorCode.NOT_FOUND,
        message: "Backfill job not found",
      });
    }
    return this.toDto(job);
  }

  /**
   * Cancellation policy: a PENDING job is cancelled immediately. A RUNNING
   * job is flagged and stops at its next page boundary; pages already
   * committed are kept, because they only contain payments that are real and
   * were missing. Terminal jobs cannot be cancelled.
   */
  async cancelJob(actor: AuthenticatedUser, jobId: string) {
    const now = new Date();
    const job = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.paymentBackfillJob.findUnique({
        where: { id: jobId },
        select: { id: true, status: true },
      });
      if (!existing) {
        throw new NotFoundException({
          code: ApiErrorCode.NOT_FOUND,
          message: "Backfill job not found",
        });
      }

      const pending = await tx.paymentBackfillJob.updateMany({
        where: { id: jobId, status: PaymentBackfillStatus.PENDING },
        data: {
          status: PaymentBackfillStatus.CANCELLED,
          cancelRequestedAt: now,
          completedAt: now,
        },
      });
      const running =
        pending.count > 0
          ? { count: 0 }
          : await tx.paymentBackfillJob.updateMany({
              where: {
                id: jobId,
                status: PaymentBackfillStatus.RUNNING,
                cancelRequestedAt: null,
              },
              data: { cancelRequestedAt: now },
            });
      if (pending.count === 0 && running.count === 0) {
        throw new ConflictException({
          code: ApiErrorCode.CONFLICT,
          message: "The backfill job has already finished or is being cancelled",
        });
      }

      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId: actor.id,
          action: "payment_backfill.cancelled",
          resourceType: "payment_backfill",
          resourceId: jobId,
          metadata: { previousStatus: existing.status },
        },
      });

      return tx.paymentBackfillJob.findUniqueOrThrow({ where: { id: jobId } });
    });

    return this.toDto(job);
  }

  // ---------------------------------------------------------------------------
  // Worker
  // ---------------------------------------------------------------------------

  /**
   * Claims one job and processes up to BACKFILL_PAGES_PER_LEASE pages.
   * Each page and its checkpoint commit in one transaction, so a worker that
   * dies mid-job leaves the checkpoint at the last committed page and the next
   * claim (after the lease expires) resumes from there.
   */
  async runLease(owner: string = randomUUID()): Promise<BackfillLeaseOutcome> {
    await this.finalizeAbandonedCancellations();

    const job = await this.claimNextJob(owner);
    if (!job) return "idle";

    for (let page = 0; page < BACKFILL_PAGES_PER_LEASE; page += 1) {
      const outcome = await this.processPage(job, owner);
      if (outcome !== "continue") return outcome;
    }

    // Yield: release the lease so other jobs get a turn; progress is kept.
    await this.prisma.paymentBackfillJob.updateMany({
      where: {
        id: job.id,
        leaseOwner: owner,
        status: PaymentBackfillStatus.RUNNING,
      },
      data: {
        status: PaymentBackfillStatus.PENDING,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    return "yielded";
  }

  private async claimNextJob(owner: string): Promise<ClaimedJob | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + BACKFILL_LEASE_MS);
    const [claimed] = await this.prisma.$queryRaw<ClaimedJob[]>`
      WITH candidate AS (
        SELECT "id"
        FROM "PaymentBackfillJob"
        WHERE "cancelRequestedAt" IS NULL
          AND (
            "status" = ${PaymentBackfillStatus.PENDING}::"PaymentBackfillStatus"
            OR (
              "status" = ${PaymentBackfillStatus.RUNNING}::"PaymentBackfillStatus"
              AND "leaseExpiresAt" < ${now}
            )
          )
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "PaymentBackfillJob" AS job
      SET
        "status" = ${PaymentBackfillStatus.RUNNING}::"PaymentBackfillStatus",
        "leaseOwner" = ${owner},
        "leaseExpiresAt" = ${leaseUntil},
        "attempts" = job."attempts" + 1,
        "updatedAt" = ${now}
      FROM candidate
      WHERE job."id" = candidate."id"
      RETURNING
        job."id",
        job."userId",
        job."startLedger",
        job."endLedger",
        job."checkpointCursor",
        job."attempts",
        job."accountId"
    `;
    return claimed ?? null;
  }

  /**
   * A RUNNING job flagged for cancellation whose worker disappeared would
   * otherwise stay RUNNING forever, because claims skip flagged jobs.
   */
  private async finalizeAbandonedCancellations() {
    const now = new Date();
    await this.prisma.paymentBackfillJob.updateMany({
      where: {
        status: PaymentBackfillStatus.RUNNING,
        cancelRequestedAt: { not: null },
        leaseExpiresAt: { lt: now },
      },
      data: {
        status: PaymentBackfillStatus.CANCELLED,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    });
  }

  private async processPage(
    job: ClaimedJob,
    owner: string,
  ): Promise<"continue" | Exclude<BackfillLeaseOutcome, "idle" | "yielded">> {
    const user = await this.prisma.user.findUnique({
      where: { id: job.userId },
      select: { walletAddress: true },
    });
    if (!user) {
      return this.fail(job, owner, "user_missing", true);
    }
    // A job created by a payment account rotation (#321) scans the account it
    // was planned for, never whichever account the user holds by the time it
    // runs; legacy jobs (accountId NULL) scan the user's wallet as before.
    const scannedAccount = job.accountId ?? user.walletAddress;

    const checkpoint =
      job.checkpointCursor !== null && /^\d{1,20}$/.test(job.checkpointCursor)
        ? BigInt(job.checkpointCursor)
        : ledgerStartCursor(job.startLedger);
    const endExclusive = ledgerEndExclusive(job.endLedger);

    let page: AscendingPaymentsPage;
    try {
      page = await this.stellarService.readPaymentsPageAscending(
        scannedAccount,
        { cursor: checkpoint.toString(), pageLimit: BACKFILL_PAGE_LIMIT },
      );
    } catch {
      return this.fail(job, owner, "horizon_unavailable", false);
    }

    const plan = planBackfillPage(page, checkpoint, endExclusive);
    if (plan.stalled) {
      return this.fail(job, owner, "horizon_cursor_stalled", false);
    }

    const eligibleAssets = await this.supportedAssetKeys();
    const now = new Date();

    try {
      await this.prisma.$transaction(async (tx) => {
        const inserted =
          plan.payments.length === 0
            ? { count: 0 }
            : await tx.payment.createMany({
                data: plan.payments.map((payment) =>
                  this.toPaymentRow(job.userId, payment, eligibleAssets),
                ),
                // Deduplication against normal sync: an operation it already
                // stored is left exactly as it is.
                skipDuplicates: true,
              });

        const committed = await tx.paymentBackfillJob.updateMany({
          where: {
            id: job.id,
            leaseOwner: owner,
            status: PaymentBackfillStatus.RUNNING,
            cancelRequestedAt: null,
          },
          data: {
            checkpointCursor: plan.nextCheckpoint.toString(),
            pagesProcessed: { increment: 1 },
            recordsSeen: { increment: plan.recordsSeen },
            paymentsCreated: { increment: inserted.count },
            duplicatesSkipped: {
              increment: plan.payments.length - inserted.count,
            },
            lastErrorSafe: null,
            // Attempts count consecutive claims without progress.
            attempts: 0,
            ...(plan.done
              ? {
                  status: PaymentBackfillStatus.COMPLETED,
                  completedAt: now,
                  leaseOwner: null,
                  leaseExpiresAt: null,
                }
              : { leaseExpiresAt: new Date(now.getTime() + BACKFILL_LEASE_MS) }),
          },
        });
        if (committed.count === 0) {
          // Lease lost or cancellation requested: roll this page back so
          // counters and checkpoint stay exact.
          throw new LeaseLostError();
        }
      });
    } catch (error) {
      if (error instanceof LeaseLostError) {
        return this.stopAfterLostLease(job.id, owner);
      }
      return this.fail(job, owner, "database_error", false);
    }

    job.checkpointCursor = plan.nextCheckpoint.toString();
    job.attempts = 0;
    return plan.done ? "completed" : "continue";
  }

  private async stopAfterLostLease(
    jobId: string,
    owner: string,
  ): Promise<"cancelled" | "lease_lost"> {
    const now = new Date();
    const cancelled = await this.prisma.paymentBackfillJob.updateMany({
      where: {
        id: jobId,
        leaseOwner: owner,
        status: PaymentBackfillStatus.RUNNING,
        cancelRequestedAt: { not: null },
      },
      data: {
        status: PaymentBackfillStatus.CANCELLED,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    });
    return cancelled.count > 0 ? "cancelled" : "lease_lost";
  }

  private async fail(
    job: ClaimedJob,
    owner: string,
    reason: string,
    permanent: boolean,
  ): Promise<"retrying" | "failed"> {
    const exhausted = permanent || job.attempts >= MAX_BACKFILL_ATTEMPTS;
    await this.prisma.paymentBackfillJob.updateMany({
      where: { id: job.id, leaseOwner: owner },
      data: exhausted
        ? {
            status: PaymentBackfillStatus.FAILED,
            lastErrorSafe: reason,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
          }
        : {
            status: PaymentBackfillStatus.PENDING,
            lastErrorSafe: reason,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
    });
    return exhausted ? "failed" : "retrying";
  }

  private async supportedAssetKeys() {
    const assets = await this.prisma.supportedAsset.findMany({
      where: { status: ResourceStatus.ACTIVE },
      select: { code: true, issuer: true },
    });
    return new Set(assets.map((asset) => assetKey(asset.code, asset.issuer)));
  }

  private toPaymentRow(
    userId: string,
    payment: NormalizedPayment,
    eligibleAssets: Set<string>,
  ): Prisma.PaymentCreateManyInput {
    return {
      userId,
      operationId: payment.operationId,
      stellarTransactionHash: payment.stellarTransactionHash,
      sourceAddress: payment.sourceAddress,
      destinationAddress: payment.destinationAddress,
      assetCode: payment.assetCode,
      assetIssuer: payment.assetIssuer,
      amountEncrypted: this.keyring.encrypt(payment.amount),
      occurredAt: payment.occurredAt,
      // Memos are not fetched by backfills (one Horizon call per transaction
      // would make the job unbounded); normal sync enriches them later.
      classification: PaymentClassification.UNKNOWN,
      isEligible: eligibleAssets.has(
        assetKey(payment.assetCode, payment.assetIssuer),
      ),
    };
  }

  private toDto(job: PaymentBackfillJob) {
    return {
      id: job.id,
      userId: job.userId,
      startLedger: job.startLedger,
      endLedger: job.endLedger,
      status: job.status,
      checkpointCursor: job.checkpointCursor,
      pagesProcessed: job.pagesProcessed,
      recordsSeen: job.recordsSeen,
      paymentsCreated: job.paymentsCreated,
      duplicatesSkipped: job.duplicatesSkipped,
      attempts: job.attempts,
      cancelRequested: job.cancelRequestedAt !== null,
      lastErrorSafe: job.lastErrorSafe,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }
}

const RANGE_MESSAGES: Record<BackfillRangeViolation, string> = {
  not_integer: "startLedger and endLedger must be integers",
  below_minimum: `startLedger must be at least ${MIN_BACKFILL_LEDGER}`,
  above_maximum: `endLedger must be at most ${MAX_BACKFILL_LEDGER}`,
  inverted: "endLedger must not be before startLedger",
  too_large: `A backfill may cover at most ${MAX_BACKFILL_LEDGER_SPAN} ledgers`,
};

function assetKey(code: string, issuer: string | null) {
  return `${code}:${issuer ?? "native"}`;
}
