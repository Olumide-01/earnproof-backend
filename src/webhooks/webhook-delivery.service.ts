import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, WebhookDeliveryStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { Agent, type Dispatcher } from "undici";
import { decryptProtectedAmount } from "../common/crypto/protected-amount";
import { PrismaService } from "../database/prisma.service";
import { WebhookClientCertificateService } from "./webhook-client-certificate.service";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { StructuredLogger } from "../common/logger";
import {
  payloadDeprecation,
  serializeWebhookEvent,
} from "./webhook-payload.serializers";
import {
  CURRENT_WEBHOOK_PAYLOAD_VERSION,
  WEBHOOK_TEST_EVENT_ID_PREFIX,
  WEBHOOK_TEST_EVENT_TYPE,
  WEBHOOK_TEST_EVENT_VERSION,
  WebhookEnvelope,
  WebhookEventSource,
  WebhookEventType,
  WebhookTestEnvelope,
} from "./webhook-event.types";
import { WebhookSigningService } from "./webhook-signing.service";
import { WebhookSecretVersioningService } from "./webhook-secret-versioning.service";
import {
  SsrfBlockedError,
  assertSafeWebhookDestination,
} from "./webhook-ssrf-guard";
import { WebhookCircuitBreakerService } from "./webhook-circuit-breaker.service";
import { PredicateEvaluatorService } from "./services/predicate-evaluator.service";
import { Predicate } from "./predicate.types";

/** Thrown when a webhook requires mTLS but has no currently valid client certificate. */
class MtlsCertificateUnavailableError extends Error {
  constructor() {
    super("no active client certificate available for mTLS delivery");
  }
}

/** Maximum stored response body size in bytes (1 KiB). */
const MAX_RESPONSE_BODY_BYTES = 1024;

/** Delivery timeout in milliseconds. */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Default maximum delivery attempts per chain (1 initial + 4 retries).
 * Overridable with WEBHOOK_MAX_DELIVERY_ATTEMPTS.
 */
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;

/** Exponential backoff base in milliseconds. */
const BACKOFF_BASE_MS = 1_000;

/**
 * Stable reason codes recorded when a delivery chain ends without success.
 * Codes, not messages: operators filter on them, and they never carry
 * response content.
 */
export const DeadLetterReason = {
  MAX_ATTEMPTS_EXHAUSTED: "max_attempts_exhausted",
  DESTINATION_BLOCKED: "destination_blocked",
  SIGNING_SECRET_UNAVAILABLE: "signing_secret_unavailable",
  ENDPOINT_DISABLED: "endpoint_disabled",
} as const;

export type DeadLetterReasonValue =
  (typeof DeadLetterReason)[keyof typeof DeadLetterReason];

/**
 * Compute delay before attempt `n` (1-indexed).
 * Attempt 1 = immediate (no delay).
 * Attempt 2 = 1 s, 3 = 2 s, 4 = 4 s, 5 = 8 s.
 */
function backoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return BACKOFF_BASE_MS * Math.pow(2, attempt - 2);
}

/**
 * Per-webhook serialization queue.
 *
 * Deliveries for the same webhook endpoint are chained on a single
 * Promise so they execute strictly in FIFO order and never interleave.
 * This enforces ordering guarantees per aggregate (webhook endpoint).
 */
type WebhookChain = { tail: Promise<void> };

@Injectable()
export class WebhookDeliveryService implements OnModuleInit {
  private readonly logger = new StructuredLogger(WebhookDeliveryService.name);
  private readonly encryptionKey: string;
  private readonly maxAttempts: number;
  private readonly paymentEncryptionKeyring: PaymentEncryptionKeyringService;

  /**
   * Per-webhook serialization chains.
   * Key = webhookId, value = chain whose `tail` is the last enqueued delivery.
   */
  private readonly chains = new Map<string, WebhookChain>();

  private readonly clientCertificates: WebhookClientCertificateService;
  private readonly circuitBreaker: WebhookCircuitBreakerService;
  private readonly predicateEvaluator: PredicateEvaluatorService;

