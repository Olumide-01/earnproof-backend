import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  IssuerAddressRotation,
  IssuerAddressRotationStatus,
  Prisma,
  ResourceStatus,
} from "@prisma/client";
import { StrKey } from "@stellar/stellar-base";
import { AuthenticatedUser } from "../auth/auth.types";
import { Clock, SystemClock } from "../common/time/clock";
import { PrismaService } from "../database/prisma.service";
import { IssuerRegistryService } from "./issuer-registry.service";

/** Attempts before an unconfirmable rotation is failed for manual review. */
export const MAX_ROTATION_ATTEMPTS = 8;
/** First retry delay; doubles per attempt up to {@link MAX_RETRY_DELAY_MS}. */
export const BASE_RETRY_DELAY_MS = 30_000;
export const MAX_RETRY_DELAY_MS = 30 * 60_000;
/**
 * How long one process may hold a rotation. Longer than the CLI's own
 * 120-second submission timeout, so a lease cannot expire under a submission
 * that is still running, yet short enough that a crashed process's rotation is
 * picked up again within minutes.
 */
export const ROTATION_LEASE_MS = 5 * 60_000;

export const ISSUER_ADDRESS_ROTATION_ACTIONS = {
  requested: "issuer.address_rotation.requested",
  confirmed: "issuer.address_rotation.confirmed",
  failed: "issuer.address_rotation.failed",
} as const;
export const ISSUER_ADDRESS_ROTATION_RESOURCE = "issuer_address_rotation";

/** Bounded failure and retry codes. Never raw CLI output. */
export enum RotationErrorCode {
  REGISTRY_READ_FAILED = "registry_read_failed",
  SUBMISSION_FAILED = "submission_failed",
  CONFIRMATION_PENDING = "confirmation_pending",
  CONTRACT_ADDRESS_CONFLICT = "contract_address_conflict",
  DATABASE_ADDRESS_CONFLICT = "database_address_conflict",
  RETRIES_EXHAUSTED = "retries_exhausted",
}

const OPEN_STATUSES: IssuerAddressRotationStatus[] = [
  IssuerAddressRotationStatus.PENDING,
  IssuerAddressRotationStatus.SUBMITTED,
];

export interface IssuerAddressRotationView {
  id: string;
  issuerId: string;
  fromAddress: string;
  toAddress: string;
  status: IssuerAddressRotationStatus;
  attemptCount: number;
  lastError: string | null;
  transactionHash: string | null;
  nextAttemptAt: Date | null;
  confirmedAt: Date | null;
  createdAt: Date;
}

type Tx = Prisma.TransactionClient;
type Actor = AuthenticatedUser | null;

/**
 * Issuer Stellar address rotation, coordinated with the on-chain registry.
 *
 * The database never claims an address the contract does not hold:
 *
 * 1. `requestRotation` validates the command against the issuer revision the
 *    caller saw, rejects conflicting targets, and records an *open* rotation.
 *    `Issuer.stellarAddress` is untouched.
 * 2. `reconcile` reads the address the contract holds and acts on what it
 *    finds, so it is safe to run any number of times, after a timeout, or
 *    after a restart:
 *      - contract holds the target  -> finalize (the submission landed)
 *      - contract holds the source  -> submit `rotate_issuer_address`, then
 *                                      read again
 *      - contract holds anything else -> fail; manual review
 *    A lease ensures one process works on a rotation at a time.
 * 3. `finalize` is the only place the issuer's address changes, and it runs
 *    only after the contract was observed holding the target. It records the
 *    retired address in `IssuerAddressHistory`.
 */
