import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  ResourceStatus,
  WebhookDeliveryStatus,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { DeadLetterState } from "./dto/dead-letter.dto";
import { WebhookDeliveryService } from "./webhook-delivery.service";

const DEFAULT_MAX_BATCH = 25;
const DEFAULT_PAGE_SIZE = 50;

/** Outcome of redriving one dead letter. Stable codes for operators. */
export type RedriveOutcome =
  | "redriven"
  | "already_redriven"
  | "not_found"
  | "not_dead_lettered"
  | "webhook_disabled"
  | "webhook_deleted";

export interface RedriveResult {
  deliveryId: string;
  outcome: RedriveOutcome;
  redriveDeliveryId?: string;
}

/** The redrive key: at most one redrive delivery per dead letter, ever. */
export const redriveKey = (deadLetterId: string) => `redrive:${deadLetterId}`;

/** Raised inside the transaction to roll the claim back. */
class WebhookNotRedrivable extends Error {
  constructor(readonly outcome: "webhook_disabled" | "webhook_deleted") {
    super(outcome);
  }
}

/** Fields safe to show an operator. No payload, URL, secret, or body. */
const ATTEMPT_SELECT = {
  id: true,
  attempt: true,
  status: true,
  statusCode: true,
  failureReason: true,
  durationMs: true,
  deliveredAt: true,
  deadLetteredAt: true,
  deadLetterReason: true,
  replayOf: true,
  createdAt: true,
} satisfies Prisma.WebhookDeliverySelect;

/**
 * Dead-letter inspection and controlled redrive (#159).
 *
 * A dead letter is the terminal attempt of a delivery chain that ended without
 * success (see `DeadLetterReason`). Redrive never mutates or re-sends that row:
 * it creates a new PENDING delivery that carries the original event id,
 * schema version, and payload bytes, and starts a fresh retry chain.
 *
 * Every read and write is scoped to the caller's organisation through the
 * webhook relation; a delivery belonging to another organisation is reported
 * as not found, never as forbidden, so its existence is not disclosed.
 *
 * Concurrency: the redrive claim is a conditional UPDATE on the dead letter
 * (`redrivenAt IS NULL`), and the new row carries a unique `replayKey`. Two
 * concurrent redrives of the same dead letter produce exactly one delivery;
 * the loser observes `already_redriven` and the same redrive delivery id.
 */
