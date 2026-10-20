import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ResourceStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { OrganizationQuotaService } from "../quotas/organization-quota.service";
import { ProtocolPauseService } from "../health/protocol-pause.service";
import { StructuredLogger } from "../common/logger";
import {
  ContractCapacityInfo,
  ProofCapacityPreflightDto,
  ProofCapacityPreflightResponseDto,
  ProofQuotaCapacityInfo,
} from "./dto/capacity-preflight.dto";
import { windowStart, QUOTA_WINDOWS } from "../quotas/quota.types";

const CONTRACT_STALE_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class ProofCapacityPreflightService {
  private readonly logger = new StructuredLogger(ProofCapacityPreflightService.name);
  private readonly network: string;
  private readonly contractId: string;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    @Optional()
    private readonly quotaService?: OrganizationQuotaService,
    @Optional()
    private readonly pauseService?: ProtocolPauseService,
  ) {
    this.network =
      configService.get<string>("stellar.networkPassphrase") ??
      "Test SDF Network ; September 2015";
    this.contractId =
      configService.get<string>("stellar.contractId") ?? "CONTRACT_ANCHOR_DEFAULT";
  }

  /**
   * Evaluates advisory proof issuance capacity and quotas across backend and contract layers.
   * Authoritative checks are repeated inside transactional issuance.
   */
  async evaluatePreflight(
    userId: string,
    dto: ProofCapacityPreflightDto,
  ): Promise<ProofCapacityPreflightResponseDto> {
    const now = new Date();
    const denialReasons: string[] = [];

    // 1. Resolve organization for user
    let orgId: string | null = dto.organizationId ?? null;
    if (orgId) {
      // Validate user belongs to the requested organization
      const membership = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: orgId,
            userId,
          },
        },
        include: { organization: true },
      });

      if (!membership || membership.organization.status !== ResourceStatus.ACTIVE) {
        denialReasons.push("ORGANIZATION_INACTIVE_OR_UNAUTHORIZED");
        orgId = null;
      }
    } else {
      // Try resolving user's administered active org
      const administeredOrg = await this.prisma.organization.findFirst({
        where: { createdById: userId, status: ResourceStatus.ACTIVE },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, archivedAt: true },
      });
      if (administeredOrg) {
        if (administeredOrg.archivedAt) {
          denialReasons.push("ORGANIZATION_ARCHIVED");
        } else {
          orgId = administeredOrg.id;
        }
      }
    }

    // 2. Evaluate Quota
    let quotaInfo: ProofQuotaCapacityInfo;
    const dailyWindow = windowStart("proof_requests", now);
    const quotaLimit = this.quotaService ? this.quotaService.limitFor("proof_requests") : 1000;

    if (orgId) {
      const usageRow = await this.prisma.organizationQuotaUsage.findUnique({
        where: {
          organizationId_quota_windowStart: {
            organizationId: orgId,
            quota: "proof_requests",
            windowStart: dailyWindow,
          },
        },
      });

      const used = usageRow?.count ?? 0;
      const remaining = Math.max(0, quotaLimit - used);
      const resetsAt = new Date(
        dailyWindow.getTime() + QUOTA_WINDOWS.proof_requests.ms,
      ).toISOString();

      quotaInfo = {
        source: "organization",
        window: "daily",
        usage: used,
        limit: quotaLimit,
        remaining,
        resetsAt,
      };

      if (remaining <= 0) {
        denialReasons.push("ORGANIZATION_QUOTA_EXCEEDED");
      }
    } else {
      quotaInfo = {
        source: "default",
        window: "daily",
        usage: 0,
        limit: quotaLimit,
        remaining: quotaLimit,
        resetsAt: new Date(
          dailyWindow.getTime() + QUOTA_WINDOWS.proof_requests.ms,
        ).toISOString(),
      };
    }

    // 3. Supported Asset Check
    if (dto.assetCode) {
      const asset = await this.prisma.supportedAsset.findFirst({
        where: {
          code: dto.assetCode,
          status: ResourceStatus.ACTIVE,
        },
      });

      if (!asset) {
        denialReasons.push("ASSET_NOT_SUPPORTED_OR_INACTIVE");
      }
    }

    // 4. Contract Capacity & Pause State Check
    let contractCapacity: ContractCapacityInfo;
    if (this.pauseService) {
      const pauseState = await this.pauseService.getPauseState(
        this.network,
        this.contractId,
      );

      const freshnessMs = now.getTime() - new Date(pauseState.lastCheckedAt).getTime();
      const isStale = freshnessMs > CONTRACT_STALE_MS || !pauseState.isFresh;

      if (pauseState.isPaused) {
        contractCapacity = {
          status: "PAUSED",
          freshnessMs,
          observedLedger: pauseState.observedLedger,
          scopes: pauseState.scopes,
        };
        denialReasons.push("CONTRACT_PAUSED");
      } else if (isStale) {
        contractCapacity = {
          status: "DEGRADED",
          freshnessMs,
          observedLedger: pauseState.observedLedger,
          scopes: pauseState.scopes,
        };
        denialReasons.push("CONTRACT_STATE_STALE");
      } else {
        contractCapacity = {
          status: "HEALTHY",
          freshnessMs,
          observedLedger: pauseState.observedLedger,
          scopes: pauseState.scopes,
        };
      }
    } else {
      contractCapacity = {
        status: "HEALTHY",
        freshnessMs: 0,
        scopes: [],
      };
    }

    const allowed = denialReasons.length === 0 && quotaInfo.remaining > 0;
    const capacityRemaining = allowed ? quotaInfo.remaining : 0;

    this.logger.log("Proof issuance preflight evaluated", {
      workflow: "proof_preflight",
      outcome: allowed ? "allowed" : "denied",
      userId,
      proofType: dto.proofType,
      allowed,
      reasonsCount: denialReasons.length,
    });

    return {
      allowed,
      capacityRemaining,
      quota: quotaInfo,
      contractCapacity,
      denialReasons,
      advisoryOnly: true,
      evaluatedAt: now.toISOString(),
    };
  }
}
