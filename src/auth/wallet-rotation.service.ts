import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, WalletRotationStatus } from "@prisma/client";
import { randomBytes, randomUUID } from "crypto";
import { sha256 } from "../common/crypto/hash";
import { Clock, SystemClock } from "../common/time/clock";
import { PrismaService } from "../database/prisma.service";
import { AuthenticatedUser } from "./auth.types";
import { normalizeOrigin, OriginValidationError } from "./originNormalizer";
import { isValidWalletAddress, verifyWalletSignature } from "./wallet-signature";

/** A rotation must be completed within this window. Matches login challenges. */
export const WALLET_ROTATION_TTL_MS = 5 * 60 * 1000;

export const WALLET_ROTATED_ACTION = "user.wallet_rotated";

/**
 * Bounded failure codes persisted on a consumed rotation that did not
 * complete. Never a signature, an address or a raw error message.
 */
export enum WalletRotationFailure {
  NETWORK_MISMATCH = "network_mismatch",
  ORIGIN_MISMATCH = "origin_mismatch",
  IDENTITY_CHANGED = "identity_changed",
  CURRENT_SIGNATURE_INVALID = "current_signature_invalid",
  REPLACEMENT_SIGNATURE_INVALID = "replacement_signature_invalid",
  REPLACEMENT_UNAVAILABLE = "replacement_unavailable",
  SUPERSEDED = "superseded",
}

export type WalletRotationSigner = "current" | "replacement";

export interface WalletRotationChallenge {
  rotationId: string;
  currentMessage: string;
  newMessage: string;
  expiresAt: Date;
}

export interface WalletRotationResult {
  walletAddress: string;
  sessionsRevoked: number;
}

/**
 * Wallet address rotation with proof of control of both keys.
 *
 * The wallet address is the account's identity, so changing it is modelled as
 * a two-step, single-use protocol rather than a profile edit:
 *
 * 1. `initiate` — an authenticated user names the replacement address and
 *    receives two distinct messages, one per key. Both are bound to the
 *    network passphrase, the application origin, the rotation id and a fresh
 *    nonce, and each names the role of the key that must sign it, so neither
 *    signature can be replayed as the other or against another deployment.
 * 2. `complete` — the same user submits both signatures. The rotation is
 *    consumed *before* anything is checked, so it can be attempted once; the
 *    identity change, the revocation of every session and the audit record
 *    then commit in one transaction, conditional on the account still holding
 *    the address the rotation was issued for.
 *
 * Anything short of full success — an expired, replayed, partially signed or
 * conflicting rotation — changes nothing about the account.
 */
