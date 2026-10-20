import { BadRequestException, Injectable } from "@nestjs/common";
import { randomBytes } from "crypto";
import { sha256 } from "../common/crypto/hash";
import { StructuredLogger } from "../common/logger";
import { PrismaService } from "../database/prisma.service";
import { WebhookSigningService } from "./webhook-signing.service";
import {
  SsrfBlockedError,
  assertSafeWebhookDestination,
} from "./webhook-ssrf-guard";

/** Verification challenges expire 5 minutes after issuance. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Raw challenge token length in bytes (produces a 43-char base64url string). */
const TOKEN_BYTES = 32;

/** Delivery timeout for a challenge send, matching real event deliveries. */
const CHALLENGE_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Proves control of a webhook destination before real event deliveries
 * begin.
 *
 * A challenge is delivered to the destination over the same guarded
 * outbound transport (SSRF guard, no-redirect, timeout) used for real
 * deliveries, signed the same way. The destination owner's integration is
 * expected to read the token from the delivered payload and echo it back
 * to `WebhooksService.verify` — a separate, authenticated call — rather
 * than this challenge send itself expecting a synchronous reply body. That
 * keeps "timeout" (no callback ever arrives) distinct from "the HTTP POST
 * failed", both of which this issue's acceptance criteria require covering.
 */
@Injectable()
export class WebhookVerificationService {
  private readonly logger = new StructuredLogger(WebhookVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signing: WebhookSigningService,
  ) {}

  /**
   * Issue a new challenge for `webhookId` targeting `url`, invalidating any
   * previously issued, still-unused challenges for that webhook first — so
   * a destination change (or a deliberate re-issue) can never be satisfied
   * by an acknowledgement meant for a different challenge.
   *
   * Best-effort delivers the challenge; a delivery failure does not throw
   * (the webhook stays unverified and a new challenge can be requested),
   * since the destination may simply be unreachable right now.
   */
  async issueChallenge(
    webhookId: string,
    url: string,
    signingSecret: string,
  ): Promise<{ challengeId: string; expiresAt: Date }> {
    await this.prisma.webhookVerificationChallenge.updateMany({
      where: { webhookId, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

    const challenge = await this.prisma.webhookVerificationChallenge.create({
      data: {
        webhookId,
        tokenHash: sha256(token),
        url,
        expiresAt,
      },
      select: { id: true },
    });

    await this.deliverChallenge(
      webhookId,
      url,
      challenge.id,
      token,
      expiresAt,
      signingSecret,
    );

    return { challengeId: challenge.id, expiresAt };
  }

  /**
   * Atomically consume the challenge matching `token` for `webhookId`, iff
   * it is unused and unexpired. Returns `true` on success.
   *
   * Uses a single conditional `updateMany` (rather than a read followed by
   * a write) so two concurrent verification attempts for the same token
   * cannot both observe it as valid — only one can ever consume it, closing
   * the replay window.
   */
  async verifyChallenge(webhookId: string, token: string): Promise<boolean> {
    const tokenHash = sha256(token);

    const consumed = await this.prisma.webhookVerificationChallenge.updateMany({
      where: {
        webhookId,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });

    if (consumed.count === 0) {
      throw new BadRequestException("Invalid or expired verification token");
    }

    return true;
  }

  private async deliverChallenge(
    webhookId: string,
    url: string,
    challengeId: string,
    token: string,
    expiresAt: Date,
    signingSecret: string,
  ): Promise<void> {
    const body = JSON.stringify({
      type: "webhook.verification",
      challengeId,
      token,
      expiresAt: expiresAt.toISOString(),
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.signing.sign(signingSecret, timestamp, challengeId, body);

    try {
      await assertSafeWebhookDestination(url);

      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-EarnProof-Timestamp": String(timestamp),
          "X-EarnProof-Delivery": challengeId,
          "X-EarnProof-Event": "webhook.verification",
          "X-EarnProof-Signature": signature,
        },
        body,
        // Do NOT follow redirects — prevents an open redirect from
        // forwarding the challenge token to an internal address.
        redirect: "error",
        signal: AbortSignal.timeout(CHALLENGE_DELIVERY_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        this.logger.warn(
          `Verification challenge for webhook ${webhookId} blocked by SSRF guard: ${err.message}`,
        );
        return;
      }
      this.logger.warn(
        `Verification challenge delivery failed for webhook ${webhookId}: ${String(err)}`,
      );
    }
  }
}
