import {
  Injectable,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import {
  AnchoringOperation,
  AnchoringStatus,
  QuarantineDecision,
  QuarantineReasonCode,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { redactError } from "../common/observability/redaction";
import { StructuredLogger } from "../common/logger";
import {
  AnchorProofInput,
  ContractAnchoringService,
} from "../proofs/contract-anchoring.service";
import { isPermanentContractError } from "../proofs/contract-error";

/**
 * Upper bound on how long shutdown waits for an in-flight poll cycle to
 * finish draining before giving up (earnproof-backend#68). A batch is at
 * most BATCH_SIZE intents, each a single CLI invocation, so this generously
 * covers a healthy drain without letting one stuck call block shutdown
 * indefinitely — the orchestrator's own SIGKILL grace period is the backstop.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;

/**
 * Maximum number of delivery attempts before an intent is permanently failed.
 * Intentionally capped so that unrecoverable errors (e.g., contract already
 * registered) do not retry indefinitely.
 */
const MAX_ATTEMPTS = 10;

/**
 * Base backoff delay in milliseconds (30 s).
 * Each retry doubles the delay up to BACKOFF_CAP_MS.
 */
const BACKOFF_BASE_MS = 30_000;

/** Maximum backoff ceiling (1 hour). */
const BACKOFF_CAP_MS = 60 * 60_000;

/**
 * Number of intents to claim per poll cycle.
 * Keeps a single worker instance from monopolising all pending work on startup.
 */
const BATCH_SIZE = 5;

/**
 * Intents that have been in PROCESSING for longer than this duration are
 * presumed to belong to a crashed worker and are reset to PENDING.
 */
const STALE_PROCESSING_THRESHOLD_MS = 5 * 60_000;

/**
 * Error message substrings indicating the *input itself* can never succeed,
 * no matter how many times it is retried (a malformed or unresolvable
 * request), as opposed to the chain refusing an otherwise well-formed one.
 * Matched case-insensitively against the sanitised error text.
 */
const POISON_INPUT_PATTERNS: RegExp[] = [
  /proof not found/i,
  /invalid contract id/i,
  /contract not found/i,
];

/**
 * Error message substrings indicating the chain explicitly rejected an
 * otherwise well-formed request. Matched case-insensitively.
 */
const CHAIN_REJECTED_PATTERNS: RegExp[] = [
  /already registered/i,
  /already exists/i,
  /unauthorized/i,
  /access denied/i,
];

const PERMANENT_ERROR_PATTERNS: RegExp[] = [
  ...POISON_INPUT_PATTERNS,
  ...CHAIN_REJECTED_PATTERNS,
];

/**
 * Strip potential secrets from an error message before storing.
 * Removes Stellar secret-key-like tokens (S…56 chars) and KEY=VALUE pairs.
 */
function isPermanentError(message: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function isPoisonInput(message: string): boolean {
  return POISON_INPUT_PATTERNS.some((pattern) => pattern.test(message));
}

function computeNextRetryAt(attemptCount: number): Date {
  const delayMs = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, attemptCount - 1),
    BACKOFF_CAP_MS,
  );
  return new Date(Date.now() + delayMs);
}

@Injectable()
export class AnchoringWorkerService implements OnApplicationShutdown {
  private readonly logger = new StructuredLogger(AnchoringWorkerService.name);

  /** Set once shutdown begins — `poll()` becomes a no-op after this. */
  private draining = false;

  /**
   * The currently in-flight poll cycle, if any. `onApplicationShutdown`
   * awaits this (bounded by SHUTDOWN_DRAIN_TIMEOUT_MS) instead of tearing
   * the process down mid-batch, so a claimed intent either finishes its
   * CLI call and is written CONFIRMED/FAILED, or is left PROCESSING for
   * `resetStaleProcessing` to reclaim on the next healthy worker's tick —
   * never left half-committed.
   */
  private inFlightCycle: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly anchoring: ContractAnchoringService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Main poll loop — runs every 10 seconds.
   *
   * Two phases per tick:
   * 1. Reset stale PROCESSING intents (crash recovery).
   * 2. Claim and process a batch of PENDING intents.
   */
  @Interval(10_000)
  async poll(): Promise<void> {
    if (this.draining) {
      // New work stops being picked up as soon as shutdown begins
      // (earnproof-backend#68) — only a cycle already in flight is allowed
      // to finish.
      return;
    }
    if (!this.config.get<boolean>("contractAnchoring.enabled")) {
      return;
    }

    const cycle = this.runCycle();
    this.inFlightCycle = cycle;
    try {
      await cycle;
    } finally {
      if (this.inFlightCycle === cycle) {
        this.inFlightCycle = null;
      }
    }
  }

  private async runCycle(): Promise<void> {
    await this.resetStaleProcessing();
    await this.processBatch();
  }

  /**
   * Called by Nest during shutdown (requires `app.enableShutdownHooks()` in
   * main.ts — see that file). Stops new poll cycles immediately and waits
   * for any cycle already running to finish, up to
   * SHUTDOWN_DRAIN_TIMEOUT_MS.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.draining = true;
    this.logger.log(
      `Draining: no new poll cycles will start (signal=${signal ?? "unknown"})`,
    );

    const cycle = this.inFlightCycle;
    if (!cycle) {
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS);
    });

    let drained: boolean;
    try {
      drained = await Promise.race([
        cycle.then(() => true).catch(() => true),
        timeout.then(() => false),
      ]);
    } finally {
      // Whichever side of the race lost, its timer/handle must not outlive
      // this call — an uncleared setTimeout otherwise keeps the process
      // (and, in tests, the Jest worker) alive after shutdown has already
      // decided the outcome.
      clearTimeout(timer);
    }

    if (drained) {
      this.logger.log("In-flight poll cycle finished draining");
    } else {
      this.logger.warn(
        `In-flight poll cycle did not finish within ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms — ` +
          "any intent still PROCESSING will be reclaimed by resetStaleProcessing " +
          "on a future worker's tick",
      );
    }
  }

  /**
   * Exposed for testing — processes a single intent by ID without going through
   * the poll/claim cycle.
   */
  async processIntent(intentId: string): Promise<void> {
    const intent = await this.prisma.anchoringIntent.findUnique({
      where: { id: intentId },
      include: { proof: { select: { commitment: true, expiresAt: true } } },
    });

    if (!intent) {
      this.logger.warn(`AnchoringIntent ${intentId} not found`);
      return;
    }

    if (
      intent.status === AnchoringStatus.CONFIRMED ||
      intent.status === AnchoringStatus.FAILED ||
      intent.status === AnchoringStatus.QUARANTINED
    ) {
      // Already terminal — nothing to do. Handles duplicate delivery. A
      // QUARANTINED intent only leaves this state through an operator's
      // explicit redrive (ProofsService.retryProofAnchoring), never here.
      return;
    }

    await this.executeIntent(intent);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async resetStaleProcessing(): Promise<void> {
    const staleThreshold = new Date(Date.now() - STALE_PROCESSING_THRESHOLD_MS);

    const reset = await this.prisma.anchoringIntent.updateMany({
      where: {
        status: AnchoringStatus.PROCESSING,
        lastAttemptAt: { lt: staleThreshold },
      },
      data: {
        status: AnchoringStatus.PENDING,
        nextRetryAt: new Date(), // eligible immediately
      },
    });

    if (reset.count > 0) {
      this.logger.warn(
        `Reset ${reset.count} stale PROCESSING intent(s) to PENDING`,
      );
    }
  }

  /**
   * Decides which operations may be claimed this cycle, and how many, from the
   * state of their dependency circuits.
   *
   * This is the backpressure (issue #203). An operation whose circuit is *open*
   * is excluded from the claim entirely — the worker stops pulling intents it
   * cannot serve, rather than claiming them only to bounce each off an open
   * circuit. An operation whose circuit is *half-open* is admitted at a budget
   * of one, so recovery is tested with a single probing intent before the full
   * batch resumes. Ordering and idempotency are untouched: the claim is still
   * `ORDER BY createdAt`, and the idempotency guard in {@link executeIntent}
   * still runs. A durable intent that is not claimed simply stays PENDING.
   */
  private claimPlan(): { operations: AnchoringOperation[]; budget: number } {
    const register = this.anchoring.circuitState("register");
    const revoke = this.anchoring.circuitState("revoke");

    const operations: AnchoringOperation[] = [];
    if (register !== "open") operations.push(AnchoringOperation.REGISTER);
    if (revoke !== "open") operations.push(AnchoringOperation.REVOKE);

    if (operations.length === 0) return { operations, budget: 0 };

    // If any admitted operation is only half-open, keep the whole cycle to a
    // single probe: a half-open circuit must not be handed a full batch.
    const probing =
      (register === "half_open" && operations.includes(AnchoringOperation.REGISTER)) ||
      (revoke === "half_open" && operations.includes(AnchoringOperation.REVOKE));

    return { operations, budget: probing ? 1 : BATCH_SIZE };
  }

  private async processBatch(): Promise<void> {
    const now = new Date();

    const plan = this.claimPlan();
    if (plan.budget === 0) {
      // Every dependency circuit is open. Claim nothing and let the intents
      // wait; a half-open probe will resume them once a circuit permits it.
      this.logger.warn(
        "Anchoring backpressure: all contract circuits open; not claiming intents",
      );
      return;
    }

    // The operations this claim is allowed to touch, as text for an `ANY`
    // comparison — avoids binding a Postgres enum array while still filtering
    // out an operation whose circuit is open.
    const allowedOperations = plan.operations.map((operation) => operation.toString());

    // Atomically claim a batch: use raw SQL UPDATE...RETURNING to ensure only
    // rows that THIS worker transitions from PENDING→PROCESSING are returned.
    // This prevents concurrent workers from double-processing the same intent.
    //
    // The UPDATE statement must include the WHERE condition (nextRetryAt check)
    // to limit the set, and only return the rows actually updated by this
    // statement, not rows selected before update.
    const claimed = await this.prisma.$queryRaw<
      Array<{
        id: string;
        proofId: string;
        operation: AnchoringOperation;
        status: AnchoringStatus;
        attemptCount: number;
        lastAttemptAt: Date | null;
        nextRetryAt: Date | null;
        transactionHash: string | null;
        ledger: string | null;
        lastErrorSafe: string | null;
        permanentError: boolean;
        createdAt: Date;
        updatedAt: Date;
      }>
    >`
      WITH candidates AS (
        SELECT id
        FROM "AnchoringIntent"
        WHERE
          status = ${AnchoringStatus.PENDING}::"AnchoringStatus"
          AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= ${now})
          AND operation::text = ANY(${allowedOperations})
        ORDER BY "createdAt" ASC
        LIMIT ${plan.budget}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "AnchoringIntent" AS intent
      SET
        status = ${AnchoringStatus.PROCESSING}::"AnchoringStatus",
        "lastAttemptAt" = ${now}
      FROM candidates
      WHERE intent.id = candidates.id
      RETURNING
        intent.id,
        intent."proofId",
        intent.operation,
        intent.status,
        intent."attemptCount",
        intent."lastAttemptAt",
        intent."nextRetryAt",
        intent."transactionHash",
        intent.ledger,
        intent."lastErrorSafe",
        intent."permanentError",
        intent."createdAt",
        intent."updatedAt"
    `;

    // Fetch the full intent records (including proof data) for execution.
    // Since we already claimed them atomically above, we just need to
    // retrieve the proof commitment and expiresAt.
    for (const intentRow of claimed) {
      const fullIntent = await this.prisma.anchoringIntent.findUnique({
        where: { id: intentRow.id },
        include: { proof: { select: { commitment: true, expiresAt: true } } },
      });

      if (fullIntent) {
        await this.executeIntent(fullIntent);
      }
    }
  }

  private async executeIntent(
    intent: Awaited<ReturnType<typeof this.prisma.anchoringIntent.findUnique>> & {
      proof: { commitment: string | null; expiresAt: Date };
    },
  ): Promise<void> {
    if (!intent) return;

    const { id, proofId, operation, attemptCount, proof } = intent;

    // Idempotency guard: if a CONFIRMED record already exists for this
    // (proofId, operation) pair, mark this intent confirmed and skip the CLI.
    const existing = await this.prisma.anchoringIntent.findFirst({
      where: {
        proofId,
        operation,
        status: AnchoringStatus.CONFIRMED,
        id: { not: id },
      },
      select: { transactionHash: true, ledger: true },
    });

    if (existing) {
      await this.prisma.anchoringIntent.update({
        where: { id },
        data: {
          status: AnchoringStatus.CONFIRMED,
          transactionHash: existing.transactionHash,
          ledger: existing.ledger,
          lastErrorSafe: null,
        },
      });
      this.logger.log(
        `Intent ${id} confirmed via idempotency check (already confirmed: ${operation} for proof ${proofId})`,
      );
      return;
    }

    const newAttemptCount = attemptCount + 1;

    try {
      let transactionHash: string;

      if (operation === AnchoringOperation.REGISTER) {
        const anchorInput: AnchorProofInput = {
          proofId,
          commitment: proof.commitment ?? proofId,
          expiresAt: proof.expiresAt,
        };
        const result = await this.anchoring.anchorProof(anchorInput);

        if (!result.anchored) {
          if (result.reason === "circuit_open") {
            await this.releaseUnclaimed(id, operation, proofId);
            return;
          }
          // anchorProof returned anchored:false without throwing — treat as
          // transient unless the reason is "disabled" (config issue, permanent).
          const isFatal = result.reason === "disabled";
          throw Object.assign(
            new Error(result.error ?? `Anchoring ${result.reason}`),
            { permanent: isFatal },
          );
        }
        transactionHash = result.transactionHash;
      } else {
        // REVOKE
        const result = await this.anchoring.revokeProof(proofId);

        if (!result.anchored) {
          if (result.reason === "circuit_open") {
            await this.releaseUnclaimed(id, operation, proofId);
            return;
          }
          const isFatal = result.reason === "disabled";
          throw Object.assign(
            new Error(result.error ?? `Revocation ${result.reason}`),
            { permanent: isFatal },
          );
        }
        transactionHash = result.transactionHash;
      }

      // Parse ledger from transaction hash — the CLI may return
      // "<txhash>:<ledger>" or just "<txhash>". Store what we get.
      const [txHash, ledger] = transactionHash.includes(":")
        ? transactionHash.split(":", 2)
        : [transactionHash, undefined];

      // Write CONFIRMED + update Proof.contractTransactionHash in one
      // transaction so a crash between the two writes cannot leave them
      // inconsistent.
      await this.prisma.$transaction([
        this.prisma.anchoringIntent.update({
          where: { id },
          data: {
            status: AnchoringStatus.CONFIRMED,
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            transactionHash: txHash,
            ledger: ledger ?? null,
            lastErrorSafe: null,
            permanentError: false,
          },
        }),
        this.prisma.proof.update({
          where: { id: proofId },
          data: { contractTransactionHash: txHash },
        }),
      ]);

      this.logger.log(
        `Intent ${id} CONFIRMED: ${operation} for proof ${proofId} tx=${txHash}`,
      );
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      const explicitlyPermanent =
        err instanceof Error && (err as Error & { permanent?: boolean }).permanent;
      const poisonInput = isPoisonInput(message);
      const chainRejected =
        !poisonInput && (explicitlyPermanent || isPermanentError(message));
      const attemptsExhausted = newAttemptCount >= MAX_ATTEMPTS;
      const permanent =
        poisonInput ||
        chainRejected ||
        attemptsExhausted ||
        isPermanentContractError(message);

      const safeError = redactError(err);

      if (permanent) {
        // Quarantined, not just FAILED: the worker stops touching this
        // intent entirely until an operator redrives or abandons it (see
        // ProofsService.retryProofAnchoring / abandonProofAnchoring).
        // Idempotent under concurrent workers because this UPDATE only ever
        // reaches an intent this worker itself claimed to PROCESSING in
        // processBatch's atomic FOR UPDATE SKIP LOCKED claim.
        const quarantineReasonCode = poisonInput
          ? QuarantineReasonCode.POISON_INPUT
          : chainRejected
            ? QuarantineReasonCode.CHAIN_REJECTED
            : QuarantineReasonCode.MAX_ATTEMPTS_EXCEEDED;

        await this.prisma.anchoringIntent.update({
          where: { id },
          data: {
            status: AnchoringStatus.QUARANTINED,
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            nextRetryAt: null,
            lastErrorSafe: safeError,
            permanentError: true,
            quarantinedAt: new Date(),
            quarantineReasonCode,
            quarantineDecision: QuarantineDecision.PENDING,
          },
        });
        this.logger.error(
          `Intent ${id} QUARANTINED (${quarantineReasonCode}): ${operation} for proof ${proofId} — ${safeError}`,
        );
      } else {
        const nextRetryAt = computeNextRetryAt(newAttemptCount);
        await this.prisma.anchoringIntent.update({
          where: { id },
          data: {
            status: AnchoringStatus.PENDING,
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            nextRetryAt,
            lastErrorSafe: safeError,
            permanentError: false,
          },
        });
        this.logger.warn(
          `Intent ${id} transient failure (attempt ${newAttemptCount}/${MAX_ATTEMPTS}), ` +
            `retry at ${nextRetryAt.toISOString()} — ${safeError}`,
        );
      }
    }
  }

  /**
   * Returns an intent to PENDING without consuming an attempt.
   *
   * Used when the dependency circuit refused the call: the contract was never
   * touched, so this is not a failure of the intent and must not count against
   * its retry budget or push it toward permanent FAILED. The durable intent is
   * simply released, eligible immediately, to be re-claimed once a circuit probe
   * lets work resume — preserving the intent without losing it.
   */
  private async releaseUnclaimed(
    id: string,
    operation: AnchoringOperation,
    proofId: string,
  ): Promise<void> {
    await this.prisma.anchoringIntent.update({
      where: { id },
      data: {
        status: AnchoringStatus.PENDING,
        nextRetryAt: new Date(),
      },
    });
    this.logger.warn(
      `Intent ${id} released unclaimed (circuit open): ${operation} for proof ${proofId}`,
    );
  }
}