@Injectable()
export class IssuerAddressRotationService {
  private readonly logger = new Logger(IssuerAddressRotationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: IssuerRegistryService,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async requestRotation(
    actor: AuthenticatedUser,
    issuerId: string,
    input: { newStellarAddress: string; expectedRevision: number },
  ): Promise<IssuerAddressRotationView> {
    const toAddress = input.newStellarAddress;
    if (!StrKey.isValidEd25519PublicKey(toAddress)) {
      throw new BadRequestException("Invalid Stellar public key");
    }
    if (!this.registry.isConfigured) {
      throw new ServiceUnavailableException(
        "Issuer registry is not configured; address rotation requires contract confirmation",
      );
    }

    const now = this.clock.now();
    const rotation = await this.prisma
      .$transaction(async (tx) => {
        const issuer = await tx.issuer.findUnique({ where: { id: issuerId } });
        if (!issuer) throw new NotFoundException("Issuer not found");

        if (issuer.revision !== input.expectedRevision) {
          throw new ConflictException("Issuer revision is stale; reload and retry");
        }
        if (issuer.status === ResourceStatus.REVOKED) {
          throw new ConflictException("A revoked issuer's address cannot be rotated");
        }
        if (issuer.contractSyncedStatus === null) {
          throw new ConflictException(
            "Issuer is not registered in the contract; synchronise it before rotating its address",
          );
        }
        if (issuer.stellarAddress === toAddress) {
          throw new BadRequestException("Replacement address must differ from the current address");
        }
        await this.assertTargetAvailable(tx, toAddress);

        // Claim the revision: a concurrent command built from the same view
        // of the issuer now finds it stale.
        const claimed = await tx.issuer.updateMany({
          where: { id: issuerId, revision: input.expectedRevision },
          data: { revision: { increment: 1 } },
        });
        if (claimed.count !== 1) {
          throw new ConflictException("Issuer revision is stale; reload and retry");
        }

        const created = await tx.issuerAddressRotation.create({
          data: {
            issuerId,
            fromAddress: issuer.stellarAddress,
            toAddress,
            expectedRevision: input.expectedRevision,
            openIssuerKey: issuerId,
            openTargetKey: toAddress,
            requestedById: actor.id,
            nextAttemptAt: now,
          },
        });

        await this.audit(tx, actor, created, ISSUER_ADDRESS_ROTATION_ACTIONS.requested, issuer.organizationId, {
          expectedRevision: input.expectedRevision,
        });
        return created;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error, "openIssuerKey")) {
          throw new ConflictException("An address rotation is already in progress for this issuer");
        }
        if (isUniqueViolation(error, "openTargetKey")) {
          throw new ConflictException("The replacement address is already the target of another rotation");
        }
        throw error;
      });

