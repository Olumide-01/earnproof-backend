import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, ResourceStatus } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { ApiErrorCode } from "../common/dto/api-error.dto";
import { Clock, SystemClock } from "../common/time/clock";
import { PrismaService } from "../database/prisma.service";
import {
  archiveRetentionElapsed,
  deletableAfter,
  DeletionBlocker,
  DeletionBlockerCode,
  DELETED_ORGANIZATION_NAME,
  lifecycleStateOf,
  OrganizationLifecycleState,
} from "./organization-lifecycle.policy";

export const ORGANIZATION_AUDIT_RESOURCE_TYPE = "Organization";
export const ORGANIZATION_LIFECYCLE_ACTIONS = {
  archived: "organization.archived",
  restored: "organization.restored",
  legalHoldPlaced: "organization.legal_hold_placed",
  legalHoldReleased: "organization.legal_hold_released",
  deleted: "organization.deleted",
} as const;

/** Issuer states that still vouch for attestations and block deletion. */
const LIVE_ISSUER_STATUSES: ResourceStatus[] = [
  ResourceStatus.ACTIVE,
  ResourceStatus.PENDING,
];

type LifecycleRow = {
  id: string;
  status: ResourceStatus;
  archivedAt: Date | null;
  legalHoldAt: Date | null;
  deletedAt: Date | null;
};

const LIFECYCLE_SELECT = {
  id: true,
  status: true,
  archivedAt: true,
  legalHoldAt: true,
  deletedAt: true,
} satisfies Prisma.OrganizationSelect;

export interface OrganizationLifecycleView {
  id: string;
  status: ResourceStatus;
  lifecycleState: OrganizationLifecycleState;
  archivedAt: Date | null;
  legalHold: boolean;
  deletedAt: Date | null;
}

export interface DeletionEligibility {
  organizationId: string;
  lifecycleState: OrganizationLifecycleState;
  eligible: boolean;
  blockers: DeletionBlocker[];
  /** When the minimum archive period ends, for an archived organization. */
  deletableAfter: Date | null;
}

export interface DeletionResult extends OrganizationLifecycleView {
  apiKeysRevoked: number;
  webhooksDeleted: number;
  webhookDeliveriesDeleted: number;
  idempotencyRecordsDeleted: number;
}

type Tx = Prisma.TransactionClient;

/**
 * Archive, restore, legal hold and deletion for organizations.
 *
 * Every transition is a single conditional write on the organization row,
 * committed with its audit record, so a transition either happens and is
 * evidenced or does not happen at all, and two administrators racing on the
 * same organization cannot both succeed.
 *
 * Archival disables new privileged operations by construction: the API-key
 * guard, API-key and webhook management, webhook dispatch, issuer creation and
 * re-activation, attestation issuance and profile updates all read
 * `archivedAt` from the database on each call. Nothing is revoked on archive,
 * which is what makes restore lossless.
 *
 * Deletion never removes issuers or attestations, so historical verification
 * keeps working; see `docs/data-retention.md#organization-lifecycle`.
 */