  constructor(
    prisma: PrismaService,
    signing: WebhookSigningService,
    clientCertificates: WebhookClientCertificateService,
    circuitBreaker: WebhookCircuitBreakerService,
    predicateEvaluator: PredicateEvaluatorService,
    configService: ConfigService,
  );
  constructor(
    prisma: PrismaService,
    signing: WebhookSigningService,
    clientCertificates: WebhookClientCertificateService,
    predicateEvaluator: PredicateEvaluatorService,
    configService: ConfigService,
  );
  constructor(
    prisma: PrismaService,
    signing: WebhookSigningService,
    predicateEvaluator: PredicateEvaluatorService,
    configService: ConfigService,
  );
  constructor(
    private readonly prisma: PrismaService,
    private readonly signing: WebhookSigningService,
    arg3?: WebhookClientCertificateService | PredicateEvaluatorService | ConfigService,
    arg4?: WebhookCircuitBreakerService | PredicateEvaluatorService | ConfigService,
    arg5?: PredicateEvaluatorService | ConfigService,
    arg6?: ConfigService,
  ) {
    const defaultCircuitBreaker: WebhookCircuitBreakerService = {
      canAttemptDelivery: async () => true,
      initializeCircuit: async () => {},
      recordSuccess: async () => {},
      recordFailure: async () => {},
    } as unknown as WebhookCircuitBreakerService;

    const defaultClientCertificates: WebhookClientCertificateService = {
      selectActiveCertificate: async () => null,
    } as unknown as WebhookClientCertificateService;

    const defaultPredicateEvaluator: PredicateEvaluatorService = {
      evaluate: () => ({ match: true, visited: 0 }),
      deriveContext: () => ({ resource: "", outcome: "", schemaVersion: "" }),
    } as unknown as PredicateEvaluatorService;

    const isConfig = (obj: unknown): obj is ConfigService =>
      Boolean(obj && typeof (obj as any).get === "function");

    let resolvedConfig: ConfigService;
    let resolvedClientCertificates = defaultClientCertificates;
    let resolvedCircuitBreaker = defaultCircuitBreaker;
    let resolvedPredicateEvaluator = defaultPredicateEvaluator;
    if (arg5 && isConfig(arg5)) {
      this.clientCertificates =
        (arg3 as WebhookClientCertificateService) ?? defaultClientCertificates;
      this.circuitBreaker =
        (arg4 as WebhookCircuitBreakerService) ?? defaultCircuitBreaker;
      this.predicateEvaluator = arg6 as PredicateEvaluatorService ?? defaultPredicateEvaluator;
      resolvedConfig = arg5;
    } else if (arg4 && isConfig(arg4)) {
      this.clientCertificates =
        (arg3 as WebhookClientCertificateService) ?? defaultClientCertificates;
      this.circuitBreaker = defaultCircuitBreaker;
      this.predicateEvaluator = (arg5 as unknown as PredicateEvaluatorService) ?? defaultPredicateEvaluator;
      resolvedConfig = arg4;
    } else if (arg3 && isConfig(arg3)) {
      this.clientCertificates = defaultClientCertificates;
      this.circuitBreaker = defaultCircuitBreaker;
      this.predicateEvaluator = arg4 as PredicateEvaluatorService ?? defaultPredicateEvaluator;
      resolvedConfig = arg3;
    } else {
      this.clientCertificates =
        (arg3 as WebhookClientCertificateService) ?? defaultClientCertificates;
      this.circuitBreaker =
        (arg4 as WebhookCircuitBreakerService) ?? defaultCircuitBreaker;
      this.predicateEvaluator = (arg5 as PredicateEvaluatorService) ?? defaultPredicateEvaluator;
      resolvedConfig = new ConfigService();
    }

    const safeGetConfig = <T>(key: string): T | undefined => {
      try {
        if (typeof (resolvedConfig as any).getOrThrow === "function") {
          return (resolvedConfig as any).getOrThrow(key);
        }
      } catch {}
      return (resolvedConfig as any).get?.(key);
    };

    this.encryptionKey =
      safeGetConfig<string>("paymentEncryptionKey") ?? "0".repeat(64);
    this.maxAttempts =
      safeGetConfig<number>("webhooks.maxDeliveryAttempts") ??
      DEFAULT_MAX_DELIVERY_ATTEMPTS;

    const proxyConfig = new Proxy(resolvedConfig, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return (key: string) => safeGetConfig(key);
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    this.paymentEncryptionKeyring = new PaymentEncryptionKeyringService(
      proxyConfig,
    );
  }

  /** The configured retry threshold: attempts allowed per delivery chain. */
  get maxDeliveryAttempts(): number {
    return this.maxAttempts;
  }

  /**
   * On startup, re-enqueue any deliveries that were PENDING when the process
   * last shut down (handles crash recovery).
   */
  async onModuleInit(): Promise<void> {
    const pending = await this.prisma.webhookDelivery.findMany({
      where: { status: WebhookDeliveryStatus.PENDING },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        webhookId: true,
        attempt: true,
        nextRetryAt: true,
      },
    });

    for (const delivery of pending) {
      const delay = delivery.nextRetryAt
        ? Math.max(0, delivery.nextRetryAt.getTime() - Date.now())
        : 0;
      this.scheduleDelivery(delivery.id, delivery.webhookId, delay);
    }

    if (pending.length > 0) {
      this.logger.log(`Re-enqueued ${pending.length} pending delivery(-ies) on startup`);
    }
  }

