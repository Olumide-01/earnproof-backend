import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ReconciliationConflictStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { ApprovalsService } from "../approvals/approvals.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { ProposeConflictResolutionDto, ExecuteResolutionPlanDto } from "./dto/reconciliation-conflict.dto";

@Injectable()
export class ReconciliationConflictService {
  private readonly logger = new Logger(ReconciliationConflictService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalsService: ApprovalsService,
  ) {}

  /**
   * Proposes a formal resolution plan for a quarantined reconciliation conflict.
   * Creates an ApprovalRequest to enforce dual-control before any state mutation.
   */
  async proposeResolution(user: AuthenticatedUser, dto: ProposeConflictResolutionDto) {
    const conflict = await this.prisma.reconciliationConflict.findUnique({
      where: { id: dto.conflictId },
    });

    if (!conflict) {
      throw new NotFoundException(`Reconciliation conflict ${dto.conflictId} not found`);
    }

    if (conflict.status === ReconciliationConflictStatus.RESOLVED) {
      throw new BadRequestException("Conflict has already been resolved");
    }

    // Submit an approval request to enforce dual-control
    const approval = await this.approvalsService.create(user, {
      operationType: "reconciliation.resolve_conflict",
      payload: {
        conflictId: conflict.id,
        resourceType: conflict.resourceType,
        resourceId: conflict.resourceId,
        action: dto.action,
        reason: dto.reason,
        riskLevel: dto.riskLevel,
        evidence: dto.evidence ?? conflict.contractState,
      },
      ttlMinutes: 1440,
    });

    this.logger.log(
      `Proposed resolution for conflict ${conflict.id} via approval request ${approval.id}`,
    );

    return {
      conflictId: conflict.id,
      approvalRequestId: approval.id,
      status: "PENDING_APPROVAL",
    };
  }

  /**
   * Idempotently executes an approved conflict resolution plan with lease control.
   */
  async executeResolution(
    user: AuthenticatedUser,
    approvalRequestId: string,
    dto: ExecuteResolutionPlanDto,
  ) {
    // 1. Claim execution lease via the approvals service
    const claim = await this.approvalsService.claimForExecution(
      approvalRequestId,
    );

    if (!claim.claimed) {
      throw new ConflictException(
        `Execution lease could not be claimed. Approval status is ${claim.request.status}`,
      );
    }

    const approval = await this.approvalsService.get(approvalRequestId);
    const payload = approval.payload as any;
    const conflictId = payload.conflictId as string;

    const conflict = await this.prisma.reconciliationConflict.findUnique({
      where: { id: conflictId },
    });

    if (!conflict) {
      throw new NotFoundException(`Reconciliation conflict ${conflictId} not found`);
    }

    if (conflict.status !== ReconciliationConflictStatus.RESOLVED) {
      await this.prisma.reconciliationConflict.update({
        where: { id: conflictId },
        data: {
          status: ReconciliationConflictStatus.RESOLVED,
          resolvedAt: new Date(),
          resolvedBy: user.id,
          resolutionReason: payload.reason,
          metadata: {
            resolvedViaApprovalId: approvalRequestId,
            action: payload.action,
            riskLevel: payload.riskLevel,
          },
        },
      });
    }

    // 2. Mark the approval request as executed
    await this.approvalsService.completeExecution(
      approvalRequestId,
      claim.leaseToken,
    );

    this.logger.log(`Reconciliation conflict ${conflictId} resolved via execution lease`);

    return {
      conflictId,
      status: ReconciliationConflictStatus.RESOLVED,
      executedAt: new Date(),
    };
  }
}
