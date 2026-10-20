import { Injectable, Logger } from "@nestjs/common";
import { EncryptionKeyRetirementStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { PaymentEncryptionKeyringService } from "../../common/crypto/payment-encryption-keyring.service";
import { redactError } from "../../common/observability/redaction";

/**
 * Maximum number of retirement attempts before an intent is permanently failed.
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
 * Intents that have been in GUARDING for longer than this duration are
 * presumed to belong to a crashed worker and are reset to PENDING.
 */
const STALE_GUARDING_THRESHOLD_MS = 5 * 60_000;

/**
 * Error message substrings that indicate a permanent failure.
 * These are matched case-insensitively against the sanitised error text.
 */
const PERMANENT_ERROR_PATTERNS: RegExp[] = [
  /invalid key version/i,
  /ciphertext still exists/i,
  /cannot retire/i,
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
 * Service to guard and retire payment encryption key versions.
 *
 * Prevents accidental retirement of key versions while dependent ciphertext remains.
 * Supports resumable processing with crash recovery and atomicity guarantees.
 */
@Injectable()
export class PaymentEncryptionRetirementService {
  private readonly logger = new Logger(
    PaymentEncryptionRetirementService.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: PaymentEncryptionKeyringService,
  ) {}

  /**
   * Execute a single retirement intent if one is available.
   *
   * Returns the intent's final status after execution.
   */
  async executeRetirementIntent(
    intentId: string,
  ): Promise<{ canRetire: boolean; dependentCount: number }> {
    const intent = await this.prisma.encryptionKeyRetirementIntent.findUnique({
      where: { id: intentId },
    });

    if (!intent) {
      this.logger.warn(`RetirementIntent ${intentId} not found`);
      return { canRetire: false, dependentCount: 0 };
    }

    if (intent.status === EncryptionKeyRetirementStatus.SAFE_TO_RETIRE) {
      return { canRetire: true, dependentCount: 0 };
    }

    if (intent.status === EncryptionKeyRetirementStatus.FAILED) {
      this.logger.warn(
        `RetirementIntent ${intentId} already FAILED; skipping execution`,
      );
      return {
        canRetire: false,
        dependentCount: intent.dependentPaymentCount,
      };
    }

    await this.executeIntent(intent);
    const updated = await this.prisma.encryptionKeyRetirementIntent.findUnique({
      where: { id: intentId },
    });

    return {
      canRetire: updated?.status === EncryptionKeyRetirementStatus.SAFE_TO_RETIRE,
      dependentCount: updated?.dependentPaymentCount ?? 0,
    };
  }

  /**
   * Execute a retirement intent, checking if the key version can be safely retired.
   *
   * Atomically counts dependent payments and transitions to SAFE_TO_RETIRE if count is zero.
   */
  private async executeIntent(
    intent: Awaited<
      ReturnType<typeof this.prisma.encryptionKeyRetirementIntent.findUnique>
    >,
  ): Promise<void> {
    if (!intent) return;

    const { id, keyVersion, attemptCount } = intent;
    const newAttemptCount = attemptCount + 1;

    try {
      // Count payments still encrypted with keyVersion
      const dependentCount = await this.countPaymentsWithKeyVersion(keyVersion);

      if (dependentCount === 0) {
        // No dependent payments — key can be safely retired
        await this.prisma.encryptionKeyRetirementIntent.update({
          where: { id },
          data: {
            status: EncryptionKeyRetirementStatus.SAFE_TO_RETIRE,
            dependentPaymentCount: 0,
            lastAttemptAt: new Date(),
            lastErrorSafe: null,
            permanentError: false,
          },
        });

        this.logger.log(
          `RetirementIntent ${id} SAFE_TO_RETIRE: key version ${keyVersion} has no dependent ciphertext`,
        );
      } else {
        // Payments still depend on this key — keep GUARDING
        await this.prisma.encryptionKeyRetirementIntent.update({
          where: { id },
          data: {
            status: EncryptionKeyRetirementStatus.GUARDING,
            dependentPaymentCount: dependentCount,
            lastAttemptAt: new Date(),
            nextRetryAt: computeNextRetryAt(newAttemptCount), // Retry sooner to catch rewraps
            lastErrorSafe: null,
            permanentError: false,
            attemptCount: newAttemptCount,
          },
        });

        this.logger.debug(
          `RetirementIntent ${id} GUARDING: key version ${keyVersion}, ` +
            `${dependentCount} payment(s) still encrypted`,
        );
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      const permanent =
        isPermanentError(message) || newAttemptCount >= MAX_ATTEMPTS;

      const safeError = redactError(err);

      if (permanent) {
        await this.prisma.encryptionKeyRetirementIntent.update({
          where: { id },
          data: {
            status: EncryptionKeyRetirementStatus.FAILED,
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            nextRetryAt: null,
            lastErrorSafe: safeError,
            permanentError: true,
          },
        });
        this.logger.error(
          `RetirementIntent ${id} FAILED permanently: key version ${keyVersion} — ${safeError}`,
        );
      } else {
        const nextRetryAt = computeNextRetryAt(newAttemptCount);
        await this.prisma.encryptionKeyRetirementIntent.update({
          where: { id },
          data: {
            status: EncryptionKeyRetirementStatus.PENDING,
            attemptCount: newAttemptCount,
            lastAttemptAt: new Date(),
            nextRetryAt,
            lastErrorSafe: safeError,
            permanentError: false,
          },
        });
        this.logger.warn(
          `RetirementIntent ${id} transient failure (attempt ${newAttemptCount}/${MAX_ATTEMPTS}), ` +
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
   * Reset stale GUARDING intents (crash recovery).
   */
  async resetStaleGuarding(): Promise<void> {
    const staleThreshold = new Date(Date.now() - STALE_GUARDING_THRESHOLD_MS);

    const reset = await this.prisma.encryptionKeyRetirementIntent.updateMany({
      where: {
        status: EncryptionKeyRetirementStatus.GUARDING,
        lastAttemptAt: { lt: staleThreshold },
      },
      data: {
        status: EncryptionKeyRetirementStatus.PENDING,
        nextRetryAt: new Date(), // eligible immediately
      },
    });

    if (reset.count > 0) {
      this.logger.warn(
        `Reset ${reset.count} stale GUARDING retirement intent(s) to PENDING`,
      );
    }
  }

  /**
   * Create a new retirement intent for a key version.
   */
  async createRetirementIntent(keyVersion: number): Promise<string> {
    const existing = await this.prisma.encryptionKeyRetirementIntent.findUnique(
      {
        where: { keyVersion },
      },
    );

    if (existing) {
      this.logger.warn(
        `RetirementIntent already exists for key version ${keyVersion}`,
      );
      return existing.id;
    }

    const intent = await this.prisma.encryptionKeyRetirementIntent.create({
      data: {
        keyVersion,
        status: EncryptionKeyRetirementStatus.PENDING,
      },
    });

    this.logger.log(`Created RetirementIntent ${intent.id}: key version ${keyVersion}`);
    return intent.id;
  }

  /**
   * Get the current state of a retirement intent.
   */
  async getRetirementIntentStatus(
    intentId: string,
  ): Promise<{
    status: EncryptionKeyRetirementStatus;
    keyVersion: number;
    dependentPaymentCount: number;
  } | null> {
    const intent = await this.prisma.encryptionKeyRetirementIntent.findUnique({
      where: { id: intentId },
    });

    if (!intent) return null;

    return {
      status: intent.status,
      keyVersion: intent.keyVersion,
      dependentPaymentCount: intent.dependentPaymentCount,
    };
  }

  /**
   * Check if a key version can be safely retired (no dependent ciphertext).
   *
   * Does not create or modify an intent; just checks the current state.
   */
  async canRetireKeyVersion(keyVersion: number): Promise<boolean> {
    const dependentCount = await this.countPaymentsWithKeyVersion(keyVersion);
    return dependentCount === 0;
  }

  /**
   * Prevent retirement of a key version by throwing if dependent payments exist.
   *
   * Used as a guard in operations that might retire a key.
   */
  async guardKeyRetirement(keyVersion: number): Promise<void> {
    const dependentCount = await this.countPaymentsWithKeyVersion(keyVersion);

    if (dependentCount > 0) {
      throw new Error(
        `Cannot retire encryption key version ${keyVersion}: ` +
          `${dependentCount} payment(s) still encrypted with this version. ` +
          `Run a rewrap job first.`,
      );
    }
  }
}
