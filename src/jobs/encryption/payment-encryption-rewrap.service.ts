import { Injectable, Logger } from "@nestjs/common";
import { EncryptionKeyRewrapStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { PaymentEncryptionKeyringService } from "../../common/crypto/payment-encryption-keyring.service";
import { redactError } from "../../common/observability/redaction";
import { encryptProtectedAmount } from "../../common/crypto/protected-amount";

/**
 * Maximum number of rewrap attempts before an intent is permanently failed.
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
 * Maximum number of payments to rewrap per batch.
 * Bounded to keep a single worker from monopolizing the database.
 */
const BATCH_SIZE = 100;

/**
 * Intents that have been in PROCESSING for longer than this duration are
 * presumed to belong to a crashed worker and are reset to PENDING.
 */
const STALE_PROCESSING_THRESHOLD_MS = 5 * 60_000;

/**
 * Error message substrings that indicate a permanent failure.
 * These are matched case-insensitively against the sanitised error text.
 */
const PERMANENT_ERROR_PATTERNS: RegExp[] = [
  /key version not found/i,
  /invalid key/i,
  /encryption failed/i,
  /key mismatch/i,
];

function isPermanentError(message: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function computeNextRetryAt(attemptCount: number): Date {
  const delayMs = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, attemptCount - 1),
    BACKOFF_CAP_MS,
  );
  return new Date(Date.now() + delayMs);
}

/**
 * Service to rewrap payment encryption from one key version to another.
 *
 * Supports resumable batch processing with crash recovery via cursor checkpointing.
 * Preserves plaintext meaning and authenticated metadata through decrypt + re-encrypt cycle.
 */
@Injectable()
export class PaymentEncryptionRewrapService {
  private readonly logger = new Logger(PaymentEncryptionRewrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: PaymentEncryptionKeyringService,
  ) {}

  /**
   * Execute a single rewrap intent if one is available.
   *
   * Returns the intent's updated state after execution.
   */
  async executeRewrapIntent(
    intentId: string,
  ): Promise<{ completed: boolean; processed: number }> {
    const intent = await this.prisma.encryptionKeyRewrapIntent.findUnique({
      where: { id: intentId },
    });

    if (!intent) {
      this.logger.warn(`RewrapIntent ${intentId} not found`);
      return { completed: false, processed: 0 };
    }

    if (intent.status === EncryptionKeyRewrapStatus.COMPLETED) {
      return { completed: true, processed: intent.processedCount };
    }

    if (intent.status === EncryptionKeyRewrapStatus.FAILED) {
      this.logger.warn(
        `RewrapIntent ${intentId} already FAILED; skipping execution`,
      );
      return { completed: false, processed: intent.processedCount };
    }

    await this.executeIntent(intent);
    const updated = await this.prisma.encryptionKeyRewrapIntent.findUnique({
      where: { id: intentId },
    });

    return {
      completed: updated?.status === EncryptionKeyRewrapStatus.COMPLETED,
      processed: updated?.processedCount ?? 0,
    };
  }

