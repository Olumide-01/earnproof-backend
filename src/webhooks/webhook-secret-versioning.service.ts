import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WebhookSecretState } from "@prisma/client";
import { randomBytes } from "crypto";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { PrismaService } from "../database/prisma.service";

/**
 * Manages webhook signing secret versioning with overlap windows.
 *
 * Secret lifecycle:
 * 1. Create a new secret in ACTIVE state (becomes the primary signing key)
 * 2. Optionally keep the previous key in OVERLAP state for a bounded window
 * 3. Move overlapped key to RETIRED state after the window expires
 *
 * This enables controlled rotation where:
 * - New deliveries always use the ACTIVE key
 * - Retries can use the OVERLAP key during the window
 * - Integrators can accept both ACTIVE and OVERLAP keys
 */
@Injectable()
export class WebhookSecretVersioningService {
  private readonly paymentEncryptionKeyring: PaymentEncryptionKeyringService;

  /** Default overlap window duration in milliseconds (24 hours). */
  private readonly defaultOverlapWindowMs: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.paymentEncryptionKeyring = new PaymentEncryptionKeyringService(configService);

    const overlapWindowMinutes = configService.get("WEBHOOK_SECRET_OVERLAP_WINDOW_MINUTES", 1440); // 24h default
    this.defaultOverlapWindowMs = overlapWindowMinutes * 60 * 1000;
  }

  /**
   * Create the initial secret for a new webhook.
   *
   * Returns the raw secret (to be returned once to the caller) and the keyId.
   */
  async createInitialSecret(webhookId: string): Promise<{ rawSecret: string; keyId: string }> {
    // Generate a non-secret key ID (short timestamp-based identifier)
    const keyId = `v${Math.floor(Date.now() / 1000)}`;

    // Generate the actual signing secret
    const rawSecret = randomBytes(32).toString("hex");
    const secretEncrypted = this.paymentEncryptionKeyring.encrypt(rawSecret);

    // Create the first secret version in ACTIVE state
    await this.prisma.webhookSecretVersion.create({
      data: {
        webhookId,
        keyId,
        secretEncrypted,
        state: WebhookSecretState.ACTIVE,
      },
    });

    return { rawSecret, keyId };
  }

  /**
   * Rotate the webhook signing secret.
   *
   * Moves the current ACTIVE secret to OVERLAP state (if there is one)
   * and creates a new ACTIVE secret. The OVERLAP secret will transition
   * to RETIRED after the overlap window expires.
   *
   * Returns the new raw secret and keyId.
   */
  async rotateSecret(webhookId: string): Promise<{ rawSecret: string; keyId: string }> {
    // Move current ACTIVE secret to OVERLAP
    const currentActive = await this.prisma.webhookSecretVersion.findFirst({
      where: {
        webhookId,
        state: WebhookSecretState.ACTIVE,
      },
      orderBy: { activatedAt: "desc" },
    });

    if (currentActive) {
      const overlapExpiresAt = new Date(Date.now() + this.defaultOverlapWindowMs);
      await this.prisma.webhookSecretVersion.update({
        where: { id: currentActive.id },
        data: {
          state: WebhookSecretState.OVERLAP,
          overlapExpiresAt,
        },
      });
    }

    // Create the new ACTIVE secret
    const keyId = `v${Math.floor(Date.now() / 1000)}`;
    const rawSecret = randomBytes(32).toString("hex");
    const secretEncrypted = this.paymentEncryptionKeyring.encrypt(rawSecret);

    await this.prisma.webhookSecretVersion.create({
      data: {
        webhookId,
        keyId,
        secretEncrypted,
        state: WebhookSecretState.ACTIVE,
      },
    });

    return { rawSecret, keyId };
  }

  /**
   * Get the current ACTIVE secret for a webhook.
   *
   * Returns the raw secret (decrypted) and keyId.
   */
  async getActiveSecret(
    webhookId: string,
  ): Promise<{ rawSecret: string; keyId: string; version: unknown } | null> {
    const secretVersion = await this.prisma.webhookSecretVersion.findFirst({
      where: {
        webhookId,
        state: WebhookSecretState.ACTIVE,
      },
      orderBy: { activatedAt: "desc" },
    });

    if (!secretVersion) {
      return null;
    }

    const rawSecret = this.paymentEncryptionKeyring.decrypt(secretVersion.secretEncrypted);
    return {
      rawSecret,
      keyId: secretVersion.keyId,
      version: secretVersion,
    };
  }

  /**
   * Get all usable secrets (ACTIVE or OVERLAP) for a webhook.
   *
   * Used during verification/retry to accept multiple keys.
   * Automatically retires expired OVERLAP secrets.
   */
  async getUsableSecrets(webhookId: string): Promise<
    Array<{
      rawSecret: string;
      keyId: string;
      state: WebhookSecretState;
    }>
  > {
    // Clean up expired OVERLAP secrets
    await this.prisma.webhookSecretVersion.updateMany({
      where: {
        webhookId,
        state: WebhookSecretState.OVERLAP,
        overlapExpiresAt: {
          lte: new Date(),
        },
      },
      data: {
        state: WebhookSecretState.RETIRED,
      },
    });

    // Fetch all ACTIVE and OVERLAP secrets
    const secrets = await this.prisma.webhookSecretVersion.findMany({
      where: {
        webhookId,
        state: {
          in: [WebhookSecretState.ACTIVE, WebhookSecretState.OVERLAP],
        },
      },
      orderBy: { activatedAt: "desc" },
    });

    return secrets.map((sv) => ({
      rawSecret: this.paymentEncryptionKeyring.decrypt(sv.secretEncrypted),
      keyId: sv.keyId,
      state: sv.state,
    }));
  }

  /**
   * Get a specific secret by keyId.
   *
   * Used when verifying a webhook signature to look up the key.
   * Automatically retires expired OVERLAP secrets.
   */
  async getSecretByKeyId(
    webhookId: string,
    keyId: string,
  ): Promise<{ rawSecret: string; state: WebhookSecretState } | null> {
    const secretVersion = await this.prisma.webhookSecretVersion.findUnique({
      where: {
        webhookId_keyId: { webhookId, keyId },
      },
    });

    if (!secretVersion) {
      return null;
    }

    // Auto-retire if it's an expired OVERLAP secret
    if (
      secretVersion.state === WebhookSecretState.OVERLAP &&
      secretVersion.overlapExpiresAt &&
      secretVersion.overlapExpiresAt <= new Date()
    ) {
      await this.prisma.webhookSecretVersion.update({
        where: { id: secretVersion.id },
        data: { state: WebhookSecretState.RETIRED },
      });
      return null; // Treat as not found after retirement
    }

    const rawSecret = this.paymentEncryptionKeyring.decrypt(secretVersion.secretEncrypted);
    return {
      rawSecret,
      state: secretVersion.state,
    };
  }

  /**
   * Get overlap window duration in milliseconds.
   *
   * This is used by tests and integrators to understand the overlap window.
   */
  getOverlapWindowMs(): number {
    return this.defaultOverlapWindowMs;
  }

  /**
   * Clean up retired secrets older than a certain age (for storage optimization).
   *
   * Called periodically to remove audit history. All information is preserved
   * in WebhookDelivery records which track the keyId used for each attempt.
   *
   * @param olderThanMs Age in milliseconds (default: 90 days for compliance/audit)
   */
  async cleanupRetiredSecrets(olderThanMs = 90 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.prisma.webhookSecretVersion.deleteMany({
      where: {
        state: WebhookSecretState.RETIRED,
        updatedAt: {
          lte: cutoff,
        },
      },
    });
    return result.count;
  }
}
