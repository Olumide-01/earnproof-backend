import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { AuditLegalHold, AuditLegalHoldStatus, Prisma } from "@prisma/client";
import { AuthenticatedUser } from "../../auth/auth.types";
import { Clock, SystemClock } from "../../common/time/clock";
import { PrismaService } from "../../database/prisma.service";
import {
  AuditLegalHoldTransitionDto,
  CreateAuditLegalHoldDto,
  ListAuditLegalHoldsDto,
} from "./dto/audit-legal-hold.dto";
import {
  holdsInEffectWhere,
  isHoldInEffect,
  MAX_HOLDS_IN_EFFECT,
} from "./legal-hold-scope";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Longest a single hold may last. Renewal is a new, separately approved hold. */
export const MAX_HOLD_DAYS = 730;
/** Widest createdAt range one hold may cover. */
export const MAX_HOLD_RANGE_DAYS = 3_650;
/** How long a requested hold protects records while it awaits approval. */
export const HOLD_APPROVAL_WINDOW_MS = 72 * 60 * 60 * 1_000;

const DEFAULT_LIST_LIMIT = 50;

export interface AuditLegalHoldView extends AuditLegalHold {
  /** Whether the hold protects records at the time of the response. */
  inEffect: boolean;
}

type AuditAction =
  | "requested"
  | "approved"
  | "rejected"
  | "release_requested"
  | "released";

/**
 * Audit retention legal holds (#311).
 *
 * Lifecycle: PENDING_APPROVAL -> ACTIVE -> RELEASE_PENDING -> RELEASED, or
 * PENDING_APPROVAL -> REJECTED. Every transition needs a second administrator:
 * the requester cannot approve or reject their own hold, and whoever asks for
 * a release cannot also approve it. Holds are never deleted.
 *
 * Every transition names the revision it was based on and is applied with a
 * conditional `updateMany` on (id, status, revision), so a concurrent or
 * replayed decision is rejected with 409 instead of being applied twice.
 *
 * Checks run in a fixed order, so the same request always gets the same
 * answer: 404 unknown hold -> 409 stale revision -> 409 wrong status ->
 * 403 not independent -> 409 deadline or expiry passed.
 */
