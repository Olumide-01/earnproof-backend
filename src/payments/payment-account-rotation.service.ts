import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  PaymentAccountRotation,
  PaymentAccountRotationStatus,
  PaymentBackfillStatus,
  PaymentMonitoredAccountStatus,
  PaymentSyncCheckpointStatus,
  Prisma,
} from "@prisma/client";
import { randomBytes, randomUUID } from "crypto";
import { AuthenticatedUser } from "../auth/auth.types";
import { verifyWalletSignature } from "../auth/wallet-signature";
import { sha256 } from "../common/crypto/hash";
import { Clock, SystemClock } from "../common/time/clock";
import { PrismaService } from "../database/prisma.service";
import { STELLAR_NETWORK_PASSPHRASES, StellarNetworkName } from "../stellar/stellar-network";
import { PaymentAccountResolver } from "./payment-account.resolver";
import {
  activeAccountKey,
  activeUserKey,
  assertNoSecretMaterial,
  buildRotationMessage,
  isPublicAccountId,
  PAYMENT_ACCOUNT_ROTATION_ACTIONS,
  PaymentAccountRollbackReason,
  PaymentAccountRotationFailure,
  planBackfill,
  SecretMaterialError,
  withinRollbackWindow,
} from "./payment-account-rotation";

export const DEFAULT_ROTATION_CHALLENGE_TTL_MS = 10 * 60_000;
export const DEFAULT_ROTATION_ROLLBACK_WINDOW_MS = 24 * 60 * 60_000;

const OPEN_STATUSES: PaymentAccountRotationStatus[] = [
  PaymentAccountRotationStatus.PENDING_VERIFICATION,
  PaymentAccountRotationStatus.VERIFIED,
];

export interface PaymentAccountRotationView {
  id: string;
  network: string;
  fromAccountId: string;
  toAccountId: string;
  status: PaymentAccountRotationStatus;
  version: number;
  expiresAt: string;
  /** Present only while the challenge is awaiting a signature. */
  challengeMessage: string | null;
  verifiedAt: string | null;
  activatedAt: string | null;
  finalCheckpoint: { ledgerSequence: number; pagingToken: string } | null;
  backfillPlan: { startLedger: number; endLedger: number; jobId: string | null } | null;
  rollbackDeadline: string | null;
  rolledBackAt: string | null;
  failureReason: string | null;
}

type Tx = Prisma.TransactionClient;

/**
 * Payment account rotation and checkpoint handoff (earnproof-backend#321).
 * See `payment-account-rotation.ts` for the protocol and
 * docs/payment-account-rotation.md for the operator view.
 *
 * Every lookup is scoped to the authenticated user: another user's rotation
 * id is indistinguishable from one that does not exist.
 */