  /**
   * Enqueue a domain event for all active, subscribing endpoints belonging to
   * the organisations the user is a member of.
   *
   * The event gets one identifier and one occurrence time, shared by every
   * endpoint and every later retry. Each endpoint receives the payload version
   * it is pinned to, serialized once and persisted as exact bytes.
   *
   * Called by ProofsService after each lifecycle event.
   */
  async enqueueForUser(
    userId: string,
    domainEventOrType: WebhookEventType | WebhookEventSource,
    legacyEnvelope?: { event: WebhookEventType; data: any },
  ): Promise<void> {
    const domainEvent: WebhookEventSource =
      typeof domainEventOrType === "string"
        ? ({ event: domainEventOrType, source: legacyEnvelope?.data ?? legacyEnvelope } as WebhookEventSource)
        : domainEventOrType;
    // Resolve which organisations the user belongs to
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        organizations: {
          // An archived organization receives no new events.
          where: { archivedAt: null },
          select: { id: true },
        },
      },
    });
    if (!user || user.organizations.length === 0) return;

    const orgIds = user.organizations.map((o) => o.id);
    await this.enqueueForOrganizations(orgIds, domainEvent);
  }

  /**
   * Enqueue an event for every active, subscribing endpoint of a single
   * organisation.
   *
   * Used by producers whose event belongs to an organisation directly rather
   * than to a user — the attestation reconciler, whose attestations are owned by
   * an issuer's organisation, not by any one user.
   */
  async enqueueForOrganization(
    organizationId: string,
    domainEventOrType: WebhookEventType | WebhookEventSource,
    legacyEnvelope?: { event: WebhookEventType; data: any },
  ): Promise<void> {
    const domainEvent: WebhookEventSource =
      typeof domainEventOrType === "string"
        ? ({ event: domainEventOrType, source: legacyEnvelope?.data ?? legacyEnvelope } as WebhookEventSource)
        : domainEventOrType;
    await this.enqueueForOrganizations([organizationId], domainEvent);
  }

  private async enqueueForOrganizations(
    orgIds: string[],
    domainEvent: WebhookEventSource,
  ): Promise<void> {
    if (orgIds.length === 0) return;

    const webhooks = await this.prisma.webhook.findMany({
      where: {
        organizationId: { in: orgIds },
        status: "ACTIVE",
      },
      select: {
        id: true,
        events: true,
        predicate: true,
        payloadVersion: true,
      },
    });

    const eventId = randomUUID();
    const occurredAt = new Date();

    for (const hook of webhooks) {
      const subscribedEvents = this.parseEvents(hook.events);
      if (!subscribedEvents.includes(domainEvent.event)) continue;

      // Evaluate predicate if present
      if (hook.predicate) {
        const context = this.predicateEvaluator.deriveContext(
          domainEvent.event,
          hook.payloadVersion,
        );
        const predicateResult = this.predicateEvaluator.evaluate(
          hook.predicate as Predicate,
          context,
        );

        // Fail closed: if predicate evaluation fails or budget is exceeded, skip delivery
        if (!predicateResult.match) {
          this.logger.debug(
            `Webhook ${hook.id}: predicate did not match ${domainEvent.event} (reason: ${predicateResult.reason ?? "no_match"})`,
          );
          continue;
        }

        // Log if budget was close to exhaustion (potential DoS)
        if (predicateResult.visited >= 200) {
          this.logger.warn(
            `Webhook ${hook.id}: predicate evaluation used ${predicateResult.visited} budget units (near limit)`,
          );
        }
      }

      let serialized: ReturnType<typeof serializeWebhookEvent>;
      try {
        serialized = serializeWebhookEvent({
          event: domainEvent.event,
          source: domainEvent.source as never,
          eventId,
          occurredAt,
          version: hook.payloadVersion,
        });
      } catch (err) {
        // Fail closed: an event that cannot be serialized to the endpoint's
        // declared contract is not delivered at all.
        this.logger.error(
          `Webhook ${hook.id}: cannot serialize ${domainEvent.event} for payload version ${hook.payloadVersion}: ${String(err)}`,
        );
        continue;
      }

      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          webhookId: hook.id,
          eventType: domainEvent.event,
          eventId,
          payload: serialized.envelope as unknown as Prisma.InputJsonValue,
          schemaVersion: serialized.schemaVersion,
          payloadBody: serialized.body,
          predicateSnapshot: hook.predicate as unknown as Prisma.InputJsonValue,
          attempt: 1,
          status: WebhookDeliveryStatus.PENDING,
        },
        select: { id: true },
      });

      // Initialize circuit breaker for webhook if needed
      await this.circuitBreaker.initializeCircuit(hook.id);

      this.scheduleDelivery(delivery.id, hook.id, 0);
    }
  }

  /**
   * Schedule an already-persisted PENDING delivery for immediate dispatch,
   * serialised behind any in-flight delivery for the same endpoint.
   *
   * Used by redrive, which creates its delivery row inside a transaction and
   * must dispatch only after that transaction has committed.
   */
  dispatch(deliveryId: string, webhookId: string): void {
    this.scheduleDelivery(deliveryId, webhookId, 0);
  }

  /**
   * Re-deliver a delivery that already has a persisted `WebhookDelivery` row.
   * Called by the replay endpoint.
   *
   * Returns the new delivery id created for the replay attempt.
   */
  async replay(
    originalDeliveryId: string,
    replayedBy: string,
  ): Promise<string> {
    const original = await this.prisma.webhookDelivery.findUnique({
      where: { id: originalDeliveryId },
      include: {
        webhook: {
          select: {
            id: true,
            url: true,
            secretEncrypted: true,
            status: true,
            events: true,
          },
        },
      },
    });

    if (!original) {
      throw new NotFoundException("WebhookDelivery not found");
    }

    if (original.webhook.status !== "ACTIVE") {
      throw new BadRequestException(
        "Cannot replay delivery for a disabled webhook endpoint",
      );
    }

    const replayKey = `${originalDeliveryId}:${replayedBy}`;
    const existingReplay = await this.prisma.webhookDelivery.findUnique({
      where: { replayKey },
      select: { id: true },
    });
    if (existingReplay) return existingReplay.id;

    // Replay is idempotent per (originalDeliveryId, replayedBy): re-using
    // the same eventId in the envelope means integrators can deduplicate on
    // X-EarnProof-Delivery just like they do for normal retries.
    const replayDelivery = await this.prisma.webhookDelivery.create({
      data: {
        webhookId: original.webhookId,
        eventType: original.eventType,
        payload: original.payload as Prisma.InputJsonValue,
        // Original version and bytes: a replay is the same event, not a new one.
        schemaVersion: original.schemaVersion,
        payloadBody: original.payloadBody,
        eventId: original.eventId, // same eventId → integrator deduplicates
        attempt: 1,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: originalDeliveryId,
        replayedBy,
        replayKey,
      },
      select: { id: true },
    });

    this.scheduleDelivery(replayDelivery.id, original.webhookId, 0);

    return replayDelivery.id;
  }

  // ---------------------------------------------------------------------------
  // Internal scheduling helpers
  // ---------------------------------------------------------------------------

  /**
   * Schedule a delivery to run after `delayMs` milliseconds, serialised
   * behind any already-running delivery for the same webhook.
   *
   * The worker always re-reads the delivery row: the persisted body is the
   * single source of truth for what is signed and sent.
   */
  private scheduleDelivery(
    deliveryId: string,
    webhookId: string,
    delayMs: number,
  ): void {
    const existing = this.chains.get(webhookId);
    const tail = existing?.tail ?? Promise.resolve();

    const next = tail.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(async () => {
            try {
              // Check circuit breaker before attempting delivery
              const canAttempt = await this.circuitBreaker.canAttemptDelivery(webhookId);
              if (!canAttempt) {
                this.logger.debug(`Delivery ${deliveryId} skipped - circuit is OPEN`);
                resolve();
                return;
              }

              await this.runDelivery(deliveryId);
            } catch {
              // runDelivery swallows its own errors and logs them;
              // we must not let an uncaught rejection break the chain.
            }
            resolve();
          }, delayMs);
        }),
    );

    this.chains.set(webhookId, { tail: next });
  }

  /**
   * Execute one delivery attempt. On failure, either schedules a retry (while
   * the retry threshold has not been reached) or dead-letters the attempt.
   */
  private async runDelivery(
    deliveryId: string,
    holdAggregateQueue = false,
  ): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        webhook: {
          select: {
            id: true,
            url: true,
            status: true,
            mtlsRequired: true,
            organization: { select: { archivedAt: true } },
          },
        },
      },
    });

    if (!delivery) {
      this.logger.warn(`Delivery ${deliveryId} not found; skipping`);
      return;
    }

    // A retry scheduled before the organization was archived is not sent.
    if (delivery.webhook.organization?.archivedAt) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          failureReason: "organization archived before delivery",
        },
      });
      return;
    }

    // If the endpoint was disabled between scheduling and execution, bail.
    // A delivery row is attempted at most once. Crash recovery and redrive can
    // both schedule the same row; only a PENDING row is ever dispatched.
    if (delivery.status !== WebhookDeliveryStatus.PENDING) {
      this.logger.warn(
        `Delivery ${deliveryId} is ${delivery.status}, not PENDING; skipping`,
      );
      return;
    }

    // If the endpoint was disabled or deleted between scheduling and
    // execution, stop the chain without sending.
    if (delivery.webhook.status !== "ACTIVE") {
      await this.deadLetter(deliveryId, DeadLetterReason.ENDPOINT_DISABLED, {
        failureReason: "webhook endpoint disabled before delivery",
      });
      return;
    }

    // Respect the configured threshold even for rows created under a higher
    // one (e.g. after WEBHOOK_MAX_DELIVERY_ATTEMPTS was lowered).
    if (delivery.attempt > this.maxAttempts) {
      await this.deadLetter(
        deliveryId,
        DeadLetterReason.MAX_ATTEMPTS_EXHAUSTED,
        { failureReason: "retry threshold reached before dispatch" },
      );
      return;
    }

    const url = delivery.webhook.url;

    // Decrypt signing secret — never stored in plain text or in delivery logs.
    let signingSecret: string;
    try {
      signingSecret = this.paymentEncryptionKeyring.decrypt(secretEncrypted);
    } catch (err) {
      this.logger.error(
        `Failed to decrypt signing secret for webhook ${delivery.webhook.id}: ${String(err)}`,
      );
      await this.deadLetter(
        deliveryId,
        DeadLetterReason.SIGNING_SECRET_UNAVAILABLE,
        { failureReason: "signing secret decryption failure" },
      );
      return;
    }

    // The persisted bytes are exactly what was serialized when the event
    // occurred. Every attempt signs and sends these bytes, never a
    // re-serialization of `payload`.
    const body = delivery.payloadBody ?? JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);

    const signature = this.signing.sign(
      signingSecret,
      timestamp,
      delivery.eventId,
      signedKeyId,
      body,
    );

    const schemaVersion = delivery.schemaVersion ?? "1";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-EarnProof-Timestamp": String(timestamp),
      "X-EarnProof-Delivery": delivery.eventId,
      "X-EarnProof-Event": delivery.eventType,
      "X-EarnProof-Schema-Version": schemaVersion,
      "X-EarnProof-Signature": signature,
    };
    // Deprecation is announced in delivery metadata, never in the body: the
    // body is the contract under discussion (docs/versioning.md).
    const deprecation = payloadDeprecation(
      delivery.eventType,
      schemaVersion,
    );
    if (deprecation) {
      headers["Deprecation"] = "true";
      headers["Sunset"] = new Date(deprecation.sunsetAt).toUTCString();
    }

    let statusCode: number | undefined;
    let responseBody: Prisma.InputJsonValue | undefined;
    let durationMs: number | undefined;
    let success = false;
    let failureReason: string | undefined;

    const start = Date.now();
    try {
      let dispatcher: Dispatcher | undefined;
      if (delivery.webhook.mtlsRequired) {
        const certPair = await this.clientCertificates.selectActiveCertificate(
          delivery.webhook.id,
        );
        if (!certPair) {
          throw new MtlsCertificateUnavailableError();
        }
        // Never falls back to a plain connection: this dispatcher is only
        // used when a currently-valid certificate was found above.
        dispatcher = new Agent({
          connect: { cert: certPair.certificatePem, key: certPair.privateKeyPem },
        });
      }

      await assertSafeWebhookDestination(url);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        // Do NOT follow redirects — prevents an open redirect from
        // forwarding a signed payload to an internal address.
        redirect: "error",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
      });

      durationMs = Date.now() - start;
      statusCode = response.status;

      // Process response body: normalize encoding, redact secrets, compute hash, truncate.
      const safeResponse = processWebhookResponse(await response.text());
      responseBody = safeResponse as unknown as Prisma.InputJsonValue;

      success = response.ok;
      if (!success) {
        failureReason = `HTTP ${response.status}`;
      }
    } catch (err) {
      durationMs = Date.now() - start;
      if (err instanceof SsrfBlockedError) {
        failureReason = err.message;
        // SSRF block is permanent — do not retry.
        await this.deadLetter(deliveryId, DeadLetterReason.DESTINATION_BLOCKED, {
          durationMs,
          failureReason,
          deliveredAt: new Date(),
        });

        // Don't record SSRF blocks in circuit breaker (permanent policy failure)
        this.logger.warn(`Delivery ${deliveryId} blocked by SSRF guard: ${failureReason}`);
        return;
      }
      if (err instanceof MtlsCertificateUnavailableError) {
        // Transient from the delivery's point of view: a certificate added
        // before the next retry would let it succeed, so this follows the
        // normal retry/backoff path rather than failing permanently.
        failureReason = err.message;
      } else {
        failureReason =
          err instanceof Error && err.name === "TimeoutError"
            ? "delivery request timed out"
            : "delivery request failed";
      }
    }

    if (success) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.SUCCESS,
          statusCode,
          // Redact secrets: responseBody is from the integrator, safe to store.
          responseBody,
          durationMs,
          deliveredAt: new Date(),
          signedKeyId,
        },
      });

      // Record success in circuit breaker
      await this.circuitBreaker.recordSuccess(delivery.webhookId);

      this.logger.log(
        `Delivery ${deliveryId} succeeded (attempt ${delivery.attempt}, keyId=${signedKeyId}, ${durationMs}ms, HTTP ${statusCode})`,
      );
      return;
    }

    // Failed attempt — the retry threshold decides whether the chain ends.
    if (delivery.attempt >= this.maxAttempts) {
      await this.deadLetter(deliveryId, DeadLetterReason.MAX_ATTEMPTS_EXHAUSTED, {
        statusCode,
        responseBody,
        durationMs,
        failureReason,
        deliveredAt: new Date(),
      });

      // Record failure in circuit breaker (not permanent for normal failures)
      await this.circuitBreaker.recordFailure(delivery.webhookId, false);

      this.logger.warn(
        `Delivery ${deliveryId} dead-lettered after ${delivery.attempt} attempt(s): ${failureReason}`,
      );
      return;
    }

    // Create a new delivery row for the retry (preserves the original row's
    // first-attempt record and makes each attempt queryable individually).
    const nextAttempt = delivery.attempt + 1;
    const delay = backoffMs(nextAttempt);
    const nextRetryAt = new Date(Date.now() + delay);

    // Update current row to reflect it failed but a retry is scheduled.
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: WebhookDeliveryStatus.FAILED,
        statusCode,
        responseBody,
        durationMs,
        failureReason,
        deliveredAt: new Date(),
        signedKeyId,
      },
    });

    const retryDelivery = await this.prisma.webhookDelivery.create({
      data: {
        webhookId: delivery.webhookId,
        eventType: delivery.eventType,
        payload: delivery.payload as Prisma.InputJsonValue,
        schemaVersion: delivery.schemaVersion, // original version
        payloadBody: delivery.payloadBody, // original bytes
        eventId: delivery.eventId, // same eventId across all retries
        attempt: nextAttempt,
        status: WebhookDeliveryStatus.PENDING,
        replayOf: delivery.replayOf, // carry through if this is a replay
        signedKeyId, // preserve the key version for the retry
        nextRetryAt,
      },
      select: { id: true },
    });

    this.logger.log(
      `Delivery ${deliveryId} failed (attempt ${delivery.attempt}, keyId=${signedKeyId}); retrying as ${retryDelivery.id} in ${delay}ms`,
    );

    // Record failure in circuit breaker for retryable failures
    await this.circuitBreaker.recordFailure(delivery.webhookId, false);

    if (holdAggregateQueue) {
      // Keep the production queue occupied through the retry so later events
      // cannot silently overtake an earlier event for the same aggregate.
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      await this.runDelivery(retryDelivery.id, true);
    } else {
      this.scheduleDelivery(retryDelivery.id, delivery.webhookId, delay);
    }
  }

  /**
   * Terminal failure: the chain stops here and the attempt is marked
   * dead-lettered so an operator can inspect and, if appropriate, redrive it.
   */
  private async deadLetter(
    deliveryId: string,
    reason: DeadLetterReasonValue,
    attempt: {
      statusCode?: number;
      responseBody?: string;
      durationMs?: number;
      failureReason: string | undefined;
      deliveredAt?: Date;
    },
  ): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: WebhookDeliveryStatus.FAILED,
        ...attempt,
        deadLetteredAt: new Date(),
        deadLetterReason: reason,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Synthetic test delivery
  // ---------------------------------------------------------------------------

  /**
   * Send one synthetic, signed `webhook.test` event to an endpoint and report
   * what happened.
   *
   * Uses exactly the same signing, destination guard, redirect policy, timeout,
   * and response redaction/size limits as a real delivery
   * ({@link sendSignedRequest}), so a passing test means a real event would
   * reach the receiver the same way.
   *
   * It is deliberately NOT a delivery: no `WebhookDelivery` row is written, the
   * per-endpoint FIFO chain is not touched, and a failure is never retried. A
   * synthetic event must never be picked up by startup recovery or the retry
   * path, and must never sit in a business queue ahead of a real event.
   *
   * The caller is responsible for authorization and ownership.
   */
  async sendTestDelivery(webhook: {
    id: string;
    url: string;
    secretEncrypted: string;
  }): Promise<WebhookTestDeliveryResult> {
    const eventId = `${WEBHOOK_TEST_EVENT_ID_PREFIX}${randomUUID()}`;
    const envelope: WebhookTestEnvelope = {
      specVersion: "1",
      id: eventId,
      event: WEBHOOK_TEST_EVENT_TYPE,
      synthetic: true,
      createdAt: new Date().toISOString(),
      data: {
        synthetic: true,
        testEventVersion: WEBHOOK_TEST_EVENT_VERSION,
        webhookId: webhook.id,
        message:
          "Synthetic EarnProof test event. Not a business event; acknowledge and ignore.",
      },
    };

    const base = {
      webhookId: webhook.id,
      eventId,
      eventType: WEBHOOK_TEST_EVENT_TYPE,
      synthetic: true as const,
      testEventVersion: WEBHOOK_TEST_EVENT_VERSION,
      sentAt: envelope.createdAt,
    };

    let signingSecret: string;
    try {
      signingSecret = this.paymentEncryptionKeyring.decrypt(webhook.secretEncrypted);
    } catch (err) {
      this.logger.error(
        `Failed to decrypt signing secret for webhook ${webhook.id}: ${String(err)}`,
      );
      return {
        ...base,
        delivered: false,
        statusClass: "signing_error",
        statusCode: null,
        durationMs: 0,
        failureReason: "signing secret decryption failure",
        response: { body: null, truncated: false, maxBytes: MAX_RESPONSE_BODY_BYTES },
      };
    }

    const outcome = await this.sendSignedRequest(
      webhook.url,
      signingSecret,
      eventId,
      WEBHOOK_TEST_EVENT_TYPE,
      envelope,
    );

    return {
      ...base,
      delivered: outcome.success,
      statusClass: statusClassOf(outcome),
      statusCode: outcome.statusCode ?? null,
      durationMs: outcome.durationMs,
      // The SSRF guard's own message can name the resolved internal address;
      // echoing it to the caller would turn this endpoint into a network probe.
      failureReason:
        outcome.kind === "blocked"
          ? "destination rejected by outbound destination policy"
          : (outcome.failureReason ?? null),
      response: {
        body: outcome.responseBody ?? null,
        truncated: outcome.responseTruncated,
        maxBytes: MAX_RESPONSE_BODY_BYTES,
      },
    };
  }

  /**
   * The production send path: sign, check the destination, POST without
   * following redirects under the delivery timeout, and bound + redact the
   * response body. Never throws; never writes to the database.
   */
  private async sendSignedRequest(
    url: string,
    signingSecret: string,
    eventId: string,
    eventType: string,
    envelope: WebhookEnvelope | WebhookTestEnvelope,
  ): Promise<SignedRequestOutcome> {
    const body = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000);

    const signature = this.signing.sign(signingSecret, timestamp, eventId, body);

    const start = Date.now();
    try {
      await assertSafeWebhookDestination(url);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-EarnProof-Timestamp": String(timestamp),
          "X-EarnProof-Delivery": eventId,
          "X-EarnProof-Event": eventType,
          "X-EarnProof-Signature": signature,
        },
        body,
        // Do NOT follow redirects — prevents an open redirect from
        // forwarding a signed payload to an internal address.
        redirect: "error",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      const durationMs = Date.now() - start;

      // Truncate response body to prevent large payloads in logs.
      const bounded = boundResponseBody(await response.text());

      return {
        kind: "response",
        success: response.ok,
        statusCode: response.status,
        responseBody: bounded.body,
        responseTruncated: bounded.truncated,
        durationMs,
        failureReason: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      if (err instanceof SsrfBlockedError) {
        return {
          kind: "blocked",
          error: err,
          success: false,
          responseTruncated: false,
          durationMs,
        };
      }
      if (err instanceof Error && err.name === "TimeoutError") {
        return {
          kind: "timeout",
          success: false,
          responseTruncated: false,
          durationMs,
          failureReason: "delivery request timed out",
        };
      }
      return {
        kind: isRedirectError(err) ? "redirect" : "network_error",
        success: false,
        responseTruncated: false,
        durationMs,
        failureReason: "delivery request failed",
      };
    }
  }

  private parseEvents(events: unknown): WebhookEventType[] {
    if (Array.isArray(events)) {
      return events.filter((e): e is WebhookEventType => typeof e === "string");
    }
    return [];
  }
}