@Injectable()
export class AuditLegalHoldService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly clock: Clock = new SystemClock(),
  ) {}

  async request(
    user: AuthenticatedUser,
    dto: CreateAuditLegalHoldDto,
  ): Promise<AuditLegalHoldView> {
    const now = this.clock.now();
    await this.validateRequest(dto, now);

    const inEffect = await this.prisma.auditLegalHold.count({
      where: holdsInEffectWhere(now),
    });
    if (inEffect >= MAX_HOLDS_IN_EFFECT) {
      throw new ConflictException(
        `At most ${MAX_HOLDS_IN_EFFECT} legal holds may be in effect; release or let one expire first.`,
      );
    }

    const approvalDeadline = new Date(
      Math.min(now.getTime() + HOLD_APPROVAL_WINDOW_MS, dto.expiresAt.getTime()),
    );

    const hold = await this.prisma.auditLegalHold.create({
      data: {
        scope: dto.scope,
        organizationId: dto.scope === "ORGANIZATION" ? dto.organizationId! : null,
        authority: dto.authority,
        reasonCommitment: dto.reasonCommitment,
        rangeStart: dto.rangeStart,
        rangeEnd: dto.rangeEnd,
        expiresAt: dto.expiresAt,
        approvalDeadline,
        requestedById: user.id,
      },
    });

    await this.audit(user, "requested", hold);
    return this.view(hold, now);
  }

  approve(user: AuthenticatedUser, id: string, dto: AuditLegalHoldTransitionDto) {
    return this.transition(user, id, dto, "PENDING_APPROVAL", "approved", (hold, now) => {
      if (hold.requestedById === user.id) {
        throw new ForbiddenException("A legal hold cannot be approved by its requester.");
      }
      if (!isHoldInEffect(hold, now)) {
        throw new ConflictException(
          "The hold's approval deadline or expiry has passed; request a new hold.",
        );
      }
      return { status: "ACTIVE", approvedById: user.id, approvedAt: now };
    });
  }

  reject(user: AuthenticatedUser, id: string, dto: AuditLegalHoldTransitionDto) {
    return this.transition(user, id, dto, "PENDING_APPROVAL", "rejected", (hold, now) => {
      if (hold.requestedById === user.id) {
        throw new ForbiddenException("A legal hold cannot be rejected by its requester.");
      }
      return { status: "REJECTED", rejectedById: user.id, rejectedAt: now };
    });
  }

  requestRelease(user: AuthenticatedUser, id: string, dto: AuditLegalHoldTransitionDto) {
    return this.transition(user, id, dto, "ACTIVE", "release_requested", (hold, now) => {
      if (!isHoldInEffect(hold, now)) {
        throw new ConflictException("The hold has already expired; there is nothing to release.");
      }
      return {
        status: "RELEASE_PENDING",
        releaseRequestedById: user.id,
        releaseRequestedAt: now,
      };
    });
  }

  approveRelease(user: AuthenticatedUser, id: string, dto: AuditLegalHoldTransitionDto) {
    return this.transition(user, id, dto, "RELEASE_PENDING", "released", (hold, now) => {
      if (hold.releaseRequestedById === user.id) {
        throw new ForbiddenException(
          "A release must be approved by a different administrator than the one who requested it.",
        );
      }
      if (!isHoldInEffect(hold, now)) {
        throw new ConflictException("The hold has already expired; there is nothing to release.");
      }
      return { status: "RELEASED", releasedById: user.id, releasedAt: now };
    });
  }

  async get(id: string): Promise<AuditLegalHoldView> {
    return this.view(await this.load(id), this.clock.now());
  }

  async list(
    query: ListAuditLegalHoldsDto,
  ): Promise<{ items: AuditLegalHoldView[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const rows = await this.prisma.auditLegalHold.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.organizationId ? { organizationId: query.organizationId } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const now = this.clock.now();
    const page = rows.slice(0, limit);
    return {
      items: page.map((hold) => this.view(hold, now)),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  private async transition(
    user: AuthenticatedUser,
    id: string,
    dto: AuditLegalHoldTransitionDto,
    from: AuditLegalHoldStatus,
    action: AuditAction,
    decide: (hold: AuditLegalHold, now: Date) => Prisma.AuditLegalHoldUpdateManyMutationInput,
  ): Promise<AuditLegalHoldView> {
    const hold = await this.load(id);

    if (hold.revision !== dto.expectedRevision) {
      throw staleRevision(dto.expectedRevision, hold.revision);
    }
    if (hold.status !== from) {
      throw new ConflictException(
        `Legal hold is ${hold.status}; this action requires ${from}.`,
      );
    }

    const now = this.clock.now();
    const data = decide(hold, now);

    const applied = await this.prisma.auditLegalHold.updateMany({
      where: { id, status: from, revision: dto.expectedRevision },
      data: { ...data, revision: { increment: 1 } },
    });
    if (applied.count !== 1) {
      // Another decision committed between our read and our write.
      throw staleRevision(dto.expectedRevision, null);
    }

    const updated = await this.load(id);
    await this.audit(user, action, updated);
    return this.view(updated, now);
  }

  private async validateRequest(dto: CreateAuditLegalHoldDto, now: Date): Promise<void> {
    if (dto.scope === "ORGANIZATION" && !dto.organizationId) {
      throw new BadRequestException("organizationId is required for an ORGANIZATION hold.");
    }
    if (dto.scope === "PLATFORM" && dto.organizationId !== undefined) {
      throw new BadRequestException("organizationId must be omitted for a PLATFORM hold.");
    }
    if (dto.rangeStart.getTime() > dto.rangeEnd.getTime()) {
      throw new BadRequestException("rangeStart must not be after rangeEnd.");
    }
    if (dto.rangeEnd.getTime() - dto.rangeStart.getTime() > MAX_HOLD_RANGE_DAYS * DAY_MS) {
      throw new BadRequestException(
        `A hold may cover at most ${MAX_HOLD_RANGE_DAYS} days of records.`,
      );
    }
    if (dto.expiresAt.getTime() <= now.getTime()) {
      throw new BadRequestException("expiresAt must be in the future.");
    }
    if (dto.expiresAt.getTime() > now.getTime() + MAX_HOLD_DAYS * DAY_MS) {
      throw new BadRequestException(
        `expiresAt may be at most ${MAX_HOLD_DAYS} days ahead; renew with a new hold.`,
      );
    }

    if (dto.scope === "ORGANIZATION") {
      const organization = await this.prisma.organization.findUnique({
        where: { id: dto.organizationId! },
        select: { id: true },
      });
      if (!organization) {
        throw new NotFoundException(`Organization ${dto.organizationId} not found`);
      }
    }
  }

  private async load(id: string): Promise<AuditLegalHold> {
    const hold = await this.prisma.auditLegalHold.findUnique({ where: { id } });
    if (!hold) throw new NotFoundException(`Legal hold ${id} not found`);
    return hold;
  }

  private view(hold: AuditLegalHold, now: Date): AuditLegalHoldView {
    return { ...hold, inEffect: isHoldInEffect(hold, now) };
  }

  /**
   * Records the decision in the tamper-evident audit chain. Metadata is the
   * hold's structured fields only; there is no narrative to leak.
   */
  private async audit(
    user: AuthenticatedUser,
    action: AuditAction,
    hold: AuditLegalHold,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorType: "User",
        actorId: user.id,
        action: `audit.legal_hold.${action}`,
        resourceType: "AuditLegalHold",
        resourceId: hold.id,
        organizationId: hold.organizationId,
        metadata: {
          scope: hold.scope,
          authority: hold.authority,
          reasonCommitment: hold.reasonCommitment,
          rangeStart: hold.rangeStart.toISOString(),
          rangeEnd: hold.rangeEnd.toISOString(),
          expiresAt: hold.expiresAt.toISOString(),
          status: hold.status,
          revision: hold.revision,
        },
      },
    });
  }
}

function staleRevision(expected: number, actual: number | null): ConflictException {
  return new ConflictException(
    actual === null
      ? `Stale decision: revision ${expected} is no longer current. Re-read the hold and retry.`
      : `Stale decision: expected revision ${expected} but the hold is at revision ${actual}. ` +
          "Re-read the hold and retry.",
  );
}
