import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { DomainEventStatus, Prisma } from "@prisma/client";
import { STELLAR_SECRET_SEED_PATTERN } from "../../stellar/stellar-network";
import {
  CreateDomainEventInput,
  DomainEvent,
  DomainEventHandler,
  ProcessOutcome,
} from "./domain-event.types";

export const DEFAULT_OUTBOX_LEASE_MS = 30_000;
export const DEFAULT_MAX_OUTBOX_ATTEMPTS = 5;

type PrismaTransactionalClient = Prisma.TransactionClient | PrismaService;

@Injectable()
export class DomainEventOutboxService {
  private readonly logger = new Logger(DomainEventOutboxService.name);
  private readonly consumers = new Map<string, DomainEventHandler[]>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registers a consumer for a specific event type.
   */
  registerConsumer(eventType: string, handler: DomainEventHandler): void {
    const list = this.consumers.get(eventType) ?? [];
    list.push(handler);
    this.consumers.set(eventType, list);
  }

  /**
   * Redacts sensitive secrets, private keys, or Stellar seeds from payload objects.
   */
  redactPayload<T>(payload: T): T {
    if (payload === null || payload === undefined) {
      return payload;
    }
    if (typeof payload === "string") {
      return payload.replace(
        STELLAR_SECRET_SEED_PATTERN,
        "[REDACTED_SECRET_KEY]",
      ) as unknown as T;
    }
    if (typeof payload !== "object") {
      return payload;
    }
    if (Array.isArray(payload)) {
      return payload.map((item) => this.redactPayload(item)) as unknown as T;
    }

    const sensitiveKeyPatterns = [
      /secret/i,
      /token/i,
      /password/i,
      /apiKey/i,
      /private/i,
      /seed/i,
      /signingKey/i,
    ];

    const cleaned: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(payload as Record<string, unknown>)) {
      const isSensitiveKey = sensitiveKeyPatterns.some((pattern) =>
        pattern.test(key),
      );
      if (isSensitiveKey) {
        cleaned[key] = "[REDACTED]";
      } else {
        cleaned[key] = this.redactPayload(val);
      }
    }
    return cleaned as T;
  }

  /**
   * Persists a versioned domain event in the transactional outbox.
   * MUST be executed inside the same transaction `tx` as source mutations.
   * If the transaction rolls back, the event is also rolled back.
   */
  async publish<T extends Record<string, unknown>>(
    tx: PrismaTransactionalClient,
    input: CreateDomainEventInput<T>,
  ): Promise<DomainEvent<T>> {
    const safePayload = this.redactPayload(input.payload);

    const client = (tx as any).domainEventOutbox ? tx : this.prisma;

    const row = await client.domainEventOutbox.create({
      data: {
        organizationId: input.organizationId,
        eventType: input.eventType,
        eventVersion: input.eventVersion ?? 1,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null,
        payload: safePayload as any,
        status: DomainEventStatus.PENDING,
        maxAttempts: input.maxAttempts ?? DEFAULT_MAX_OUTBOX_ATTEMPTS,
        attempts: 0,
      },
    });

    return row as unknown as DomainEvent<T>;
  }

  /**
   * Claims a batch of pending or expired-lease outbox events under a lease.
   * Guarantees strictly ordered delivery: ordered by createdAt ASC, id ASC.
   */
  async claimBatch(
    owner: string,
    batchSize = 10,
    leaseDurationMs = DEFAULT_OUTBOX_LEASE_MS,
  ): Promise<DomainEvent[]> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    // Reclaim expired leases first
    await this.releaseExpiredLeases(now);

    const candidates = await this.prisma.domainEventOutbox.findMany({
      where: {
        status: DomainEventStatus.PENDING,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: batchSize,
    });

    if (candidates.length === 0) {
      return [];
    }

    const claimed: DomainEvent[] = [];
    for (const item of candidates) {
      const res = await this.prisma.domainEventOutbox.updateMany({
        where: {
          id: item.id,
          status: DomainEventStatus.PENDING,
        },
        data: {
          status: DomainEventStatus.LEASED,
          leaseOwner: owner,
          leaseExpiresAt,
          updatedAt: now,
        },
      });

      if (res.count > 0) {
        claimed.push({
          ...(item as any),
          status: DomainEventStatus.LEASED,
          leaseOwner: owner,
          leaseExpiresAt,
        });
      }
    }

    return claimed;
  }

  /**
   * Crash recovery: releases events with expired leases back to PENDING.
   */
  async releaseExpiredLeases(now = new Date()): Promise<number> {
    const res = await this.prisma.domainEventOutbox.updateMany({
      where: {
        status: DomainEventStatus.LEASED,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: DomainEventStatus.PENDING,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      },
    });
    return res.count;
  }

  /**
   * Processes a single event against a consumer handler with duplicate delivery prevention.
   * Idempotent: if (eventId, consumerName) was already processed, handler side effects are not repeated.
   */
  async processEventWithConsumer(
    event: DomainEvent,
    handler: DomainEventHandler,
  ): Promise<ProcessOutcome> {
    const existing = await this.prisma.domainEventConsumerRecord.findUnique({
      where: {
        eventId_consumerName: {
          eventId: event.id,
          consumerName: handler.consumerName,
        },
      },
    });

    if (existing) {
      return {
        outcome: "duplicate_skipped",
        eventId: event.id,
        consumerName: handler.consumerName,
      };
    }

    try {
      await handler.handle(event);

      // Record consumer deduplication record
      await this.prisma.domainEventConsumerRecord.create({
        data: {
          eventId: event.id,
          consumerName: handler.consumerName,
          processedAt: new Date(),
        },
      });

      // Update event status to PROCESSED
      await this.prisma.domainEventOutbox.update({
        where: { id: event.id },
        data: {
          status: DomainEventStatus.PROCESSED,
          processedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        },
      });

      return {
        outcome: "processed",
        eventId: event.id,
        consumerName: handler.consumerName,
      };
    } catch (err: any) {
      const errorMsg =
        typeof err?.message === "string" ? err.message : String(err);
      const safeError = this.redactPayload(errorMsg);

      const nextAttempts = event.attempts + 1;
      const isPoison = nextAttempts >= event.maxAttempts;

      await this.prisma.domainEventOutbox.update({
        where: { id: event.id },
        data: {
          status: isPoison
            ? DomainEventStatus.QUARANTINED
            : DomainEventStatus.PENDING,
          attempts: nextAttempts,
          lastError: safeError,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        },
      });

      if (isPoison) {
        return {
          outcome: "quarantined",
          eventId: event.id,
          attempts: nextAttempts,
          error: safeError,
        };
      }

      return {
        outcome: "failed_retryable",
        eventId: event.id,
        attempts: nextAttempts,
        error: safeError,
      };
    }
  }

  /**
   * Drives delivery of a claimed batch across all registered consumers.
   */
  async processBatch(owner: string, batchSize = 10): Promise<ProcessOutcome[]> {
    const events = await this.claimBatch(owner, batchSize);
    const outcomes: ProcessOutcome[] = [];

    for (const event of events) {
      const handlers = this.consumers.get(event.eventType) ?? [];
      if (handlers.length === 0) {
        // No handlers registered yet: mark PROCESSED so outbox does not clog
        await this.prisma.domainEventOutbox.update({
          where: { id: event.id },
          data: {
            status: DomainEventStatus.PROCESSED,
            processedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        outcomes.push({
          outcome: "processed",
          eventId: event.id,
          consumerName: "noop",
        });
        continue;
      }

      for (const handler of handlers) {
        const result = await this.processEventWithConsumer(event, handler);
        outcomes.push(result);
      }
    }

    return outcomes;
  }

  /**
   * Retention cleanup for outbox: removes PROCESSED and QUARANTINED records older than cutoff.
   */
  async sweepProcessed(retentionCutoff: Date): Promise<number> {
    const res = await this.prisma.domainEventOutbox.deleteMany({
      where: {
        status: {
          in: [DomainEventStatus.PROCESSED, DomainEventStatus.QUARANTINED],
        },
        updatedAt: { lte: retentionCutoff },
      },
    });
    return res.count;
  }
}
