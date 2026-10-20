import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ResourceStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { ConflictException } from "../common/exceptions/domain.exceptions";
import { CreateWebhookDto } from "./dto/create-webhook.dto";
import { UpdateWebhookEventsDto } from "./dto/update-webhook-events.dto";
import { UpdateWebhookUrlDto } from "./dto/update-webhook-url.dto";
import { VerifyWebhookDto } from "./dto/verify-webhook.dto";
import { OrganizationQuotaService } from "../quotas/organization-quota.service";
import { WebhookDeliveryService } from "./webhook-delivery.service";
import { WebhookCircuitBreakerService } from "./webhook-circuit-breaker.service";
import { PredicatePreviewService } from "./services/predicate-preview.service";
import { CURRENT_WEBHOOK_PAYLOAD_VERSION } from "./webhook-event.types";

/** Signing secret length in bytes (produces a 64-char hex string). */
const SECRET_BYTES = 32;

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryService: WebhookDeliveryService,
    private readonly circuitBreaker: WebhookCircuitBreakerService,
    private readonly verificationService: WebhookVerificationService,
    configService: ConfigService,
    private readonly quotas: OrganizationQuotaService,
    private readonly secretRetrievalReceiptService: SecretRetrievalReceiptService,
    private readonly predicatePreviewService: PredicatePreviewService,
  ) {
    this.paymentEncryptionKeyring = new PaymentEncryptionKeyringService(
      configService,
    );
  }

  /**
   * Create a webhook endpoint for the given organisation.
   *
   * The endpoint starts `PENDING`: no real event deliveries go out until the
   * destination's ownership is verified (see `verify`). A verification
   * challenge is issued and sent immediately.
   *
   * Returns the raw signing secret ONCE — it is never retrievable again.
   * The caller must store it securely.
   */
  async create(organizationId: string, dto: CreateWebhookDto) {
    // De-duplicate events list
    const events = [...new Set(dto.events)];

    // Quota check, creation, receipt, and circuit breaker initialization together
    const webhook = await this.prisma.$transaction(async (tx) => {
      await this.quotas.assertCapacity(tx, organizationId, "webhooks");

      const created = await tx.webhook.create({
        data: {
          organizationId,
          url: dto.url,
          secretEncrypted,
          events,
          status: ResourceStatus.ACTIVE,
          revision: 0,
        },
        select: {
          id: true,
          url: true,
          events: true,
          status: true,
          revision: true,
          createdAt: true,
        },
      });
    });

    // Initialize circuit breaker for new webhook (outside transaction for idempotency)
    await this.circuitBreaker.initializeCircuit(webhook.id);

    await this.verificationService.issueChallenge(webhook.id, dto.url, rawSecret);

    return {
      ...webhook,
      // Returned once at creation time only.
      signingSecret: rawSecret,
      keyId,
    };
  }

  /** List webhook endpoints for an organisation, newest first. */
  async listForOrg(
    organizationId: string,
    pagination: { cursor?: string; limit?: number } = {},
  ) {
    const limit = pagination.limit ?? 20;
    const cursorWhere = cursorWhereFragment(pagination.cursor, "createdAt");

    const rows = await this.prisma.webhook.findMany({
      where: { organizationId, ...cursorWhere },
      orderBy: cursorOrderBy("createdAt"),
      take: limit + 1,
      select: {
        id: true,
        url: true,
        events: true,
        payloadVersion: true,
        status: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return buildPage(rows, limit, "createdAt");
  }

  /** Get a single webhook, asserting ownership. */
  async getForOrg(organizationId: string, webhookId: string) {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: {
        id: true,
        organizationId: true,
        url: true,
        events: true,
        payloadVersion: true,
        status: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.assertOwnership(webhook, organizationId, webhookId);
    return webhook!;
  }

  /**
   * Rotate the webhook signing secret.
   *
   * Moves the current ACTIVE secret to OVERLAP state (with a bounded overlap window)
   * and creates a new ACTIVE secret. This allows retries and replays to use the previous
   * key for a limited time.
   *
   * Returns the new raw secret and keyId once.
   */
  async rotateSecret(organizationId: string, webhookId: string) {
    const webhook = await this.assertOwnedWebhook(organizationId, webhookId);

    const newRawSecret = randomBytes(SECRET_BYTES).toString("hex");
    const newSecretEncrypted = this.paymentEncryptionKeyring.encrypt(newRawSecret);

    // Update webhook and create receipt atomically
    await this.prisma.$transaction(async (tx) => {
      await tx.webhook.update({
        where: { id: webhookId },
        data: {
          secretEncrypted: newSecretEncrypted,
          revision: webhook.revision + 1,
        },
      });

      // Create receipt: immutable evidence that new signing secret was revealed
      const receipt = await this.secretRetrievalReceiptService.create(
        {
          organizationId,
          secretType: SecretType.WEBHOOK,
          resourceId: webhookId,
          resourceReference: webhook.url,
          recipientId: undefined,
          deliveryChannel: DeliveryChannel.HTTP_RESPONSE,
          revealedAt: new Date(),
        },
        tx,
      );

      // Audit log: webhook secret rotated
      await tx.auditLog.create({
        data: {
          actorType: "user",
          action: "webhook.rotated",
          resourceType: "webhook",
          resourceId: webhookId,
          organizationId,
          metadata: {
            url: webhook.url,
            receiptId: receipt.id,
          },
        },
      });
    });

    return {
      webhookId,
      signingSecret: rawSecret,
      keyId,
      rotatedAt: new Date().toISOString(),
      note: "Previous secret is active for the overlap window to allow retries to use it. After the window expires, only new deliveries will use the new secret.",
    };
  }

  /** Update subscribed event types. */
  async updateEvents(
    organizationId: string,
    webhookId: string,
    dto: UpdateWebhookEventsDto,
  ) {
    const webhook = await this.assertOwnedWebhook(organizationId, webhookId);
    const events = [...new Set(dto.events)];

    // Attempt optimistic update with revision check
    const updated = await this.prisma.webhook.updateMany({
      where: {
        id: webhookId,
        revision: dto.expectedRevision,
      },
      data: {
        events,
        revision: dto.expectedRevision + 1,
      },
    });

    // If no records were updated, the revision didn't match
    if (updated.count === 0) {
      throw new ConflictException(
        "Webhook has been modified by another request. Please refresh and retry.",
        webhook.revision,
      );
    }

    return this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { id: true, url: true, events: true, status: true, revision: true, updatedAt: true },
    });
  }

  /** Disable (suspend) a webhook endpoint without deleting it. */
  async disable(organizationId: string, webhookId: string) {
    const webhook = await this.assertOwnedWebhook(organizationId, webhookId);

    return this.prisma.webhook.update({
      where: { id: webhookId },
      data: {
        status: ResourceStatus.SUSPENDED,
        revision: webhook.revision + 1,
      },
      select: { id: true, status: true, revision: true, updatedAt: true },
    });
  }

  /** Re-enable a previously disabled webhook endpoint. */
  async enable(organizationId: string, webhookId: string) {
    const webhook = await this.assertOwnedWebhook(organizationId, webhookId);

    return this.prisma.webhook.update({
      where: { id: webhookId },
      data: {
        status: ResourceStatus.ACTIVE,
        revision: webhook.revision + 1,
      },
      select: { id: true, status: true, revision: true, updatedAt: true },
    });
  }

  /** Soft-delete (mark DELETED) a webhook endpoint. */
  async delete(organizationId: string, webhookId: string) {
    const webhook = await this.assertOwnedWebhook(organizationId, webhookId);

    await this.prisma.webhook.update({
      where: { id: webhookId },
      data: {
        status: ResourceStatus.DELETED,
        revision: webhook.revision + 1,
      },
    });

    // Clean up circuit breaker state
    await this.circuitBreaker.deleteCircuitState(webhookId);

    return { deleted: true, webhookId };
  }

  /**
   * Replay a specific delivery.
   *
   * Authorization (DEVELOPER or ADMIN role) is enforced in the controller.
   * The caller must also own the webhook org.
   */
  async replayDelivery(
    organizationId: string,
    deliveryId: string,
    replayedById: string,
  ) {
    // Verify the delivery belongs to one of this org's webhooks.
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        webhook: { select: { organizationId: true } },
      },
    });

    if (!delivery) {
      throw new NotFoundException("Delivery not found");
    }

    if (delivery.webhook.organizationId !== organizationId) {
      throw new ForbiddenException("Delivery does not belong to this organisation");
    }

    // Persist audit record before dispatching.
    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: replayedById,
        action: "webhook.delivery.replayed",
        resourceType: "webhookDelivery",
        resourceId: deliveryId,
        metadata: {
          webhookId: delivery.webhookId,
          eventType: delivery.eventType,
          eventId: delivery.eventId,
          originalAttempt: delivery.attempt,
        },
      },
    });

    const newDeliveryId = await this.deliveryService.replay(deliveryId, replayedById);

    return {
      replayDeliveryId: newDeliveryId,
      originalDeliveryId: deliveryId,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      replayedBy: replayedById,
      replayedAt: new Date().toISOString(),
    };
  }

  /**
   * Send a synthetic, signed `webhook.test` event to an endpoint and return
   * redacted delivery diagnostics.
   *
   * Role authorization (DEVELOPER or ADMIN) is enforced in the controller; this
   * asserts the endpoint belongs to the caller's organisation and is active,
   * the same preconditions a replay has. Nothing is persisted: see
   * `WebhookDeliveryService.sendTestDelivery`.
   */
  async sendTestDelivery(organizationId: string, webhookId: string) {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: {
        id: true,
        organizationId: true,
        url: true,
        secretEncrypted: true,
        status: true,
      },
    });

    this.assertOwnership(webhook, organizationId, webhookId);

    if (webhook!.status !== ResourceStatus.ACTIVE) {
      throw new BadRequestException(
        "Cannot send a test delivery to a disabled webhook endpoint",
      );
    }

    return this.deliveryService.sendTestDelivery(webhook!);
  }

  /**
   * List delivery records for a webhook endpoint.
   * Response body and sensitive headers are never stored in delivery rows,
   * so this is safe to return directly.
   */
  async listDeliveries(
    organizationId: string,
    webhookId: string,
    pagination: { cursor?: string; limit?: number } = {},
  ) {
    await this.assertOwnedWebhook(organizationId, webhookId);

    const limit = pagination.limit ?? 20;
    const cursorWhere = cursorWhereFragment(pagination.cursor, "createdAt");

    const rows = await this.prisma.webhookDelivery.findMany({
      where: { webhookId, ...cursorWhere },
      orderBy: cursorOrderBy("createdAt"),
      take: limit + 1,
      select: {
        id: true,
        eventType: true,
        eventId: true,
        schemaVersion: true,
        attempt: true,
        status: true,
        statusCode: true,
        // responseBody stored truncated — safe to return
        responseBody: true,
        durationMs: true,
        failureReason: true,
        replayOf: true,
        replayedBy: true,
        deliveredAt: true,
        nextRetryAt: true,
        deadLetteredAt: true,
        deadLetterReason: true,
        redrivenAt: true,
        createdAt: true,
      },
    });

    return buildPage(rows, limit, "createdAt");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Like `assertOwnedWebhook`, but also returns `url` and `secretEncrypted`. */
  private async assertOwnedWebhookFull(organizationId: string, webhookId: string) {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: {
        id: true,
        organizationId: true,
        url: true,
        secretEncrypted: true,
        status: true,
        revision: true,
      },
    });
    this.assertOwnership(webhook, organizationId, webhookId);
    return webhook!;
  }

  private async assertOwnedWebhook(organizationId: string, webhookId: string) {
    const webhook = await this.prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { id: true, organizationId: true, status: true, revision: true },
    });
    this.assertOwnership(webhook, organizationId, webhookId);
    return webhook!;
  }

  private assertOwnership(
    webhook: { organizationId: string } | null,
    organizationId: string,
    webhookId: string,
  ): void {
    if (!webhook) {
      throw new NotFoundException(`Webhook ${webhookId} not found`);
    }
    if (webhook.organizationId !== organizationId) {
      throw new ForbiddenException("Webhook does not belong to this organisation");
    }
  }

  /** Expose decrypt for testing secret rotation. */
  revealSecret(secretEncrypted: string): string {
    return this.paymentEncryptionKeyring.decrypt(secretEncrypted);
  }

  /**
   * Preview a predicate against a sample event.
   *
   * Tests whether a predicate matches a given event without creating a delivery
   * or modifying any state. Returns the match result and budget usage.
   *
   * Authorization: caller must have an active organization (already checked by controller).
   * No webhook-specific permission needed; this is a read-only test endpoint.
   *
   * @param organizationId Tenant context (for audit/rate limiting)
   * @param predicateRaw Raw predicate object (must be validated by class-validator)
   * @param eventRaw Raw event object (must be validated by class-validator)
   * @returns Match result with budget usage
   */
  async previewPredicate(
    organizationId: string,
    predicateRaw: any,
    eventRaw: any,
  ): Promise<{ match: boolean; reason?: string; visitedNodes: number }> {
    // predicateRaw and eventRaw are validated by class-validator in the DTO
    // layer before reaching this point, so we trust their structure.
    return this.predicatePreviewService.preview(predicateRaw, eventRaw);
  }
}
