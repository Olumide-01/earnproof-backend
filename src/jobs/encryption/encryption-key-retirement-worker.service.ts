import { Injectable, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { EncryptionKeyRetirementStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { PaymentEncryptionRetirementService } from "./payment-encryption-retirement.service";
import { StructuredLogger } from "../../common/logger";

/**
 * Upper bound on how long shutdown waits for an in-flight poll cycle to
 * finish draining. See AnchoringWorkerService for same pattern.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;

/**
 * Number of intents to claim per poll cycle.
 * Retirement jobs are typically quick (just counting), so can process multiple.
 */
const BATCH_SIZE = 5;

/**
 * Worker service that polls for pending encryption key retirement intents and executes them.
 *
 * Runs on a configurable interval (default: every 10 seconds).
 * Implements atomic batch claiming, crash recovery, and graceful shutdown.
 */
@Injectable()
export class EncryptionKeyRetirementWorkerService implements OnApplicationShutdown {
  private readonly logger = new StructuredLogger(
    EncryptionKeyRetirementWorkerService.name,
  );

  /** Set once shutdown begins — `poll()` becomes a no-op after this. */
  private draining = false;

  /**
   * The currently in-flight poll cycle, if any. `onApplicationShutdown`
   * awaits this to ensure a claimed intent either finishes or is left for
   * `resetStaleGuarding` to reclaim on the next healthy worker's tick.
   */
  private inFlightCycle: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly retirementService: PaymentEncryptionRetirementService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Main poll loop — runs every 10 seconds.
   *
   * Two phases per tick:
   * 1. Reset stale GUARDING intents (crash recovery).
   * 2. Claim and process a batch of PENDING intents.
   */
  @Interval(10_000)
  async poll(): Promise<void> {
    if (this.draining) {
      return;
    }

    if (!this.config.get<boolean>("paymentEncryptionRetirementEnabled")) {
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
    await this.retirementService.resetStaleGuarding();
    await this.processBatch();
  }

  /**
   * Called by Nest during shutdown. Stops new poll cycles immediately and waits
   * for any cycle already running to finish, up to SHUTDOWN_DRAIN_TIMEOUT_MS.
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
      clearTimeout(timer);
    }

    if (drained) {
      this.logger.log("In-flight poll cycle finished draining");
    } else {
      this.logger.warn(
        `In-flight poll cycle did not finish within ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms — ` +
          "any intent still GUARDING will be reclaimed by resetStaleGuarding " +
          "on a future worker's tick",
      );
    }
  }

  /**
   * Exposed for testing — processes a single intent by ID without going through
   * the poll/claim cycle.
   */
  async processIntent(intentId: string): Promise<void> {
    await this.retirementService.executeRetirementIntent(intentId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async processBatch(): Promise<void> {
    const now = new Date();

    // Atomically claim a batch of PENDING intents
    const claimed = await this.prisma.$queryRaw<
      Array<{ id: string }>
    >`
      WITH candidates AS (
        SELECT id
        FROM "EncryptionKeyRetirementIntent"
        WHERE
          status = ${EncryptionKeyRetirementStatus.PENDING}::"EncryptionKeyRetirementStatus"
          AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= ${now})
        ORDER BY "createdAt" ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "EncryptionKeyRetirementIntent" AS intent
      SET
        status = ${EncryptionKeyRetirementStatus.GUARDING}::"EncryptionKeyRetirementStatus",
        "lastAttemptAt" = ${now}
      FROM candidates
      WHERE intent.id = candidates.id
      RETURNING intent.id
    `;

    for (const intentRow of claimed) {
      await this.retirementService.executeRetirementIntent(intentRow.id);
    }
  }
}