@Injectable()
export class OrganizationLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async archive(
    actor: AuthenticatedUser,
    organizationId: string,
  ): Promise<OrganizationLifecycleView> {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.organization.updateMany({
        where: { id: organizationId, archivedAt: null, deletedAt: null },
        data: { archivedAt: now },
      });
      if (updated.count !== 1) {
        await this.explainRefusal(tx, organizationId, "archive");
      }

      await this.audit(tx, actor, organizationId, ORGANIZATION_LIFECYCLE_ACTIONS.archived, {
        archivedAt: now.toISOString(),
      });
      return this.view(tx, organizationId);
    });
  }

  async restore(
    actor: AuthenticatedUser,
    organizationId: string,
  ): Promise<OrganizationLifecycleView> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.organization.updateMany({
        where: { id: organizationId, archivedAt: { not: null }, deletedAt: null },
        data: { archivedAt: null },
      });
      if (updated.count !== 1) {
        await this.explainRefusal(tx, organizationId, "restore");
      }

      await this.audit(tx, actor, organizationId, ORGANIZATION_LIFECYCLE_ACTIONS.restored, {});
      return this.view(tx, organizationId);
    });
  }

  async placeLegalHold(
    actor: AuthenticatedUser,
    organizationId: string,
    reference: string,
  ): Promise<OrganizationLifecycleView> {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.organization.updateMany({
        where: { id: organizationId, legalHoldAt: null, deletedAt: null },
        data: { legalHoldAt: now, legalHoldReference: reference },
      });
      if (updated.count !== 1) {
        await this.explainRefusal(tx, organizationId, "placeLegalHold");
      }

      await this.audit(tx, actor, organizationId, ORGANIZATION_LIFECYCLE_ACTIONS.legalHoldPlaced, {
        reference,
      });
      return this.view(tx, organizationId);
    });
  }

  async releaseLegalHold(
    actor: AuthenticatedUser,
    organizationId: string,
  ): Promise<OrganizationLifecycleView> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { legalHoldReference: true },
      });
      const reference = current?.legalHoldReference ?? null;
      const updated = await tx.organization.updateMany({
        where: { id: organizationId, legalHoldAt: { not: null }, deletedAt: null },
        data: { legalHoldAt: null, legalHoldReference: null },
      });
      if (updated.count !== 1) {
        await this.explainRefusal(tx, organizationId, "releaseLegalHold");
      }

      await this.audit(tx, actor, organizationId, ORGANIZATION_LIFECYCLE_ACTIONS.legalHoldReleased, {
        reference,
      });
      return this.view(tx, organizationId);
    });
  }

  async getDeletionEligibility(organizationId: string): Promise<DeletionEligibility> {
    return this.prisma.$transaction(async (tx) => {
      const org = await this.load(tx, organizationId);
      return this.evaluate(tx, org, this.clock.now());
    });
  }

  /**
   * Deletes an archived organization.
   *
   * The organization row and its issuers are locked first, so the eligibility
   * decision and the cleanup see the same state: a legal hold placed, or an
   * issuer re-activated, concurrently either commits before the lock (and
   * blocks deletion) or waits for it (and then finds the organization deleted).
   */
  async deleteOrganization(
    actor: AuthenticatedUser,
    organizationId: string,
  ): Promise<DeletionResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Issuer" WHERE "organizationId" = ${organizationId} FOR UPDATE`;

      const org = await this.load(tx, organizationId);
      const previousStatus = org.status;
      const now = this.clock.now();
      const eligibility = await this.evaluate(tx, org, now);
      if (!eligibility.eligible) {
        // A stable error body, so the global filter forwards the message: the
        // blocker codes are bounded and safe, and are what the caller must fix.
        throw new ConflictException({
          code: ApiErrorCode.CONFLICT,
          message: `Organization cannot be deleted: ${eligibility.blockers
            .map((blocker) => blocker.code)
            .join(", ")}`,
        });
      }

      const apiKeys = await tx.apiKey.updateMany({
        where: { organizationId, status: { not: ResourceStatus.REVOKED } },
        data: { status: ResourceStatus.REVOKED, revokedAt: now },
      });

      const webhooks = await tx.webhook.findMany({
        where: { organizationId },
        select: { id: true },
      });
      const webhookIds = webhooks.map((webhook) => webhook.id);
      const deliveries = await tx.webhookDelivery.deleteMany({
        where: { webhookId: { in: webhookIds } },
      });
      const deletedWebhooks = await tx.webhook.deleteMany({
        where: { organizationId },
      });

      const idempotency = await tx.idempotencyRecord.deleteMany({
        where: { organizationId },
      });

      // The row survives as a tombstone: issuers, attestations and audit
      // records still reference it. Only the organization's own profile is
      // cleared; the slug stays reserved so it cannot be re-registered to
      // impersonate the retired tenant.
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          status: ResourceStatus.DELETED,
          deletedAt: now,
          name: DELETED_ORGANIZATION_NAME,
          website: null,
        },
      });

      const cleanup = {
        apiKeysRevoked: apiKeys.count,
        webhooksDeleted: deletedWebhooks.count,
        webhookDeliveriesDeleted: deliveries.count,
        idempotencyRecordsDeleted: idempotency.count,
      };

      await this.audit(tx, actor, organizationId, ORGANIZATION_LIFECYCLE_ACTIONS.deleted, {
        previousStatus,
        ...cleanup,
      });

      return { ...(await this.view(tx, organizationId)), ...cleanup };
    });
  }

  private async evaluate(
    tx: Tx,
    org: LifecycleRow,
    now: Date,
  ): Promise<DeletionEligibility> {
    const lifecycleState = lifecycleStateOf(org);
    const blockers: DeletionBlocker[] = [];

    if (lifecycleState === OrganizationLifecycleState.DELETED) {
      return {
        organizationId: org.id,
        lifecycleState,
        eligible: false,
        blockers: [],
        deletableAfter: null,
      };
    }

    if (!org.archivedAt) {
      blockers.push({ code: DeletionBlockerCode.NOT_ARCHIVED });
    } else if (!archiveRetentionElapsed(org.archivedAt, now)) {
      blockers.push({ code: DeletionBlockerCode.ARCHIVE_RETENTION_PERIOD });
    }

    if (org.legalHoldAt) {
      blockers.push({ code: DeletionBlockerCode.LEGAL_HOLD });
    }

    const liveIssuers = await tx.issuer.count({
      where: { organizationId: org.id, status: { in: LIVE_ISSUER_STATUSES } },
    });
    if (liveIssuers > 0) {
      blockers.push({ code: DeletionBlockerCode.ACTIVE_ISSUERS, count: liveIssuers });
    }

    const unsynced = await tx.issuer.count({
      where: {
        organizationId: org.id,
        status: { notIn: LIVE_ISSUER_STATUSES },
        contractSyncedStatus: ResourceStatus.ACTIVE,
      },
    });
    if (unsynced > 0) {
      blockers.push({
        code: DeletionBlockerCode.ISSUER_REGISTRY_OUT_OF_SYNC,
        count: unsynced,
      });
    }

    return {
      organizationId: org.id,
      lifecycleState,
      eligible: blockers.length === 0,
      blockers,
      deletableAfter: org.archivedAt ? deletableAfter(org.archivedAt) : null,
    };
  }

  /**
   * Turns a conditional write that matched nothing into the right error:
   * 404 when the organization does not exist, 409 when its current lifecycle
   * state does not allow the transition.
   */
  private async explainRefusal(
    tx: Tx,
    organizationId: string,
    operation: "archive" | "restore" | "placeLegalHold" | "releaseLegalHold",
  ): Promise<never> {
    const org = await this.load(tx, organizationId);
    if (org.deletedAt) {
      throw new ConflictException("Organization has been deleted");
    }
    const messages = {
      archive: "Organization is already archived",
      restore: "Organization is not archived",
      placeLegalHold: "Organization is already under legal hold",
      releaseLegalHold: "Organization is not under legal hold",
    };
    throw new ConflictException(messages[operation]);
  }

  private async load(tx: Tx, organizationId: string): Promise<LifecycleRow> {
    const org = await tx.organization.findUnique({
      where: { id: organizationId },
      select: LIFECYCLE_SELECT,
    });
    if (!org) throw new NotFoundException("Organization not found");
    return org;
  }

  private async view(tx: Tx, organizationId: string): Promise<OrganizationLifecycleView> {
    const org = await this.load(tx, organizationId);
    return {
      id: org.id,
      status: org.status,
      lifecycleState: lifecycleStateOf(org),
      archivedAt: org.archivedAt,
      legalHold: org.legalHoldAt !== null,
      deletedAt: org.deletedAt,
    };
  }

  private audit(
    tx: Tx,
    actor: AuthenticatedUser,
    organizationId: string,
    action: string,
    metadata: Prisma.InputJsonObject,
  ) {
    return tx.auditLog.create({
      data: {
        actorType: "user",
        actorId: actor.id,
        action,
        resourceType: ORGANIZATION_AUDIT_RESOURCE_TYPE,
        resourceId: organizationId,
        metadata,
      },
    });
  }
}