/**
 * Result of one pass through the production send path.
 *
 * `kind` separates outcomes a caller may want to distinguish (the stored
 * `failureReason` strings for real deliveries are unchanged by it).
 */
type SignedRequestOutcome =
  | {
      kind: "response";
      success: boolean;
      statusCode: number;
      responseBody: string;
      responseTruncated: boolean;
      durationMs: number;
      failureReason?: string;
    }
  | {
      kind: "blocked";
      error: SsrfBlockedError;
      success: false;
      statusCode?: undefined;
      responseBody?: undefined;
      responseTruncated: false;
      durationMs: number;
      failureReason?: undefined;
    }
  | {
      kind: "timeout" | "redirect" | "network_error";
      success: false;
      statusCode?: undefined;
      responseBody?: undefined;
      responseTruncated: false;
      durationMs: number;
      failureReason: string;
    };

/**
 * Coarse outcome of a test delivery.
 *
 * - `2xx`…`5xx`: the receiver answered with that status class.
 * - `timeout`: no answer within the delivery timeout.
 * - `redirect_rejected`: the receiver answered with a redirect, which is never
 *   followed for a signed payload.
 * - `destination_rejected`: the outbound destination policy refused the URL.
 * - `network_error`: connection, TLS, or DNS failure.
 * - `signing_error`: the endpoint's signing secret could not be decrypted.
 */
