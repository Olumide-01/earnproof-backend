import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CheckpointHealthClassification,
  PaymentCheckpointHealthSnapshot,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import {
  CheckpointHealthSnapshotDto,
  CheckpointHealthSummaryDto,
  QueryCheckpointHealthDto,
  RetryCheckpointSyncDto,
} from "./dto/checkpoint-health.dto";

/** Default threshold in ledgers above which sync is classified as stalled (~15 minutes on Stellar, ~5s/ledger) */
export const DEFAULT_STALL_LEDGER_THRESHOLD = 180;

/** Maximum snapshots retained per user */
export const MAX_SNAPSHOTS_PER_USER = 100;

export interface RecordSnapshotParams {
  userId: string;
  organizationId?: string | null;
  network: string;
  walletAddressHash: string;
  ledgerSequence: number;
  latestKnownLedger: number;
  pagingToken: string;
  divergenceReason?: string | null;
  error?: { status?: number; code?: string; message?: string } | null;
  isReorganizing?: boolean;
  recoveryAttempts?: number;
}

@Injectable()
export class PaymentCheckpointHealthService {
  private readonly logger = new Logger(PaymentCheckpointHealthService.name);
  private readonly stallThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.stallThreshold = Number(
      this.configService.get<number>(
        "CHECKPOINT_HEALTH_STALL_THRESHOLD",
        DEFAULT_STALL_LEDGER_THRESHOLD,
      ),
    );
  }

  /**
   * Classify checkpoint operational health based on ledger lag, divergence, and errors.
   */
  classify(
    lag: number,
    divergenceReason?: string | null,
    error?: { status?: number; code?: string; message?: string } | null,
    isReorganizing?: boolean,
  ): CheckpointHealthClassification {
    if (divergenceReason || isReorganizing) {
      return CheckpointHealthClassification.REORGANIZATION_RECOVERY;
    }

    if (error) {
      if (error.status === 429 || error.code === "RATE_LIMIT") {
        return CheckpointHealthClassification.RATE_LIMITING;
      }
      if (
        (error.status && error.status >= 500) ||
        error.code === "ECONNREFUSED" ||
        error.code === "ETIMEDOUT" ||
        (error.message && /horizon.*(outage|unavailable|down|network)/i.test(error.message))
      ) {
        return CheckpointHealthClassification.HORIZON_OUTAGE;
      }
    }

    if (lag >= this.stallThreshold) {
      return CheckpointHealthClassification.STALLED_INGESTION;
    }

    return CheckpointHealthClassification.NORMAL_LAG;
  }

  /**
   * Record a bounded checkpoint health snapshot.
   *
   * Enforces:
   * 1. Privacy safety: strictly NO raw memo, amount, or counterparty data.
   * 2. Checkpoint regression guard: regression cannot silently replace a newer finalized cursor.
   */
  async recordSnapshot(
    params: RecordSnapshotParams,
  ): Promise<PaymentCheckpointHealthSnapshot> {
    const lag = Math.max(0, params.latestKnownLedger - params.ledgerSequence);
    const classification = this.classify(
      lag,
      params.divergenceReason,
      params.error,
      params.isReorganizing,
    );

    // Checkpoint regression guard:
    // Check if the user already has a verified checkpoint with a newer ledger sequence.
    const existingCheckpoint = await this.prisma.paymentSyncCheckpoint.findUnique({
      where: { userId: params.userId },
      select: { ledgerSequence: true, status: true },
    });

    if (
      existingCheckpoint &&
      existingCheckpoint.status === "VERIFIED" &&
      !params.divergenceReason &&
      !params.isReorganizing &&
      params.ledgerSequence < existingCheckpoint.ledgerSequence
    ) {
      const msg = `Checkpoint regression rejected: proposed ledger ${params.ledgerSequence} is older than verified ledger ${existingCheckpoint.ledgerSequence}`;
      this.logger.warn(msg, { userId: params.userId });
      throw new BadRequestException(msg);
    }

    // Sanitize metadata - strictly exclude memo, amount, counterparty
    const sanitizedMetadata: Record<string, unknown> = {
      divergenceReason: params.divergenceReason ?? null,
      errorCategory: params.error?.code ?? (params.error?.status ? `HTTP_${params.error.status}` : null),
      lagLedgers: lag,
      stallThreshold: this.stallThreshold,
    };

    const snapshot = await this.prisma.paymentCheckpointHealthSnapshot.create({
      data: {
        userId: params.userId,
        organizationId: params.organizationId ?? null,
        network: params.network,
        walletAddressHash: params.walletAddressHash,
        ledgerSequence: params.ledgerSequence,
        latestKnownLedger: params.latestKnownLedger,
        ledgerLag: lag,
        classification,
        pagingToken: params.pagingToken,
        isStalled: classification === CheckpointHealthClassification.STALLED_INGESTION,
        isReorganizing: classification === CheckpointHealthClassification.REORGANIZATION_RECOVERY,
        recoveryAttempts: params.recoveryAttempts ?? 0,
        metadata: sanitizedMetadata as Prisma.InputJsonValue,
      },
    });

    // Prune older snapshots if count exceeds MAX_SNAPSHOTS_PER_USER
    await this.pruneSnapshots(params.userId);

    return snapshot;
  }

  /**
   * Retrieves operational health summary for a given tenant organization.
   */
  async getTenantSummary(organizationId: string): Promise<CheckpointHealthSummaryDto> {
    // Verify organization exists
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!org) {
      throw new NotFoundException(`Organization ${organizationId} not found`);
    }

    // Get the most recent snapshot for each user belonging to the organization
    const latestSnapshots = await this.prisma.paymentCheckpointHealthSnapshot.findMany({
      where: { organizationId },
      orderBy: { recordedAt: "desc" },
      distinct: ["userId"],
    });

    const counts: Record<CheckpointHealthClassification, number> = {
      [CheckpointHealthClassification.NORMAL_LAG]: 0,
      [CheckpointHealthClassification.STALLED_INGESTION]: 0,
      [CheckpointHealthClassification.HORIZON_OUTAGE]: 0,
      [CheckpointHealthClassification.RATE_LIMITING]: 0,
      [CheckpointHealthClassification.REORGANIZATION_RECOVERY]: 0,
    };

    let maxLag = 0;
    let totalLag = 0;
    let stalledCount = 0;
    let reorgCount = 0;

    for (const snap of latestSnapshots) {
      counts[snap.classification] = (counts[snap.classification] || 0) + 1;
      if (snap.ledgerLag > maxLag) maxLag = snap.ledgerLag;
      totalLag += snap.ledgerLag;
      if (snap.isStalled) stalledCount++;
      if (snap.isReorganizing) reorgCount++;
    }

    const totalAccounts = latestSnapshots.length;
    const avgLag = totalAccounts > 0 ? Math.round(totalLag / totalAccounts) : 0;

    return {
      organizationId,
      totalAccounts,
      countsByClassification: counts,
      maxLag,
      avgLag,
      stalledAccountsCount: stalledCount,
      reorganizingAccountsCount: reorgCount,
      generatedAt: new Date(),
    };
  }

  /**
   * Lists recent checkpoint health snapshots with filtering.
   */
  async listSnapshots(
    userId: string,
    query: QueryCheckpointHealthDto,
  ): Promise<CheckpointHealthSnapshotDto[]> {
    const where: Prisma.PaymentCheckpointHealthSnapshotWhereInput = {};

    if (query.organizationId) {
      where.organizationId = query.organizationId;
    } else {
      where.userId = userId;
    }

    if (query.classification) {
      where.classification = query.classification;
    }

    const records = await this.prisma.paymentCheckpointHealthSnapshot.findMany({
      where,
      orderBy: { recordedAt: "desc" },
      take: query.limit ?? 20,
    });

    return records.map((r) => ({
      id: r.id,
      userId: r.userId,
      organizationId: r.organizationId,
      network: r.network,
      walletAddressHash: r.walletAddressHash,
      ledgerSequence: r.ledgerSequence,
      latestKnownLedger: r.latestKnownLedger,
      ledgerLag: r.ledgerLag,
      classification: r.classification,
      pagingToken: r.pagingToken,
      isStalled: r.isStalled,
      isReorganizing: r.isReorganizing,
      recoveryAttempts: r.recoveryAttempts,
      lastRecoveredAt: r.lastRecoveredAt,
      metadata: r.metadata as Record<string, unknown> | null,
      recordedAt: r.recordedAt,
    }));
  }

  /**
   * Executes an authorized bounded retry action.
   */
  async retrySync(
    actor: { id: string; role: string },
    dto: RetryCheckpointSyncDto,
  ): Promise<{ status: string; targetUserId: string; recoveryAttempts: number; message: string }> {
    const targetUserId = dto.userId ?? actor.id;

    // Authorization check: non-admin can only trigger retry for their own account
    if (targetUserId !== actor.id && actor.role !== "ADMIN") {
      throw new ForbiddenException("Cannot trigger sync retry for another user without admin privileges");
    }

    const checkpoint = await this.prisma.paymentSyncCheckpoint.findUnique({
      where: { userId: targetUserId },
    });

    if (!checkpoint) {
      throw new NotFoundException(`No checkpoint found for user ${targetUserId}`);
    }

    // Increment recovery attempts and clear transient stalled status
    const latestSnapshot = await this.prisma.paymentCheckpointHealthSnapshot.findFirst({
      where: { userId: targetUserId },
      orderBy: { recordedAt: "desc" },
    });

    const nextAttempts = (latestSnapshot?.recoveryAttempts ?? 0) + 1;

    // Record bounded recovery retry snapshot
    await this.recordSnapshot({
      userId: targetUserId,
      organizationId: latestSnapshot?.organizationId ?? null,
      network: latestSnapshot?.network ?? "testnet",
      walletAddressHash: latestSnapshot?.walletAddressHash ?? "unknown",
      ledgerSequence: checkpoint.ledgerSequence,
      latestKnownLedger: Math.max(checkpoint.ledgerSequence, latestSnapshot?.latestKnownLedger ?? checkpoint.ledgerSequence),
      pagingToken: checkpoint.pagingToken,
      isReorganizing: checkpoint.status === "DIVERGED",
      divergenceReason: checkpoint.divergenceReason,
      recoveryAttempts: nextAttempts,
    });

    return {
      status: "RETRY_TRIGGERED",
      targetUserId,
      recoveryAttempts: nextAttempts,
      message: `Bounded sync retry initiated with maxPages=${dto.maxPages ?? 5}`,
    };
  }

  /**
   * Prunes older snapshots to keep the table bounded.
   */
  private async pruneSnapshots(userId: string): Promise<void> {
    try {
      const count = await this.prisma.paymentCheckpointHealthSnapshot.count({
        where: { userId },
      });

      if (count > MAX_SNAPSHOTS_PER_USER) {
        const excess = count - MAX_SNAPSHOTS_PER_USER;
        const oldest = await this.prisma.paymentCheckpointHealthSnapshot.findMany({
          where: { userId },
          orderBy: { recordedAt: "asc" },
          take: excess,
          select: { id: true },
        });

        if (oldest.length > 0) {
          await this.prisma.paymentCheckpointHealthSnapshot.deleteMany({
            where: { id: { in: oldest.map((s) => s.id) } },
          });
        }
      }
    } catch (err) {
      this.logger.warn("Failed to prune checkpoint snapshots", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