@Injectable()
export class WebhookDeadLetterService {
  private readonly logger = new Logger(WebhookDeadLetterService.name);
  private readonly maxBatch: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryService: WebhookDeliveryService,
    configService: ConfigService,
  ) {
    this.maxBatch =
      configService.get<number>("webhooks.maxRedriveBatchSize") ??
      DEFAULT_MAX_BATCH;
  }

  get maxBatchSize(): number {
    return this.maxBatch;
  }

  async list(
    organizationId: string,
    query: {
      webhookId?: string;
      state?: DeadLetterState;
      limit?: number;
      cursor?: string;
    },
  ) {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const state = query.state ?? "pending";
    const where: Prisma.WebhookDeliveryWhereInput = {
      deadLetteredAt: { not: null },
      webhook: { organizationId },
      ...(query.webhookId ? { webhookId: query.webhookId } : undefined),
      ...(state === "pending"
        ? { redrivenAt: null }
        : state === "redriven"
          ? { redrivenAt: { not: null } }
          : undefined),
    };

    if (query.cursor) {
      const cursor = await this.prisma.webhookDelivery.findFirst({
        where: { ...where, id: query.cursor },
        select: { id: true },
      });
      if (!cursor) throw new BadRequestException("Invalid cursor");
    }

    const rows = await this.prisma.webhookDelivery.findMany({
      where,
      orderBy: [{ deadLetteredAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : undefined),
      select: {
        ...ATTEMPT_SELECT,
        webhookId: true,
        eventId: true,
        eventType: true,
        schemaVersion: true,
        redrivenAt: true,
        redrivenBy: true,
        webhook: { select: { status: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      data: page.map(({ webhook, ...row }) => ({
        ...row,
        webhookStatus: webhook.status,
        redrivable:
          row.redrivenAt === null && webhook.status === ResourceStatus.ACTIVE,
      })),
      pageInfo: {
        hasMore,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      },
    };
  }

  /** One dead letter with the full attempt history of its event. */
  async get(organizationId: string, deliveryId: string) {
    const deadLetter = await this.findScoped(organizationId, deliveryId);
    if (!deadLetter?.deadLetteredAt) {
      throw new NotFoundException("Dead-lettered delivery not found");
    }

    const [history, redrive] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where: { webhookId: deadLetter.webhookId, eventId: deadLetter.eventId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: ATTEMPT_SELECT,
      }),
      this.prisma.webhookDelivery.findUnique({
        where: { replayKey: redriveKey(deadLetter.id) },
        select: { id: true, status: true, redriveReason: true, createdAt: true },
      }),
    ]);

    return {
      id: deadLetter.id,
      webhookId: deadLetter.webhookId,
      webhookStatus: deadLetter.webhook.status,
      eventId: deadLetter.eventId,
      eventType: deadLetter.eventType,
      schemaVersion: deadLetter.schemaVersion,
      attempt: deadLetter.attempt,
      deadLetteredAt: deadLetter.deadLetteredAt,
      deadLetterReason: deadLetter.deadLetterReason,
      redrivenAt: deadLetter.redrivenAt,
      redrivenBy: deadLetter.redrivenBy,
      redrive,
      history,
    };
  }

  /** Redrive one dead letter. Idempotent per dead letter. */
  async redrive(
    organizationId: string,
    deliveryId: string,
    operatorId: string,
    reason: string,
  ): Promise<RedriveResult> {
    const deadLetter = await this.findScoped(organizationId, deliveryId);
    if (!deadLetter) return { deliveryId, outcome: "not_found" };
    if (!deadLetter.deadLetteredAt) {
      return { deliveryId, outcome: "not_dead_lettered" };
    }
    if (deadLetter.redrivenAt) return this.alreadyRedriven(deliveryId);

    const blocked = this.webhookBlock(deadLetter.webhook.status);
    if (blocked) return { deliveryId, outcome: blocked };

    let created: { id: string } | null;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // Claim: only one caller can move redrivenAt from NULL.
        const claim = await tx.webhookDelivery.updateMany({
          where: {
            id: deadLetter.id,
            deadLetteredAt: { not: null },
            redrivenAt: null,
          },
          data: { redrivenAt: new Date(), redrivenBy: operatorId },
        });
        if (claim.count !== 1) return null;

        // Re-read the endpoint inside the transaction: a disable or delete
        // that landed after the first check rolls the claim back.
        const hook = await tx.webhook.findUnique({
          where: { id: deadLetter.webhookId },
          select: { status: true },
        });
        const late = hook ? this.webhookBlock(hook.status) : "webhook_deleted";
        if (late) throw new WebhookNotRedrivable(late);

        const row = await tx.webhookDelivery.create({
          data: {
            webhookId: deadLetter.webhookId,
            eventType: deadLetter.eventType,
            // Same event identity, version, and bytes as the original.
            eventId: deadLetter.eventId,
            payload: deadLetter.payload as Prisma.InputJsonValue,
            schemaVersion: deadLetter.schemaVersion,
            payloadBody: deadLetter.payloadBody,
            attempt: 1,
            status: WebhookDeliveryStatus.PENDING,
            replayOf: deadLetter.id,
            replayedBy: operatorId,
            replayKey: redriveKey(deadLetter.id),
            redriveReason: reason,
          },
          select: { id: true },
        });

        await tx.auditLog.create({
          data: {
            actorType: "user",
            actorId: operatorId,
            action: "webhook.delivery.redriven",
            resourceType: "webhookDelivery",
            resourceId: deadLetter.id,
            metadata: {
              organizationId,
              webhookId: deadLetter.webhookId,
              eventId: deadLetter.eventId,
              eventType: deadLetter.eventType,
              deadLetterReason: deadLetter.deadLetterReason,
              redriveDeliveryId: row.id,
              reason,
            },
          },
        });

        return row;
      });
    } catch (error) {
      if (error instanceof WebhookNotRedrivable) {
        return { deliveryId, outcome: error.outcome };
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return this.alreadyRedriven(deliveryId);
      }
      throw error;
    }

    if (!created) return this.alreadyRedriven(deliveryId);

    // Dispatch only after commit, so the worker can see the row.
    this.deliveryService.dispatch(created.id, deadLetter.webhookId);
    this.logger.log(
      `Dead letter ${deliveryId} redriven as ${created.id} by ${operatorId}`,
    );
    return { deliveryId, outcome: "redriven", redriveDeliveryId: created.id };
  }

  /**
   * Redrive a bounded batch. Each item is independent: one failing or
   * already-redriven item does not affect the others.
   */
  async redriveBatch(
    organizationId: string,
    deliveryIds: string[],
    operatorId: string,
    reason: string,
  ) {
    const unique = [...new Set(deliveryIds)];
    if (unique.length > this.maxBatch) {
      throw new BadRequestException(
        `A redrive batch may contain at most ${this.maxBatch} deliveries`,
      );
    }

    const results: RedriveResult[] = [];
    for (const id of unique) {
      results.push(await this.redrive(organizationId, id, operatorId, reason));
    }

    return {
      requested: unique.length,
      redriven: results.filter((r) => r.outcome === "redriven").length,
      results,
    };
  }

  private async findScoped(organizationId: string, deliveryId: string) {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        webhook: { select: { organizationId: true, status: true } },
      },
    });
    // Another organisation's delivery is indistinguishable from none.
    if (!delivery || delivery.webhook.organizationId !== organizationId) {
      return null;
    }
    return delivery;
  }

  private webhookBlock(
    status: ResourceStatus,
  ): "webhook_disabled" | "webhook_deleted" | null {
    if (status === ResourceStatus.DELETED) return "webhook_deleted";
    if (status !== ResourceStatus.ACTIVE) return "webhook_disabled";
    return null;
  }

  private async alreadyRedriven(deliveryId: string): Promise<RedriveResult> {
    const existing = await this.prisma.webhookDelivery.findUnique({
      where: { replayKey: redriveKey(deliveryId) },
      select: { id: true },
    });
    return {
      deliveryId,
      outcome: "already_redriven",
      ...(existing ? { redriveDeliveryId: existing.id } : undefined),
    };
  }
}
