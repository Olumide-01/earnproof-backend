import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ApprovalRequest, ApprovalRequestStatus, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { CreateApprovalRequestDto } from "./dto/create-approval-request.dto";
import { DecideApprovalRequestDto } from "./dto/decide-approval-request.dto";

const DEFAULT_TTL_MINUTES = 1440;

export type LeaseClaimResult =
  | { claimed: true; leaseToken: string }
  | { claimed: false; request: ApprovalRequest };

@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    user: AuthenticatedUser,
    dto: CreateApprovalRequestDto,
  ): Promise<ApprovalRequest> {
    const payloadHash = sha256(canonicalize(dto.payload));
    const ttlMinutes = dto.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    const request = await this.prisma.approvalRequest.create({
      data: {
        operationType: dto.operationType,
        payload: dto.payload as Prisma.InputJsonValue,
        payloadHash,
        requestedById: user.id,
        expiresAt,
      },
    });

    await this.audit(user, "approval.requested", request.id, {
      operationType: dto.operationType,
      payloadHash,
      expiresAt,
    });

    return request;
  }

  async get(id: string): Promise<ApprovalRequest> {
    const request = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Approval request ${id} not found`);
    }
    return request;
  }

  /**
   * Approve a pending request.
   *
   * Self-approval is blocked unconditionally. The transition out of PENDING
   * is applied with a single conditional `updateMany` so that under
   * concurrent decisions exactly one caller observes `count === 1` — the
   * other(s) land on the now-terminal state and are told so, never silently
   * overwriting a decision that already won.
   */
  async approve(
    user: AuthenticatedUser,
    id: string,
    dto: DecideApprovalRequestDto,
  ): Promise<ApprovalRequest> {
    return this.decide(user, id, dto, "APPROVED");
  }

  /** Reject a pending request. Same terminal-decision guarantees as {@link approve}. */
  async reject(
    user: AuthenticatedUser,
    id: string,
    dto: DecideApprovalRequestDto,
  ): Promise<ApprovalRequest> {
    return this.decide(user, id, dto, "REJECTED");
  }

  private async decide(
    user: AuthenticatedUser,
    id: string,
    dto: DecideApprovalRequestDto,
    outcome: "APPROVED" | "REJECTED",
  ): Promise<ApprovalRequest> {
    const existing = await this.get(id);

    if (existing.requestedById === user.id) {
      throw new ForbiddenException(
        "The requester of a privileged operation cannot decide on it",
      );
    }

    if (existing.payloadHash !== dto.expectedPayloadHash) {
      throw new ConflictException(
        "expectedPayloadHash does not match the request's current payload — refresh and retry",
      );
    }

    const now = new Date();

    const result = await this.prisma.approvalRequest.updateMany({
      where: {
        id,
        status: ApprovalRequestStatus.PENDING,
        // Boundary: a request expiring at exactly `now` is treated as
        // already expired, matching the expiry sweep's own `lt` cutoff.
        expiresAt: { gt: now },
      },
      data: {
        status: outcome,
        decidedById: user.id,
        decidedAt: now,
        decisionReason: dto.reason,
      },
    });

    if (result.count === 0) {
      const current = await this.get(id);
      if (current.status !== ApprovalRequestStatus.PENDING) {
        throw new ConflictException(
          `Request already has a terminal decision: ${current.status}`,
        );
      }
      // Status is still PENDING in the row we just re-read, so the only
      // other reason the conditional update missed is the expiry boundary.
      throw new ConflictException("Request has expired and can no longer be decided");
    }

    const updated = await this.get(id);

    await this.audit(user, `approval.${outcome.toLowerCase()}`, id, {
      reason: dto.reason,
    });

    return updated;
  }

  /** Requester or an admin may cancel a request that is still PENDING. */
  async cancel(user: AuthenticatedUser, id: string): Promise<ApprovalRequest> {
    const existing = await this.get(id);

    if (existing.requestedById !== user.id && user.role !== "ADMIN") {
      throw new ForbiddenException(
        "Only the requester or an admin may cancel this request",
      );
    }

    const result = await this.prisma.approvalRequest.updateMany({
      where: { id, status: ApprovalRequestStatus.PENDING },
      data: {
        status: ApprovalRequestStatus.CANCELLED,
        decidedById: user.id,
        decidedAt: new Date(),
      },
    });

    if (result.count === 0) {
      const current = await this.get(id);
      throw new ConflictException(
        `Request already has a terminal decision: ${current.status}`,
      );
    }

    const updated = await this.get(id);
    await this.audit(user, "approval.cancelled", id, {});
    return updated;
  }

  /**
   * Atomically claim the right to execute an APPROVED request exactly once.
   *
   * Only one concurrent caller will see `claimed: true`; every other caller
   * (including retries after the lease is already held) sees `claimed: false`
   * with the current row so it can decide whether to wait, no-op, or report
   * the conflict upward.
   */
  async claimForExecution(id: string): Promise<LeaseClaimResult> {
    const leaseToken = randomUUID();

    const result = await this.prisma.approvalRequest.updateMany({
      where: {
        id,
        status: ApprovalRequestStatus.APPROVED,
        executionLeaseToken: null,
      },
      data: {
        executionLeaseToken: leaseToken,
        executionLeasedAt: new Date(),
      },
    });

    if (result.count === 1) {
      return { claimed: true, leaseToken };
    }

    return { claimed: false, request: await this.get(id) };
  }

  /**
   * Mark execution complete for the lease obtained from
   * {@link claimForExecution}. Idempotent: calling it again with the same
   * lease token after it already completed is a no-op, not an error.
   */
  async completeExecution(id: string, leaseToken: string): Promise<ApprovalRequest> {
    const now = new Date();

    const result = await this.prisma.approvalRequest.updateMany({
      where: {
        id,
        executionLeaseToken: leaseToken,
        status: ApprovalRequestStatus.APPROVED,
      },
      data: {
        status: ApprovalRequestStatus.EXECUTED,
        executedAt: now,
      },
    });

    const current = await this.get(id);

    if (result.count === 0) {
      const alreadyCompletedByThisLease =
        current.status === ApprovalRequestStatus.EXECUTED &&
        current.executionLeaseToken === leaseToken;

      if (!alreadyCompletedByThisLease) {
        throw new ConflictException(
          "Execution lease mismatch — this caller does not hold the active lease",
        );
      }
    }

    return current;
  }

  /** Expire PENDING requests whose deadline has passed. Returns the count affected. */
  async expireStale(): Promise<number> {
    const result = await this.prisma.approvalRequest.updateMany({
      where: {
        status: ApprovalRequestStatus.PENDING,
        expiresAt: { lt: new Date() },
      },
      data: { status: ApprovalRequestStatus.EXPIRED },
    });
    return result.count;
  }

  private audit(
    user: AuthenticatedUser,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action,
        resourceType: "ApprovalRequest",
        resourceId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}