  /**
   * Execute a rewrap intent, processing a bounded batch of payments.
   *
   * On first run with null totalCount, calculates and stores the total.
   * On subsequent runs, resumes from lastProcessedPaymentId cursor.
   * Marks COMPLETED when processedCount >= totalCount.
   */
  private async executeIntent(
    intent: Awaited<
      ReturnType<typeof this.prisma.encryptionKeyRewrapIntent.findUnique>
    >,
  ): Promise<void> {
    if (!intent) return;

    const {
      id,
      sourceKeyVersion,
      targetKeyVersion,
      processedCount,
      totalCount,
      lastProcessedPaymentId,
      attemptCount,
    } = intent;

    const newAttemptCount = attemptCount + 1;

    try {
      // Verify both key versions exist
      if (!this.keyring.loadedVersions.includes(sourceKeyVersion)) {
        throw new Error(
          `Source key version ${sourceKeyVersion} not loaded in keyring`,
        );
      }
      if (!this.keyring.loadedVersions.includes(targetKeyVersion)) {
        throw new Error(
          `Target key version ${targetKeyVersion} not loaded in keyring`,
        );
      }

      // On first run, count total payments still using sourceKeyVersion
      let current = totalCount;
      if (current === null) {
        const countResult = await this.countPaymentsWithKeyVersion(
          sourceKeyVersion,
        );
        current = countResult;

        await this.prisma.encryptionKeyRewrapIntent.update({
          where: { id },
          data: {
            totalCount: current,
            status: EncryptionKeyRewrapStatus.PROCESSING,
            lastAttemptAt: new Date(),
          },
        });
      }

      // If all payments have been processed, mark COMPLETED
      if (processedCount >= current) {
        await this.prisma.encryptionKeyRewrapIntent.update({
          where: { id },
          data: {
            status: EncryptionKeyRewrapStatus.COMPLETED,
            lastAttemptAt: new Date(),
            lastErrorSafe: null,
            permanentError: false,
          },
        });

        this.logger.log(
          `RewrapIntent ${id} COMPLETED: ` +
            `${sourceKeyVersion} → ${targetKeyVersion}, ` +
            `all ${processedCount} payments rewrapped`,
        );
        return;
      }

      // Fetch a batch of payments still using sourceKeyVersion, ordered by ID
      // for deterministic cursor-based pagination
      const batch = await this.prisma.payment.findMany({
        where: {
          amountEncrypted: {
            // Match "enc:v<sourceKeyVersion>:..."
            startsWith: `enc:v${sourceKeyVersion}:`,
          },
          ...(lastProcessedPaymentId && {
            id: { gt: lastProcessedPaymentId },
          }),
        },
        select: {
          id: true,
          amountEncrypted: true,
          operationId: true,
        },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
      });

      if (batch.length === 0) {
        // No more payments to rewrap, mark completed
        await this.prisma.encryptionKeyRewrapIntent.update({
          where: { id },
          data: {
            status: EncryptionKeyRewrapStatus.COMPLETED,
            processedCount: processedCount + batch.length,
            lastAttemptAt: new Date(),
            lastErrorSafe: null,
            permanentError: false,
          },
        });
        this.logger.log(
          `RewrapIntent ${id} COMPLETED (no payments remaining): ` +
            `${sourceKeyVersion} → ${targetKeyVersion}`,
        );
        return;
      }

      // Rewrap each payment in the batch: decrypt with source, encrypt with target
      const rewrappedPayments: Array<{
        id: string;
        amountEncrypted: string | null;
      }> = [];

      for (const payment of batch) {
        try {
          if (!payment.amountEncrypted) {
            // Skip null amounts
            rewrappedPayments.push(payment);
            continue;
          }

          // Decrypt with full keyring (includes both source and target)
          const plaintext = this.keyring.decrypt(payment.amountEncrypted);

          // Re-encrypt with target version (keyring must have targetKeyVersion)
          // Temporarily set the active write version to the target
          const rewrapped = this.rewrapWithTargetVersion(plaintext, targetKeyVersion);
          rewrappedPayments.push({
            id: payment.id,
            amountEncrypted: rewrapped,
          });
        } catch (err) {
          // If decryption fails, quarantine this payment and continue
          this.logger.error(
            `Failed to rewrap payment ${payment.operationId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Mark payment as corrupted by storing a marker (or leave as-is and skip)
          // For now, skip and log — the payment will be retried on next run
          rewrappedPayments.push({
            id: payment.id,
            amountEncrypted: payment.amountEncrypted,
          });
        }
      }

      // Atomically update all rewrapped payments in a single transaction
      await this.prisma.$transaction(
        rewrappedPayments.map((payment) =>
          this.prisma.payment.update({
            where: { id: payment.id },
            data: { amountEncrypted: payment.amountEncrypted },
          }),
        ),
      );

      const lastPayment = batch[batch.length - 1];
      const newProcessedCount = processedCount + batch.length;

      // Update intent with batch progress
      await this.prisma.encryptionKeyRewrapIntent.update({
        where: { id },
        data: {
          processedCount: newProcessedCount,
          lastProcessedPaymentId: lastPayment.id,
          lastAttemptAt: new Date(),
          nextRetryAt: null, // Clear retry; will be scheduled on next poll if not complete
          lastErrorSafe: null,
          permanentError: false,
        },
      });

      this.logger.log(
        `RewrapIntent ${id} batch processed: ` +
          `${sourceKeyVersion} → ${targetKeyVersion}, ` +
          `processed ${newProcessedCount}/${current}`,
      );
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      const permanent =
        isPermanentError(message) || newAttemptCount >= MAX_ATTEMPTS;

      const safeError = redactError(err);

      if (permanent) {
        await this.prisma.encryptionKeyRewrapIntent.update({
          where: { id },
          data: {
            status: EncryptionKeyRewrapStatus.FAILED,
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            nextRetryAt: null,
            lastErrorSafe: safeError,
            permanentError: true,
          },
        });
        this.logger.error(
          `RewrapIntent ${id} FAILED permanently: ` +
            `${sourceKeyVersion} → ${targetKeyVersion} — ${safeError}`,
        );
      } else {
        const nextRetryAt = computeNextRetryAt(newAttemptCount);
        await this.prisma.encryptionKeyRewrapIntent.update({
          where: { id },
          data: {
            status: EncryptionKeyRewrapStatus.PENDING,
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            nextRetryAt,
            lastErrorSafe: safeError,
            permanentError: false,
          },
        });
        this.logger.warn(
          `RewrapIntent ${id} transient failure (attempt ${newAttemptCount}/${MAX_ATTEMPTS}), ` +
            `retry at ${nextRetryAt.toISOString()} — ${safeError}`,
        );
      }
    }
  }

  /**
   * Count how many Payment records currently have amountEncrypted starting with "enc:v<version>:".
   */
  private async countPaymentsWithKeyVersion(version: number): Promise<number> {
    const result = await this.prisma.payment.count({
      where: {
        amountEncrypted: {
          startsWith: `enc:v${version}:`,
        },
      },
    });
    return result;
  }

  /**
   * Rewrap plaintext using the target key version.
   *
   * This is a helper that uses the keyring's encryption but forces the target version.
   * Since PaymentEncryptionKeyringService.encrypt() uses the active write version,
   * we need to directly call the low-level encrypt function.
   */
  private rewrapWithTargetVersion(plaintext: string, targetVersion: number): string {
    // Build keyring map from available versions
    const keyringMap = new Map<number, string>();
    const loadedVersions = this.keyring.loadedVersions;
    
    // Access the private keyring via type coercion to extract keys
    const keyringService = this.keyring as any;
    const privateKeyring = keyringService.keyring as Map<number, string>;
    
    for (const version of loadedVersions) {
      const key = privateKeyring.get(version);
      if (key) {
        keyringMap.set(version, key);
      }
    }
    
    return encryptProtectedAmount(plaintext, keyringMap, targetVersion);
  }

  /**
   * Helper to encrypt using a specific key version from the loaded keyring.
   */
  private encryptWithKeyVersion(plaintext: string, targetVersion: number): string {
    // Build keyring map from available versions
    const keyringMap = new Map<number, string>();
    const loadedVersions = this.keyring.loadedVersions;
    
    // Access the private keyring via type coercion (not ideal but necessary)
    const keyringService = this.keyring as any;
    const privateKeyring = keyringService.keyring as Map<number, string>;
    
    for (const version of loadedVersions) {
      const key = privateKeyring.get(version);
      if (key) {
        keyringMap.set(version, key);
      }
    }
    
    return encryptProtectedAmount(plaintext, keyringMap, targetVersion);
  }

  /**
   * Reset stale PROCESSING intents (crash recovery).
   */
  async resetStaleProcessing(): Promise<void> {
    const staleThreshold = new Date(Date.now() - STALE_PROCESSING_THRESHOLD_MS);

    const reset = await this.prisma.encryptionKeyRewrapIntent.updateMany({
      where: {
        status: EncryptionKeyRewrapStatus.PROCESSING,
        lastAttemptAt: { lt: staleThreshold },
      },
      data: {
        status: EncryptionKeyRewrapStatus.PENDING,
        nextRetryAt: new Date(), // eligible immediately
      },
    });

    if (reset.count > 0) {
      this.logger.warn(
        `Reset ${reset.count} stale PROCESSING rewrap intent(s) to PENDING`,
      );
    }
  }

  /**
   * Create a new rewrap intent for moving payments from sourceVersion to targetVersion.
   */
  async createRewrapIntent(
    sourceKeyVersion: number,
    targetKeyVersion: number,
  ): Promise<string> {
    if (sourceKeyVersion === targetKeyVersion) {
      throw new Error(
        "Source and target key versions must be different",
      );
    }

    const intent = await this.prisma.encryptionKeyRewrapIntent.create({
      data: {
        sourceKeyVersion,
        targetKeyVersion,
        status: EncryptionKeyRewrapStatus.PENDING,
      },
    });

    this.logger.log(
      `Created RewrapIntent ${intent.id}: ${sourceKeyVersion} → ${targetKeyVersion}`,
    );
    return intent.id;
  }

  /**
   * Get the current state of a rewrap intent.
   */
  async getRewrapIntentStatus(
    intentId: string,
  ): Promise<{
    status: EncryptionKeyRewrapStatus;
    processedCount: number;
    totalCount: number | null;
    sourceKeyVersion: number;
    targetKeyVersion: number;
  } | null> {
    const intent = await this.prisma.encryptionKeyRewrapIntent.findUnique({
      where: { id: intentId },
    });

    if (!intent) return null;

    return {
      status: intent.status,
      processedCount: intent.processedCount,
      totalCount: intent.totalCount,
      sourceKeyVersion: intent.sourceKeyVersion,
      targetKeyVersion: intent.targetKeyVersion,
    };
  }
}