export const WEBHOOK_TEST_STATUS_CLASSES = [
  "1xx",
  "2xx",
  "3xx",
  "4xx",
  "5xx",
  "timeout",
  "redirect_rejected",
  "destination_rejected",
  "network_error",
  "signing_error",
] as const;

export type WebhookTestStatusClass = (typeof WEBHOOK_TEST_STATUS_CLASSES)[number];

/** Diagnostic result of a synthetic test delivery. Contains no secrets. */
export interface WebhookTestDeliveryResult {
  webhookId: string;
  eventId: string;
  eventType: typeof WEBHOOK_TEST_EVENT_TYPE;
  synthetic: true;
  testEventVersion: typeof WEBHOOK_TEST_EVENT_VERSION;
  sentAt: string;
  delivered: boolean;
  statusClass: WebhookTestStatusClass;
  statusCode: number | null;
  durationMs: number;
  failureReason: string | null;
  response: {
    /** Redacted receiver body, bounded to `maxBytes` (plus a truncation marker). */
    body: string | null;
    truncated: boolean;
    maxBytes: number;
  };
}

function statusClassOf(outcome: SignedRequestOutcome): WebhookTestStatusClass {
  switch (outcome.kind) {
    case "response":
      return `${Math.min(5, Math.max(1, Math.floor(outcome.statusCode / 100)))}xx` as WebhookTestStatusClass;
    case "blocked":
      return "destination_rejected";
    case "timeout":
      return "timeout";
    case "redirect":
      return "redirect_rejected";
    default:
      return "network_error";
  }
}