@Injectable()
export class WalletRotationService {
  private readonly logger = new Logger(WalletRotationService.name);
  private readonly appUrl: string;
  private readonly networkPassphrase: string;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.appUrl = configService.getOrThrow<string>("appUrl");
    this.networkPassphrase = configService.getOrThrow<string>(
      "stellar.networkPassphrase",
    );
  }

  async initiate(
    user: AuthenticatedUser,
    newWalletAddress: string,
    requestOrigin?: string,
  ): Promise<WalletRotationChallenge> {
    if (!isValidWalletAddress(newWalletAddress)) {
      throw new BadRequestException("Invalid Stellar public key");
    }
    if (newWalletAddress === user.walletAddress) {
      throw new BadRequestException(
        "Replacement wallet must differ from the current wallet",
      );
    }

    // Whether the replacement is already bound to an account is deliberately
    // not checked here: answering that before the caller proves control of
    // the replacement key would let any session probe which addresses are
    // registered. It is checked in `complete`, after both signatures verify.

    const origin = this.resolveOrigin(requestOrigin, BadRequestException);
    const rotationId = randomUUID();
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = new Date(this.clock.nowMs() + WALLET_ROTATION_TTL_MS);

    const binding = {
      rotationId,
      nonce,
      origin,
      userId: user.id,
      currentWalletAddress: user.walletAddress,
      newWalletAddress,
      expiresAt,
    };
    const currentMessage = this.buildMessage(binding, "current");
    const newMessage = this.buildMessage(binding, "replacement");

    await this.prisma.$transaction(async (tx) => {
      // One rotation in flight per account: a new request supersedes any
      // earlier pending one, whose messages can then no longer be completed.
      await tx.walletRotation.updateMany({
        where: { userId: user.id, status: WalletRotationStatus.PENDING },
        data: {
          status: WalletRotationStatus.CANCELLED,
          failureReason: WalletRotationFailure.SUPERSEDED,
        },
      });

      await tx.walletRotation.create({
        data: {
          id: rotationId,
          userId: user.id,
          currentWalletAddress: user.walletAddress,
          newWalletAddress,
          nonceHash: sha256(nonce),
          currentMessage,
          newMessage,
          networkPassphrase: this.networkPassphrase,
          origin,
          expiresAt,
        },
      });
    });

    return { rotationId, currentMessage, newMessage, expiresAt };
  }

  async complete(
    user: AuthenticatedUser,
    rotationId: string,
    signatures: { currentSignature: string; newSignature: string },
    requestOrigin?: string,
  ): Promise<WalletRotationResult> {
    const now = this.clock.now();

    // Single use: consume first, atomically. A replay, an expired or
    // superseded rotation, and another user's rotation id all match nothing
    // here and receive the same answer.
    const consumed = await this.prisma.walletRotation.updateMany({
      where: {
        id: rotationId,
        userId: user.id,
        status: WalletRotationStatus.PENDING,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });

    if (consumed.count !== 1) {
      throw new UnauthorizedException("Rotation is expired or unavailable");
    }

    const rotation = await this.prisma.walletRotation.findUnique({
      where: { id: rotationId },
    });
    if (!rotation) {
      throw new UnauthorizedException("Rotation is expired or unavailable");
    }

    if (rotation.networkPassphrase !== this.networkPassphrase) {
      await this.fail(rotationId, WalletRotationFailure.NETWORK_MISMATCH);
      throw new UnauthorizedException("Rotation network mismatch");
    }

    let origin: string;
    try {
      origin = this.resolveOrigin(requestOrigin, UnauthorizedException);
    } catch (error) {
      await this.fail(rotationId, WalletRotationFailure.ORIGIN_MISMATCH);
      throw error;
    }
    if (rotation.origin !== origin) {
      await this.fail(rotationId, WalletRotationFailure.ORIGIN_MISMATCH);
      throw new UnauthorizedException("Rotation origin mismatch");
    }

    if (rotation.currentWalletAddress !== user.walletAddress) {
      await this.fail(rotationId, WalletRotationFailure.IDENTITY_CHANGED);
      throw new ConflictException("Account wallet changed since the rotation began");
    }

    if (
      !verifyWalletSignature(
        rotation.currentWalletAddress,
        rotation.currentMessage,
        signatures.currentSignature,
      )
    ) {
      await this.fail(rotationId, WalletRotationFailure.CURRENT_SIGNATURE_INVALID);
      throw new UnauthorizedException("Invalid signature for the current wallet");
    }

    if (
      !verifyWalletSignature(
        rotation.newWalletAddress,
        rotation.newMessage,
        signatures.newSignature,
      )
    ) {
      await this.fail(
        rotationId,
        WalletRotationFailure.REPLACEMENT_SIGNATURE_INVALID,
      );
      throw new UnauthorizedException("Invalid signature for the replacement wallet");
    }

    const previousWalletHash = walletHash(rotation.currentWalletAddress);
    const newWalletHash = walletHash(rotation.newWalletAddress);

    try {
      const sessionsRevoked = await this.prisma.$transaction(async (tx) => {
        const bound = await tx.user.findUnique({
          where: { walletAddress: rotation.newWalletAddress },
          select: { id: true },
        });
        if (bound) {
          throw new ReplacementUnavailableError();
        }

        // Conditional on the address this rotation was issued for, so two
        // rotations of the same account cannot both land.
        const updated = await tx.user.updateMany({
          where: { id: user.id, walletAddress: rotation.currentWalletAddress },
          data: {
            walletAddress: rotation.newWalletAddress,
            walletHash: newWalletHash,
          },
        });
        if (updated.count !== 1) {
          throw new IdentityChangedError();
        }

        const revoked = await tx.authSession.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: now },
        });

        await tx.walletRotation.update({
          where: { id: rotationId },
          data: { status: WalletRotationStatus.COMPLETED, completedAt: now },
        });

        await tx.walletRotation.updateMany({
          where: {
            userId: user.id,
            status: WalletRotationStatus.PENDING,
            id: { not: rotationId },
          },
          data: {
            status: WalletRotationStatus.CANCELLED,
            failureReason: WalletRotationFailure.SUPERSEDED,
          },
        });

        await tx.auditLog.create({
          data: {
            actorType: "user",
            actorId: user.id,
            action: WALLET_ROTATED_ACTION,
            resourceType: "user",
            resourceId: user.id,
            metadata: {
              rotationId,
              previousWalletHash,
              newWalletHash,
              sessionsRevoked: revoked.count,
            },
          },
        });

        return revoked.count;
      });

      return { walletAddress: rotation.newWalletAddress, sessionsRevoked };
    } catch (error) {
      if (error instanceof ReplacementUnavailableError || isUniqueViolation(error)) {
        await this.fail(rotationId, WalletRotationFailure.REPLACEMENT_UNAVAILABLE);
        throw new ConflictException(
          "Replacement wallet is already bound to an account",
        );
      }
      if (error instanceof IdentityChangedError) {
        await this.fail(rotationId, WalletRotationFailure.IDENTITY_CHANGED);
        throw new ConflictException("Account wallet changed since the rotation began");
      }
      throw error;
    }
  }

  /**
   * The message one key signs. Every field that must not be transplanted to
   * another rotation, account, key role, network or deployment is in it.
   */
  buildMessage(
    binding: {
      rotationId: string;
      nonce: string;
      origin: string;
      userId: string;
      currentWalletAddress: string;
      newWalletAddress: string;
      expiresAt: Date;
    },
    signer: WalletRotationSigner,
  ): string {
    return [
      "EarnProof wallet rotation",
      `Signer: ${signer === "current" ? "current wallet" : "replacement wallet"}`,
      `Domain: ${this.appUrl}`,
      `Origin: ${binding.origin}`,
      `Network: ${this.networkPassphrase}`,
      `Account: ${binding.userId}`,
      `Current Wallet: ${binding.currentWalletAddress}`,
      `Replacement Wallet: ${binding.newWalletAddress}`,
      `Rotation: ${binding.rotationId}`,
      `Nonce: ${binding.nonce}`,
      `Expires At: ${binding.expiresAt.toISOString()}`,
    ].join("\n");
  }

  private resolveOrigin(
    requestOrigin: string | undefined,
    onInvalid: new (message: string) => Error,
  ): string {
    try {
      return normalizeOrigin(requestOrigin || this.appUrl);
    } catch (error) {
      if (error instanceof OriginValidationError) {
        throw new onInvalid(`Invalid origin: ${error.reason}`);
      }
      throw error;
    }
  }

  /** Marks a consumed rotation as failed. Never throws over the real error. */
  private async fail(
    rotationId: string,
    reason: WalletRotationFailure,
  ): Promise<void> {
    try {
      await this.prisma.walletRotation.updateMany({
        where: { id: rotationId, status: WalletRotationStatus.PENDING },
        data: { status: WalletRotationStatus.FAILED, failureReason: reason },
      });
    } catch {
      // The rotation is already consumed and cannot be retried either way;
      // losing the failure code must not mask the error the caller receives.
      this.logger.warn(`Could not record wallet rotation failure: ${reason}`);
    }
  }
}

function walletHash(walletAddress: string): string {
  return `sha256:${sha256(walletAddress)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

class ReplacementUnavailableError extends Error {}
class IdentityChangedError extends Error {}
