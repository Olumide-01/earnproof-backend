import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthEventType } from "@prisma/client";
import { randomBytes } from "crypto";
import { isValidWalletAddress, verifyWalletSignature } from "./wallet-signature";
import { Logger } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { sha256 } from "../common/crypto/hash";
import { AuthAuditService } from "./auth-audit.service";
import { AuthRateLimiterService } from "./auth-rate-limiter.service";
import { SessionService } from "./session.service";
import { canAuthenticate } from "./account-status.policy";
import type { SessionDeviceHeaders } from "./session-device-metadata";
import {
  normalizeOrigin,
  OriginValidationError,
} from "./originNormalizer";

@Injectable()
export class AuthService {
  private readonly appUrl: string;
  private readonly networkPassphrase: string;
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
    private readonly auditService: AuthAuditService,
    private readonly rateLimiter: AuthRateLimiterService,
    configService: ConfigService,
  ) {
    this.appUrl = configService.getOrThrow<string>("appUrl");
    this.networkPassphrase = configService.getOrThrow<string>(
      "stellar.networkPassphrase",
    );
  }

  async createChallenge(walletAddress: string, clientMetadata?: string, requestOrigin?: string) {
    this.assertValidPublicKey(walletAddress);

    // Check rate limits before creating challenge
    await this.rateLimiter.checkChallengeCreationLimit(
      walletAddress,
      clientMetadata,
    );

    // Normalize and validate origin — reject with auditable reason on failure
    let normalizedOrigin: string;
    try {
      // If no origin provided, use appUrl as default
      const originToValidate = requestOrigin || this.appUrl;
      normalizedOrigin = normalizeOrigin(originToValidate);
    } catch (error) {
      if (error instanceof OriginValidationError) {
        this.logger.warn('[Auth] Challenge creation rejected — invalid origin', {
          reason: error.reason,
          // Note: rawOrigin logged for audit but NEVER included in client response
          errorMessage: error.message,
        });
        throw new BadRequestException(`Invalid origin: ${error.reason}`);
      }
      throw error;
    }

    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const message = [
      "EarnProof wallet authentication",
      `Domain: ${this.appUrl}`,
      `Network: ${this.networkPassphrase}`,
      `Wallet: ${walletAddress}`,
      `Nonce: ${nonce}`,
      `Expires At: ${expiresAt.toISOString()}`,
    ].join("\n");

    const challenge = await this.prisma.walletChallenge.create({
      data: {
        walletAddress,
        nonceHash: sha256(nonce),
        message,
        expiresAt,
        networkPassphrase: this.networkPassphrase,
        origin: normalizedOrigin,
      },
      select: {
        id: true,
        message: true,
        expiresAt: true,
      },
    });

    // Record successful challenge creation
    await this.auditService.recordEvent(
      AuthEventType.CHALLENGE_CREATED,
      walletAddress,
      {
        challengeId: challenge.id,
        success: true,
        clientMetadata,
      },
    );

    return challenge;
  }

  async verifyChallenge(
    input: {
      challengeId: string;
      walletAddress: string;
      signature: string;
      clientMetadata?: string;
      requestOrigin?: string;
    },
    headers?: SessionDeviceHeaders,
  ) {
    this.assertValidPublicKey(input.walletAddress);

    // Check rate limits before verification attempt
    await this.rateLimiter.checkVerificationLimit(
      input.walletAddress,
      input.clientMetadata,
    );

    // Atomically mark the challenge as consumed only if it exists, is not used,
    // and is not expired. This closes the TOCTOU window in which two concurrent
    // requests could both pass an existence check before either marked it used.
    const consumedChallenge = await this.prisma.walletChallenge.updateMany({
      where: {
        id: input.challengeId,
        walletAddress: input.walletAddress,
        usedAt: null, // Not yet consumed
        expiresAt: {
          gt: new Date(), // Not expired
        },
      },
      data: {
        usedAt: new Date(),
      },
    });

    if (consumedChallenge.count === 0) {
      // Determine if the challenge was already used (replay) or is expired /
      // never existed, purely for audit-trail accuracy — the caller always
      // receives the same generic error either way.
      // Nothing was consumed: the challenge was already used (a replay), or it
      // expired or never existed. The two are audited separately; both return
      // the same message, so the caller learns nothing either way.
      // The atomic update matched nothing — either the challenge doesn't
      // exist, was already consumed (replay), or is expired. Distinguish
      // those for the audit trail with a read-only lookup; this happens
      // after the fact, so it cannot reintroduce the race the update above
      // closes.
      const usedChallenge = await this.prisma.walletChallenge.findFirst({
        where: {
          id: input.challengeId,
          walletAddress: input.walletAddress,
          usedAt: { not: null },
        },
      });

      if (usedChallenge) {
        await this.auditService.recordEvent(
          AuthEventType.CHALLENGE_REPLAYED,
          input.walletAddress,
          {
            challengeId: input.challengeId,
            success: false,
            failureReason: "Challenge already used",
            clientMetadata: input.clientMetadata,
          },
        );
      } else {
        await this.auditService.recordEvent(
          AuthEventType.CHALLENGE_EXPIRED,
          input.walletAddress,
          {
            challengeId: input.challengeId,
            success: false,
            failureReason: "Challenge expired or not found",
            clientMetadata: input.clientMetadata,
          },
        );
      }

      throw new UnauthorizedException("Challenge is expired or unavailable");
    }

    // Fetch the now-consumed challenge to get the message for signature
    // verification. It is already marked as used, so even if verification
    // fails below, it cannot be reused (no signature-oracle attack).
    // Fetch the challenge again to get the message for signature verification.
    // It is already marked used, so a failed verification cannot be retried.
    // The challenge is now marked as used, so even if verification fails, it cannot be reused.
    const challenge = await this.prisma.walletChallenge.findUnique({
      where: {
        id: input.challengeId,
      },
    });

    if (!challenge) {
      // Should never happen: we just consumed this row atomically above.
      throw new UnauthorizedException("Challenge is expired or unavailable");
    }

    // Reject legacy challenges (no network or origin bound)
    if (!challenge.networkPassphrase || !challenge.origin) {
      this.logger.warn('[Auth] Legacy challenge rejected — no network/origin binding', {
        challengeId: input.challengeId,
      });
      throw new UnauthorizedException(
        'Challenge context is not bound to network and origin',
      );
    }

    // Verify network passphrase matches
    if (challenge.networkPassphrase !== this.networkPassphrase) {
      this.logger.warn('[Auth] Network mismatch rejected', {
        challengeId: input.challengeId,
        // Do NOT log the challenge's stored passphrase to avoid oracle attack
      });
      throw new UnauthorizedException('Challenge network mismatch');
    }

    // Normalize and verify origin matches
    let normalizedRequestOrigin: string;
    try {
      // If no request origin provided, use appUrl as default
      const originToValidate = input.requestOrigin || this.appUrl;
      normalizedRequestOrigin = normalizeOrigin(originToValidate);
    } catch {
      throw new UnauthorizedException('Invalid request origin');
    }

    if (challenge.origin !== normalizedRequestOrigin) {
      this.logger.warn('[Auth] Origin mismatch rejected', {
        challengeId: input.challengeId,
        // Log neither origin for audit — just that a mismatch occurred
      });
      throw new UnauthorizedException('Challenge origin mismatch');
    }

    // Network and origin verified — now verify signature (existing logic)
    const isValid = this.verifySignature(
      input.walletAddress,
      challenge.message,
      input.signature,
    );

    if (!isValid) {
      await this.auditService.recordEvent(
        AuthEventType.SIGNATURE_INVALID,
        input.walletAddress,
        {
          challengeId: input.challengeId,
          success: false,
          failureReason: "Invalid signature",
          clientMetadata: input.clientMetadata,
        },
      );

      throw new UnauthorizedException("Invalid wallet signature");
    }

    // A suspended, revoked or deleted account proves wallet control like any
    // other, but must not be issued a session. Checked after the signature so
    // the refusal reveals account state only to the wallet's own key holder.
    const existingAccount = await this.prisma.user.findUnique({
      where: { walletAddress: input.walletAddress },
      select: { status: true },
    });

    if (existingAccount && !canAuthenticate(existingAccount.status)) {
      await this.auditService.recordEvent(
        AuthEventType.ACCOUNT_INACTIVE,
        input.walletAddress,
        {
          challengeId: input.challengeId,
          success: false,
          failureReason: "Account is not active",
          clientMetadata: input.clientMetadata,
        },
      );

      throw new UnauthorizedException("Account is not active");
    }

    const walletHash = `sha256:${sha256(input.walletAddress)}`;
    const user = await this.prisma.user.upsert({
      where: { walletAddress: input.walletAddress },
      update: { walletHash, lastLoginAt: new Date() },
      create: {
        walletAddress: input.walletAddress,
        walletHash,
        lastLoginAt: new Date(),
      },
    });

    // The challenge was already atomically marked as consumed above, before
    // signature verification — no further write is needed here.

    // Create a persisted, revocable session.  Only the hash is stored.
    const { token, sessionId, expiresAt } = await this.sessionService.create({
      id: user.id,
      walletAddress: user.walletAddress,
      walletHash: user.walletHash,
      role: user.role,
    }, undefined, headers);

    // Record successful verification
    await this.auditService.recordEvent(
      AuthEventType.CHALLENGE_VERIFIED,
      input.walletAddress,
      {
        challengeId: input.challengeId,
        success: true,
        clientMetadata: input.clientMetadata,
      },
    );

    return {
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        walletHash: user.walletHash,
        role: user.role,
      },
      session: {
        token,
        tokenType: "Bearer",
        sessionId,
        expiresAt,
      },
    };
  }

  async getSession(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        walletAddress: true,
        walletHash: true,
        role: true,
        status: true,
        lastLoginAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException("User session is no longer valid");
    }

    return { user };
  }

  /**
   * Revoke the caller's active session server-side.
   * The sessionId is extracted from the authenticated request context by
   * the controller — the raw token is never passed here.
   */
  async logout(sessionId: string): Promise<void> {
    await this.sessionService.revoke(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private verifySignature(
    walletAddress: string,
    message: string,
    signature: string,
  ) {
    return verifyWalletSignature(walletAddress, message, signature);
  }

  private assertValidPublicKey(walletAddress: string) {
    if (!isValidWalletAddress(walletAddress)) {
      throw new BadRequestException("Invalid Stellar public key");
    }
  }
}