/**
 * With `redirect: "error"`, fetch (undici) rejects a 3xx answer with a
 * `TypeError` whose cause mentions the redirect.
 */
function isRedirectError(err: unknown): boolean {
  // Duck-typed rather than `instanceof Error`: fetch's errors can come from a
  // different realm than this module's `Error`.
  const messageOf = (value: unknown): string =>
    typeof value === "object" && value !== null && "message" in value
      ? String((value as { message: unknown }).message)
      : "";
  const cause = (err as { cause?: unknown } | null)?.cause;
  return /redirect/i.test(`${messageOf(err)} ${messageOf(cause)}`);
}

/**
 * Redact and bound a receiver response body — the single place the stored
 * `responseBody` of a real delivery and the diagnostics of a test delivery are
 * produced, so both obey the same limits.
 */
export function boundResponseBody(raw: string): { body: string; truncated: boolean } {
  const redacted = redactSensitiveResponse(raw);
  if (redacted.length > MAX_RESPONSE_BODY_BYTES) {
    return {
      body: redacted.slice(0, MAX_RESPONSE_BODY_BYTES) + "…[truncated]",
      truncated: true,
    };
  }
  return { body: redacted, truncated: false };
}

function redactSensitiveResponse(value: string): string {
  return value
    .replace(
      /(["']?(?:authorization|password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,}]*/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}