@Injectable()
export class PaymentAccountRotationService {
  private readonly logger = new Logger(PaymentAccountRotationService.name);
  private readonly network: StellarNetworkName;
  private readonly networkPassphrase: string;
  private readonly appUrl: string;
  private readonly challengeTtlMs: number;
  private readonly rollbackWindowMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: PaymentAccountResolver,
    config: ConfigService,
    @Optional() private readonly clock: Clock = new SystemClock(),
  ) {
    this.network = config.getOrThrow<string>("stellar.network") as StellarNetworkName;
    this.networkPassphrase = config.getOrThrow<string>("stellar.networkPassphrase");
    this.appUrl = config.getOrThrow<string>("appUrl");
    this.challengeTtlMs =
      config.get<number>("paymentAccountRotation.challengeTtlMs") ?? DEFAULT_ROTATION_CHALLENGE_TTL_MS;
    this.rollbackWindowMs =
      config.get<number>("paymentAccountRotation.rollbackWindowMs") ?? DEFAULT_ROTATION_ROLLBACK_WINDOW_MS;
    // Refuse to run against a deployment whose name and passphrase disagree:
    // every challenge is bound to both, so a mismatch would make accounts on
    // two networks indistinguishable.
    if (STELLAR_NETWORK_PASSPHRASES[this.network] !== this.networkPassphrase) {
      throw new Error("stellar.network and stellar.networkPassphrase disagree");
    }
  }

  /** The account currently indexed for this user. */
  async currentAccount(user: AuthenticatedUser) {
    return this.accounts.current(user);
  }

  /** Step 1: issue a single-use challenge for the new account to sign. */
  async request(
    user: AuthenticatedUser,
    input: { network: string; newAccountId: string; backfillFromLedger?: number },
  ): Promise<PaymentAccountRotationView> {
    this.refuseSecrets([input.network, input.newAccountId]);
    if (input.network !== this.network) {
      throw new BadRequestException("Network does not match this deployment");
    }
    if (!isPublicAccountId(input.newAccountId)) {
      throw new BadRequestException("newAccountId must be a public Stellar account id (G...)");
    }
    const current = await this.accounts.current(user);
    if (input.newAccountId === current.accountId) {
      throw new BadRequestException("New account must differ from the current payment account");
    }
    // Whether the new account is bound elsewhere is deliberately not checked
    // here: answering before the caller proves control would let any session
    // probe which accounts are registered. It is checked after verification.

    const now = this.clock.now();
    const id = randomUUID();
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = new Date(now.getTime() + this.challengeTtlMs);
    const challengeMessage = buildRotationMessage({
      appUrl: this.appUrl,
      networkPassphrase: this.networkPassphrase,
      userId: user.id,
      fromAccountId: current.accountId,
      toAccountId: input.newAccountId,
      rotationId: id,
      nonce,
      expiresAt,
    });

    try {
      const rotation = await this.prisma.$transaction(async (tx) => {
        // An expired, never-verified challenge must not block a new request.
        await tx.paymentAccountRotation.updateMany({
          where: {
            userId: user.id,
            status: PaymentAccountRotationStatus.PENDING_VERIFICATION,
            expiresAt: { lte: now },
          },
          data: { status: PaymentAccountRotationStatus.EXPIRED, openUserKey: null },
        });
        const created = await tx.paymentAccountRotation.create({
          data: {
            id,
            userId: user.id,
            network: this.network,
            networkPassphrase: this.networkPassphrase,
            fromAccountId: current.accountId,
            toAccountId: input.newAccountId,
            challengeMessage,
            nonceHash: sha256(nonce),
            expiresAt,
            backfillFromLedger: input.backfillFromLedger ?? null,
            openUserKey: user.id,
          },
        });
        await this.audit(tx, user, created, PAYMENT_ACCOUNT_ROTATION_ACTIONS.requested, {});
        return created;
      });
      return toView(rotation);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("A payment account rotation is already in progress");
      }
      throw error;
    }
  }

  /** Step 2: verify the new account's signature. The challenge is consumed first. */
  async verify(user: AuthenticatedUser, rotationId: string, signature: string): Promise<PaymentAccountRotationView> {
    this.refuseSecrets([signature]);
    const now = this.clock.now();

    // Single use: an expired, replayed, cancelled or foreign rotation id all
    // match nothing here and receive the same answer.
    const consumed = await this.prisma.paymentAccountRotation.updateMany({
      where: {
        id: rotationId,
        userId: user.id,
        status: PaymentAccountRotationStatus.PENDING_VERIFICATION,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException("Rotation challenge is expired or unavailable");
    }
    const rotation = await this.prisma.paymentAccountRotation.findUniqueOrThrow({ where: { id: rotationId } });

    if (rotation.network !== this.network || rotation.networkPassphrase !== this.networkPassphrase) {
      await this.fail(rotationId, PaymentAccountRotationFailure.NETWORK_MISMATCH);
      throw new UnauthorizedException("Rotation network mismatch");
    }
    const current = await this.accounts.current(user);
    if (current.accountId !== rotation.fromAccountId) {
      await this.fail(rotationId, PaymentAccountRotationFailure.IDENTITY_CHANGED);
      throw new ConflictException("Payment account changed since the rotation began");
    }
    if (!verifyWalletSignature(rotation.toAccountId, rotation.challengeMessage, signature)) {
      await this.fail(rotationId, PaymentAccountRotationFailure.SIGNATURE_INVALID);
      throw new UnauthorizedException("Invalid signature for the new payment account");
    }
    if (await this.boundElsewhere(this.prisma, user.id, rotation.toAccountId)) {
      await this.fail(rotationId, PaymentAccountRotationFailure.ACCOUNT_UNAVAILABLE);
      throw new ConflictException("The new payment account is already bound to another user");
    }

    const verified = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.paymentAccountRotation.updateMany({
        where: { id: rotationId, status: PaymentAccountRotationStatus.PENDING_VERIFICATION, version: rotation.version },
        data: { status: PaymentAccountRotationStatus.VERIFIED, verifiedAt: now, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictException("Rotation changed during verification");
      const row = await tx.paymentAccountRotation.findUniqueOrThrow({ where: { id: rotationId } });
      await this.audit(tx, user, row, PAYMENT_ACCOUNT_ROTATION_ACTIONS.verified, {});
      return row;
    });
    return toView(verified);
  }

  /**
   * Step 3: hand off. In one transaction: capture the old account's verified
   * checkpoint as its final checkpoint, retire the old account, activate the
   * new one, remove the old checkpoint (conditional on it not having moved),
   * and queue the new account's backfill.
   */
  async activate(user: AuthenticatedUser, rotationId: string, expectedVersion: number): Promise<PaymentAccountRotationView> {
    const now = this.clock.now();
    try {
      const activated = await this.prisma.$transaction(async (tx) => {
        const rotation = await this.requireOwned(tx, user, rotationId);
        if (rotation.status !== PaymentAccountRotationStatus.VERIFIED) {
          throw new ConflictException("Only a verified rotation can be activated");
        }
        if (rotation.version !== expectedVersion) {
          throw new ConflictException("Rotation changed since it was read; reload and retry");
        }
        if (rotation.network !== this.network || rotation.networkPassphrase !== this.networkPassphrase) {
          throw new ConflictException("Deployment network changed since the rotation was verified");
        }

        const current = await this.accounts.current(user, tx);
        if (current.accountId !== rotation.fromAccountId) {
          throw new ConflictException("Payment account changed since the rotation began");
        }
        if (await this.boundElsewhere(tx, user.id, rotation.toAccountId)) {
          throw new ConflictException("The new payment account is already bound to another user");
        }

        const checkpoint = await tx.paymentSyncCheckpoint.findUnique({ where: { userId: user.id } });
        if (checkpoint && checkpoint.status !== PaymentSyncCheckpointStatus.VERIFIED) {
          // A diverged history has no trustworthy end; it must be reconciled
          // before it can be closed. Nothing is changed, so a retry is safe.
          throw new ConflictException(
            "The current account's payment history is being reconciled; sync and retry",
          );
        }

        // Retire the old account. A user who never rotated gets a retired
        // epoch for their wallet, so the history has an explicit end.
        let fromEpochId = current.epochId;
        if (fromEpochId) {
          const retired = await tx.paymentMonitoredAccount.updateMany({
            where: { id: fromEpochId, status: PaymentMonitoredAccountStatus.ACTIVE },
            data: {
              status: PaymentMonitoredAccountStatus.RETIRED,
              retiredAt: now,
              activeUserKey: null,
              activeAccountKey: null,
            },
          });
          if (retired.count !== 1) throw new ConflictException("Payment account changed; reload and retry");
        } else {
          const owner = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { createdAt: true } });
          fromEpochId = randomUUID();
          await tx.paymentMonitoredAccount.create({
            data: {
              id: fromEpochId,
              userId: user.id,
              network: this.network,
              accountId: rotation.fromAccountId,
              status: PaymentMonitoredAccountStatus.RETIRED,
              activatedAt: owner.createdAt,
              retiredAt: now,
            },
          });
        }

        const toEpochId = randomUUID();
        await tx.paymentMonitoredAccount.create({
          data: {
            id: toEpochId,
            userId: user.id,
            network: this.network,
            accountId: rotation.toAccountId,
            status: PaymentMonitoredAccountStatus.ACTIVE,
            activatedAt: now,
            rotationId,
            activeUserKey: activeUserKey(user.id, this.network),
            activeAccountKey: activeAccountKey(this.network, rotation.toAccountId),
          },
        });

        if (checkpoint) {
          const removed = await tx.paymentSyncCheckpoint.deleteMany({
            where: { id: checkpoint.id, version: checkpoint.version },
          });
          if (removed.count !== 1) {
            throw new ConflictException("A sync advanced the checkpoint during activation; retry");
          }
        }

        const plan = planBackfill(rotation.backfillFromLedger, checkpoint?.ledgerSequence ?? null);
        const job = plan
          ? await tx.paymentBackfillJob.create({
              data: {
                userId: user.id,
                requestedById: user.id,
                startLedger: plan.startLedger,
                endLedger: plan.endLedger,
                accountId: rotation.toAccountId,
              },
              select: { id: true },
            })
          : null;

        const updated = await tx.paymentAccountRotation.updateMany({
          where: { id: rotationId, status: PaymentAccountRotationStatus.VERIFIED, version: expectedVersion },
          data: {
            status: PaymentAccountRotationStatus.ACTIVATED,
            activatedAt: now,
            rollbackDeadline: new Date(now.getTime() + this.rollbackWindowMs),
            finalPagingToken: checkpoint?.pagingToken ?? null,
            finalOperationId: checkpoint?.operationId ?? null,
            finalTransactionHash: checkpoint?.transactionHash ?? null,
            finalLedgerSequence: checkpoint?.ledgerSequence ?? null,
            finalLedgerHash: checkpoint?.ledgerHash ?? null,
            finalVerifiedAt: checkpoint?.verifiedAt ?? null,
            backfillStartLedger: plan?.startLedger ?? null,
            backfillEndLedger: plan?.endLedger ?? null,
            backfillJobId: job?.id ?? null,
            fromEpochId,
            toEpochId,
            openUserKey: null,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new ConflictException("Rotation changed since it was read; reload and retry");

        const row = await tx.paymentAccountRotation.findUniqueOrThrow({ where: { id: rotationId } });
        await this.audit(tx, user, row, PAYMENT_ACCOUNT_ROTATION_ACTIONS.activated, {
          finalLedgerSequence: row.finalLedgerSequence,
          backfillStartLedger: row.backfillStartLedger,
          backfillEndLedger: row.backfillEndLedger,
        });
        return row;
      });
      return toView(activated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("The new payment account is already bound to another user");
      }
      throw error;
    }
  }

  /**
   * Restores the old account and its final checkpoint, within the rollback
   * window. The restored checkpoint is re-proved against Horizon by the next
   * sync before anything past it is trusted.
   */
  async rollback(
    user: AuthenticatedUser,
    rotationId: string,
    input: { expectedVersion: number; reason: PaymentAccountRollbackReason },
  ): Promise<PaymentAccountRotationView> {
    const now = this.clock.now();
    try {
      const rolledBack = await this.prisma.$transaction(async (tx) => {
        const rotation = await this.requireOwned(tx, user, rotationId);
        if (rotation.status !== PaymentAccountRotationStatus.ACTIVATED) {
          throw new ConflictException("Only an activated rotation can be rolled back");
        }
        if (rotation.version !== input.expectedVersion) {
          throw new ConflictException("Rotation changed since it was read; reload and retry");
        }
        if (!withinRollbackWindow(now.getTime(), rotation.rollbackDeadline)) {
          throw new ConflictException("The rollback window for this rotation has elapsed");
        }

        const retired = await tx.paymentMonitoredAccount.updateMany({
          where: { id: rotation.toEpochId ?? "", status: PaymentMonitoredAccountStatus.ACTIVE },
          data: {
            status: PaymentMonitoredAccountStatus.RETIRED,
            retiredAt: now,
            activeUserKey: null,
            activeAccountKey: null,
          },
        });
        if (retired.count !== 1) {
          throw new ConflictException("A later rotation superseded this one; it can no longer be rolled back");
        }
        const restored = await tx.paymentMonitoredAccount.updateMany({
          where: { id: rotation.fromEpochId ?? "", status: PaymentMonitoredAccountStatus.RETIRED },
          data: {
            status: PaymentMonitoredAccountStatus.ACTIVE,
            retiredAt: null,
            activeUserKey: activeUserKey(user.id, rotation.network),
            activeAccountKey: activeAccountKey(rotation.network, rotation.fromAccountId),
          },
        });
        if (restored.count !== 1) throw new ConflictException("The previous account record is missing");

        // The new account's checkpoint describes the new account's feed and
        // must not survive; the old account's final checkpoint is restored.
        await tx.paymentSyncCheckpoint.deleteMany({ where: { userId: user.id } });
        if (
          rotation.finalPagingToken &&
          rotation.finalOperationId &&
          rotation.finalTransactionHash &&
          rotation.finalLedgerSequence !== null &&
          rotation.finalLedgerHash &&
          rotation.finalVerifiedAt
        ) {
          await tx.paymentSyncCheckpoint.create({
            data: {
              userId: user.id,
              pagingToken: rotation.finalPagingToken,
              operationId: rotation.finalOperationId,
              transactionHash: rotation.finalTransactionHash,
              ledgerSequence: rotation.finalLedgerSequence,
              ledgerHash: rotation.finalLedgerHash,
              status: PaymentSyncCheckpointStatus.VERIFIED,
              verifiedAt: rotation.finalVerifiedAt,
            },
          });
        }

        if (rotation.backfillJobId) {
          // Same semantics as an operator cancel: a pending job stops now, a
          // running one at its next page boundary.
          const pending = await tx.paymentBackfillJob.updateMany({
            where: { id: rotation.backfillJobId, status: PaymentBackfillStatus.PENDING },
            data: { status: PaymentBackfillStatus.CANCELLED, cancelRequestedAt: now, completedAt: now },
          });
          if (pending.count === 0) {
            await tx.paymentBackfillJob.updateMany({
              where: { id: rotation.backfillJobId, status: PaymentBackfillStatus.RUNNING, cancelRequestedAt: null },
              data: { cancelRequestedAt: now },
            });
          }
        }

        const updated = await tx.paymentAccountRotation.updateMany({
          where: { id: rotationId, status: PaymentAccountRotationStatus.ACTIVATED, version: input.expectedVersion },
          data: {
            status: PaymentAccountRotationStatus.ROLLED_BACK,
            rolledBackAt: now,
            rollbackReason: input.reason,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new ConflictException("Rotation changed since it was read; reload and retry");

        const row = await tx.paymentAccountRotation.findUniqueOrThrow({ where: { id: rotationId } });
        await this.audit(tx, user, row, PAYMENT_ACCOUNT_ROTATION_ACTIONS.rolledBack, { reason: input.reason });
        return row;
      });
      return toView(rolledBack);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("The previous payment account is now bound to another user");
      }
      throw error;
    }
  }

  /** Abandons a rotation that has not been activated. */
  async cancel(user: AuthenticatedUser, rotationId: string, expectedVersion: number): Promise<PaymentAccountRotationView> {
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const rotation = await this.requireOwned(tx, user, rotationId);
      if (!OPEN_STATUSES.includes(rotation.status)) {
        throw new ConflictException("Only an open rotation can be cancelled");
      }
      const updated = await tx.paymentAccountRotation.updateMany({
        where: { id: rotationId, status: { in: OPEN_STATUSES }, version: expectedVersion },
        data: { status: PaymentAccountRotationStatus.CANCELLED, openUserKey: null, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictException("Rotation changed since it was read; reload and retry");
      const row = await tx.paymentAccountRotation.findUniqueOrThrow({ where: { id: rotationId } });
      await this.audit(tx, user, row, PAYMENT_ACCOUNT_ROTATION_ACTIONS.cancelled, {});
      return row;
    });
    return toView(cancelled);
  }

  async get(user: AuthenticatedUser, rotationId: string): Promise<PaymentAccountRotationView> {
    return toView(await this.requireOwned(this.prisma, user, rotationId));
  }

  private refuseSecrets(values: unknown[]): void {
    try {
      assertNoSecretMaterial(values);
    } catch (error) {
      if (error instanceof SecretMaterialError) {
        throw new BadRequestException(
          "Secret keys are never accepted. Submit the public account id (G...) and a signature.",
        );
      }
      throw error;
    }
  }

  /** Whether another user holds the account as their wallet or active payment account. */
  private async boundElsewhere(client: Tx, userId: string, accountId: string): Promise<boolean> {
    const [wallet, epoch] = await Promise.all([
      client.user.findFirst({ where: { walletAddress: accountId, id: { not: userId } }, select: { id: true } }),
      client.paymentMonitoredAccount.findFirst({
        where: { activeAccountKey: activeAccountKey(this.network, accountId), userId: { not: userId } },
        select: { id: true },
      }),
    ]);
    return wallet !== null || epoch !== null;
  }

  private async requireOwned(client: Tx, user: AuthenticatedUser, rotationId: string) {
    const rotation = await client.paymentAccountRotation.findFirst({ where: { id: rotationId, userId: user.id } });
    if (!rotation) throw new NotFoundException("Rotation not found");
    return rotation;
  }

  /** Marks a consumed challenge failed. Never throws over the real error. */
  private async fail(rotationId: string, reason: PaymentAccountRotationFailure): Promise<void> {
    try {
      await this.prisma.paymentAccountRotation.updateMany({
        where: { id: rotationId, status: PaymentAccountRotationStatus.PENDING_VERIFICATION },
        data: {
          status: PaymentAccountRotationStatus.FAILED,
          failureReason: reason,
          openUserKey: null,
          version: { increment: 1 },
        },
      });
    } catch {
      this.logger.warn(`Could not record payment account rotation failure: ${reason}`);
    }
  }

  private async audit(
    tx: Tx,
    user: AuthenticatedUser,
    rotation: PaymentAccountRotation,
    action: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    // Appended within `tx`, so the record commits or rolls back with the
    // transition it describes (see PrismaService.appendAuditLog).
    await this.prisma.appendAuditLog(tx, {
      data: {
        actorType: "user",
        actorId: user.id,
        action,
        resourceType: "payment_account_rotation",
        resourceId: rotation.id,
        // Account ids are hashed, as for wallet rotation: audit records are
        // retained longer and read more widely than the rotation itself.
        metadata: {
          network: rotation.network,
          fromAccountHash: `sha256:${sha256(rotation.fromAccountId)}`,
          toAccountHash: `sha256:${sha256(rotation.toAccountId)}`,
          status: rotation.status,
          ...extra,
        } as Prisma.InputJsonValue,
      },
    });
  }
}

function toView(rotation: PaymentAccountRotation): PaymentAccountRotationView {
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  return {
    id: rotation.id,
    network: rotation.network,
    fromAccountId: rotation.fromAccountId,
    toAccountId: rotation.toAccountId,
    status: rotation.status,
    version: rotation.version,
    expiresAt: rotation.expiresAt.toISOString(),
    challengeMessage:
      rotation.status === PaymentAccountRotationStatus.PENDING_VERIFICATION ? rotation.challengeMessage : null,
    verifiedAt: iso(rotation.verifiedAt),
    activatedAt: iso(rotation.activatedAt),
    finalCheckpoint:
      rotation.finalLedgerSequence !== null && rotation.finalPagingToken
        ? { ledgerSequence: rotation.finalLedgerSequence, pagingToken: rotation.finalPagingToken }
        : null,
    backfillPlan:
      rotation.backfillStartLedger !== null && rotation.backfillEndLedger !== null
        ? {
            startLedger: rotation.backfillStartLedger,
            endLedger: rotation.backfillEndLedger,
            jobId: rotation.backfillJobId,
          }
        : null,
    rollbackDeadline: iso(rotation.rollbackDeadline),
    rolledBackAt: iso(rotation.rolledBackAt),
    failureReason: rotation.failureReason,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