    // Submit straight away. Anything that does not finish here is picked up
    // by the reconciliation job, so a failure is reported, not thrown.
    return this.reconcile(rotation.id, actor);
  }

  /**
   * Moves one rotation as far as the contract allows. Idempotent: every step
   * starts from the contract's observed state, not from what this process
   * believes it did before.
   */
  async reconcile(rotationId: string, actor: Actor = null): Promise<IssuerAddressRotationView> {
    const now = this.clock.now();
    const leased = await this.prisma.issuerAddressRotation.updateMany({
      where: {
        id: rotationId,
        status: { in: OPEN_STATUSES },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: {
        leaseExpiresAt: new Date(now.getTime() + ROTATION_LEASE_MS),
        attemptCount: { increment: 1 },
        lastAttemptAt: now,
      },
    });
    if (leased.count !== 1) {
      // Closed, unknown, or another process holds it: report, do not act.
      return this.view(rotationId);
    }

    const rotation = await this.prisma.issuerAddressRotation.findUniqueOrThrow({
      where: { id: rotationId },
    });

    try {
      const observed = await this.registry.readIssuerAddress(rotation.issuerId);
      if (observed.state !== "found") {
        return await this.retryLater(rotation, RotationErrorCode.REGISTRY_READ_FAILED, actor);
      }
      if (observed.issuerAddress === rotation.toAddress) {
        return await this.finalize(rotation, rotation.transactionHash, actor);
      }
      if (observed.issuerAddress !== rotation.fromAddress) {
        return await this.fail(rotation, RotationErrorCode.CONTRACT_ADDRESS_CONFLICT, actor);
      }

      const submitted = await this.registry.rotateIssuerAddress(
        rotation.issuerId,
        rotation.toAddress,
      );
      if (submitted.state !== "submitted") {
        return await this.retryLater(rotation, RotationErrorCode.SUBMISSION_FAILED, actor);
      }

      const withHash = await this.prisma.issuerAddressRotation.update({
        where: { id: rotation.id },
        data: {
          status: IssuerAddressRotationStatus.SUBMITTED,
          transactionHash: submitted.transactionHash,
        },
      });

      // Never trust the submission's success alone: confirm against the
      // contract before the database adopts the address.
      const confirmed = await this.registry.readIssuerAddress(rotation.issuerId);
      if (confirmed.state === "found" && confirmed.issuerAddress === rotation.toAddress) {
        return await this.finalize(withHash, submitted.transactionHash, actor);
      }
      return await this.retryLater(withHash, RotationErrorCode.CONFIRMATION_PENDING, actor);
    } catch (error) {
      // Release the lease so the next pass can continue; the database has not
      // adopted anything that the contract has not confirmed.
      await this.prisma.issuerAddressRotation.updateMany({
        where: { id: rotation.id, status: { in: OPEN_STATUSES } },
        data: { leaseExpiresAt: null },
      });
      throw error;
    }
  }

  /** Reconciles every open rotation that is due. Used by the scheduled job. */
  async reconcileDue(limit = 20): Promise<number> {
    const now = this.clock.now();
    const due = await this.prisma.issuerAddressRotation.findMany({
      where: {
        status: { in: OPEN_STATUSES },
        nextAttemptAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      orderBy: { nextAttemptAt: "asc" },
      take: limit,
      select: { id: true },
    });

    for (const { id } of due) {
      try {
        await this.reconcile(id);
      } catch (error) {
        this.logger.error(
          `Issuer address rotation ${id} reconciliation errored: ${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      }
    }
    return due.length;
  }

  async listForIssuer(issuerId: string) {
    const issuer = await this.prisma.issuer.findUnique({
      where: { id: issuerId },
      select: { id: true },
    });
    if (!issuer) throw new NotFoundException("Issuer not found");

    const [rotations, history] = await Promise.all([
      this.prisma.issuerAddressRotation.findMany({
        where: { issuerId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      this.prisma.issuerAddressHistory.findMany({
        where: { issuerId },
        orderBy: { retiredAt: "desc" },
      }),
    ]);

    return {
      rotations: rotations.map(toView),
      addressHistory: history.map((entry) => ({
        stellarAddress: entry.stellarAddress,
        retiredAt: entry.retiredAt,
        rotationId: entry.rotationId,
        transactionHash: entry.transactionHash,
      })),
    };
  }

  async reconcileForIssuer(
    actor: AuthenticatedUser,
    issuerId: string,
    rotationId: string,
  ): Promise<IssuerAddressRotationView> {
    const rotation = await this.prisma.issuerAddressRotation.findFirst({
      where: { id: rotationId, issuerId },
      select: { id: true },
    });
    if (!rotation) throw new NotFoundException("Address rotation not found");
    return this.reconcile(rotation.id, actor);
  }

  /**
   * Rejects a target that is, or was, some issuer's address, so a rotation
   * can neither collide with a registration nor make a retired address
   * ambiguous for historical verification.
   */
  private async assertTargetAvailable(tx: Tx, toAddress: string): Promise<void> {
    const registered = await tx.issuer.findUnique({
      where: { stellarAddress: toAddress },
      select: { id: true },
    });
    if (registered) {
      throw new ConflictException("The replacement address is already registered to an issuer");
    }
    const retired = await tx.issuerAddressHistory.findFirst({
      where: { stellarAddress: toAddress },
      select: { id: true },
    });
    if (retired) {
      throw new ConflictException("The replacement address was previously used by an issuer");
    }
  }

  /**
   * Adopts the confirmed address. Closing the rotation is the first write, and
   * is conditional, so a finalize that races another one does nothing.
   */
  private async finalize(
    rotation: IssuerAddressRotation,
    transactionHash: string | null,
    actor: Actor,
  ): Promise<IssuerAddressRotationView> {
    const now = this.clock.now();
    try {
      await this.prisma.$transaction(async (tx) => {
        const closed = await tx.issuerAddressRotation.updateMany({
          where: { id: rotation.id, status: { in: OPEN_STATUSES } },
          data: {
            status: IssuerAddressRotationStatus.CONFIRMED,
            confirmedAt: now,
            transactionHash,
            lastError: null,
            nextAttemptAt: null,
            leaseExpiresAt: null,
            openIssuerKey: null,
            openTargetKey: null,
          },
        });
        if (closed.count !== 1) return;

        const moved = await tx.issuer.updateMany({
          where: { id: rotation.issuerId, stellarAddress: rotation.fromAddress },
          data: { stellarAddress: rotation.toAddress, revision: { increment: 1 } },
        });
        if (moved.count !== 1) {
          throw new DatabaseAddressConflict();
        }

        await tx.issuerAddressHistory.create({
          data: {
            issuerId: rotation.issuerId,
            stellarAddress: rotation.fromAddress,
            retiredAt: now,
            rotationId: rotation.id,
            transactionHash,
          },
        });

        const issuer = await tx.issuer.findUniqueOrThrow({
          where: { id: rotation.issuerId },
          select: { organizationId: true },
        });
        await this.audit(tx, actor, rotation, ISSUER_ADDRESS_ROTATION_ACTIONS.confirmed, issuer.organizationId, {
          transactionHash,
        });
      });
    } catch (error) {
      if (error instanceof DatabaseAddressConflict || isUniqueViolation(error, "stellarAddress")) {
        // The contract moved but the database cannot follow without breaking a
        // constraint. Nothing local changed; surface it for manual review.
        this.logger.error(
          `Issuer address rotation ${rotation.id} confirmed on-chain but conflicts locally`,
        );
        return this.fail(rotation, RotationErrorCode.DATABASE_ADDRESS_CONFLICT, actor);
      }
      throw error;
    }
    return this.view(rotation.id);
  }

  private async retryLater(
    rotation: IssuerAddressRotation,
    code: RotationErrorCode,
    actor: Actor,
  ): Promise<IssuerAddressRotationView> {
    if (rotation.attemptCount >= MAX_ROTATION_ATTEMPTS) {
      return this.fail(rotation, RotationErrorCode.RETRIES_EXHAUSTED, actor);
    }
    const delay = Math.min(
      BASE_RETRY_DELAY_MS * 2 ** Math.max(0, rotation.attemptCount - 1),
      MAX_RETRY_DELAY_MS,
    );
    await this.prisma.issuerAddressRotation.updateMany({
      where: { id: rotation.id, status: { in: OPEN_STATUSES } },
      data: {
        lastError: code,
        nextAttemptAt: new Date(this.clock.nowMs() + delay),
        leaseExpiresAt: null,
      },
    });
    return this.view(rotation.id);
  }

  /** Closes a rotation without changing the issuer. */
  private async fail(
    rotation: IssuerAddressRotation,
    code: RotationErrorCode,
    actor: Actor,
  ): Promise<IssuerAddressRotationView> {
    await this.prisma.$transaction(async (tx) => {
      const closed = await tx.issuerAddressRotation.updateMany({
        where: { id: rotation.id, status: { in: OPEN_STATUSES } },
        data: {
          status: IssuerAddressRotationStatus.FAILED,
          lastError: code,
          nextAttemptAt: null,
          leaseExpiresAt: null,
          openIssuerKey: null,
          openTargetKey: null,
        },
      });
      if (closed.count !== 1) return;

      const issuer = await tx.issuer.findUniqueOrThrow({
        where: { id: rotation.issuerId },
        select: { organizationId: true },
      });
      await this.audit(tx, actor, rotation, ISSUER_ADDRESS_ROTATION_ACTIONS.failed, issuer.organizationId, {
        reason: code,
      });
    });
    return this.view(rotation.id);
  }

  private async view(rotationId: string): Promise<IssuerAddressRotationView> {
    const rotation = await this.prisma.issuerAddressRotation.findUnique({
      where: { id: rotationId },
    });
    if (!rotation) throw new NotFoundException("Address rotation not found");
    return toView(rotation);
  }

  private audit(
    tx: Tx,
    actor: Actor,
    rotation: Pick<IssuerAddressRotation, "id" | "issuerId" | "fromAddress" | "toAddress">,
    action: string,
    organizationId: string,
    extra: Prisma.InputJsonObject,
  ) {
    return tx.auditLog.create({
      data: {
        actorType: actor ? "user" : "system",
        actorId: actor?.id ?? null,
        action,
        resourceType: ISSUER_ADDRESS_ROTATION_RESOURCE,
        resourceId: rotation.id,
        metadata: {
          organizationId,
          issuerId: rotation.issuerId,
          // Issuer addresses are public registry data, declared as such in
          // the audit taxonomy.
          fromAddress: rotation.fromAddress,
          toAddress: rotation.toAddress,
          ...extra,
        },
      },
    });
  }
}

function toView(rotation: IssuerAddressRotation): IssuerAddressRotationView {
  return {
    id: rotation.id,
    issuerId: rotation.issuerId,
    fromAddress: rotation.fromAddress,
    toAddress: rotation.toAddress,
    status: rotation.status,
    attemptCount: rotation.attemptCount,
    lastError: rotation.lastError,
    transactionHash: rotation.transactionHash,
    nextAttemptAt: rotation.nextAttemptAt,
    confirmedAt: rotation.confirmedAt,
    createdAt: rotation.createdAt,
  };
}

function isUniqueViolation(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some((name) => name.includes(field));
}

class DatabaseAddressConflict extends Error {}
