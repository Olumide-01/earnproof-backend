import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  OrganizationMemberRole,
  OrganizationRoleApprovalPolicy,
  Prisma,
} from "@prisma/client";
import { AuthenticatedUser } from "../../auth/auth.types";
import { PrismaService } from "../../database/prisma.service";
import {
  ListRoleApprovalPolicyHistoryDto,
  PreviewRoleApprovalPolicyDto,
  RoleApprovalPolicyRulesDto,
  UpdateRoleApprovalPolicyDto,
} from "./dto/role-approval-policy.dto";
import {
  DEFAULT_POLICY_VERSION,
  DEFAULT_ROLE_APPROVAL_POLICY,
  diffRoleApprovalPolicies,
  evaluateRoleChange,
  normalizeRoleApprovalPolicy,
  PolicyFieldChange,
  PolicyViolation,
  RoleApprovalPolicyRules,
  RoleChangeEvaluation,
  rolesFromJson,
  SEPARATION_OF_DUTIES,
  SeparationOfDuties,
  validateRoleApprovalPolicy,
} from "./role-approval-policy.rules";

const DEFAULT_HISTORY_LIMIT = 20;

/** Organization role rank, highest first. Mirrors OrganizationMemberGuard. */
const ROLE_RANK: Record<OrganizationMemberRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  VIEWER: 1,
};

export interface RoleApprovalPolicyView extends RoleApprovalPolicyRules {
  organizationId: string;
  version: number;
  status: "ACTIVE" | "SUPERSEDED";
  isDefault: boolean;
  separationOfDuties: SeparationOfDuties;
  supersedesId: string | null;
  createdById: string | null;
  createdAt: string | null;
}

export interface RoleApprovalPolicyPreview {
  valid: boolean;
  violations: PolicyViolation[];
  currentVersion: number;
  /** Null when `expectedVersion` was not supplied. */
  stale: boolean | null;
  /** Null when the proposal has violations. */
  proposed: RoleApprovalPolicyRules | null;
  changes: PolicyFieldChange[];
  sampleChange: RoleChangeEvaluation | null;
}

/** Thrown inside the update transaction when the ACTIVE row moved underneath it. */
class StalePolicyUpdateError extends Error {}

/**
 * Versioned organization role approval policies (#298).
 *
 * Authorization:
 * - read and history: any ACTIVE organization member, or a platform ADMIN.
 * - preview: organization OWNER or ADMIN, or a platform ADMIN.
 * - update: organization OWNER, or a platform ADMIN. An organization ADMIN
 *   cannot loosen the controls that govern ADMIN changes.
 *
 * Concurrency: every update names the version it was based on. The ACTIVE row
 * is superseded with a conditional `updateMany`, and `(organizationId,
 * version)` is unique, so of two concurrent updates from the same base exactly
 * one commits; the other receives 409. Replaying a successful update is
 * therefore also a 409, because its base version is no longer active.
 */
@Injectable()
export class RoleApprovalPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async getActive(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<RoleApprovalPolicyView> {
    await this.authorize(user, organizationId, "VIEWER");
    const active = await this.findActive(organizationId);
    return active ? toView(active) : defaultView(organizationId);
  }

  async history(
    user: AuthenticatedUser,
    organizationId: string,
    query: ListRoleApprovalPolicyHistoryDto,
  ): Promise<{ items: RoleApprovalPolicyView[]; nextBeforeVersion: number | null }> {
    await this.authorize(user, organizationId, "VIEWER");
    const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;

    const rows = await this.prisma.organizationRoleApprovalPolicy.findMany({
      where: {
        organizationId,
        ...(query.beforeVersion !== undefined
          ? { version: { lt: query.beforeVersion } }
          : {}),
      },
      orderBy: { version: "desc" },
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    return {
      items: page.map(toView),
      nextBeforeVersion: rows.length > limit ? page[page.length - 1].version : null,
    };
  }

  async preview(
    user: AuthenticatedUser,
    organizationId: string,
    dto: PreviewRoleApprovalPolicyDto,
  ): Promise<RoleApprovalPolicyPreview> {
    await this.authorize(user, organizationId, "ADMIN");

    const sample = dto.sampleChange;
    if (sample && !sample.fromRole && !sample.toRole) {
      throw new BadRequestException(
        "sampleChange must name a fromRole, a toRole, or both.",
      );
    }

    const active = await this.findActive(organizationId);
    const currentVersion = active?.version ?? DEFAULT_POLICY_VERSION;
    const current = active ? rulesFromRow(active) : DEFAULT_ROLE_APPROVAL_POLICY;
    const violations = validateRoleApprovalPolicy(dto);
    const proposed = violations.length === 0 ? normalizeRoleApprovalPolicy(dto) : null;

    return {
      valid: violations.length === 0,
      violations,
      currentVersion,
      stale:
        dto.expectedVersion === undefined ? null : dto.expectedVersion !== currentVersion,
      proposed,
      changes: proposed ? diffRoleApprovalPolicies(current, proposed) : [],
      sampleChange:
        proposed && sample
          ? evaluateRoleChange(proposed, sample.fromRole ?? null, sample.toRole ?? null)
          : null,
    };
  }

  async update(
    user: AuthenticatedUser,
    organizationId: string,
    dto: UpdateRoleApprovalPolicyDto,
  ): Promise<RoleApprovalPolicyView> {
    const organization = await this.authorize(user, organizationId, "OWNER");
    if (organization.archivedAt) {
      throw new ConflictException(
        "Organization is archived; its role approval policy cannot be changed.",
      );
    }

    const proposed = this.validated(dto);
    const active = await this.findActive(organizationId);
    const currentVersion = active?.version ?? DEFAULT_POLICY_VERSION;

    if (dto.expectedVersion !== currentVersion) {
      throw staleUpdate(dto.expectedVersion, currentVersion);
    }

    const current = active ? rulesFromRow(active) : DEFAULT_ROLE_APPROVAL_POLICY;
    const changes = diffRoleApprovalPolicies(current, proposed);
    if (changes.length === 0) {
      throw new BadRequestException(
        "The proposed policy is identical to the active version.",
      );
    }

    const nextVersion = currentVersion + 1;
    let created: OrganizationRoleApprovalPolicy;

    try {
      created = await this.prisma.$transaction(async (tx) => {
        if (active) {
          const superseded = await tx.organizationRoleApprovalPolicy.updateMany({
            where: { id: active.id, status: "ACTIVE" },
            data: { status: "SUPERSEDED" },
          });
          if (superseded.count !== 1) throw new StalePolicyUpdateError();
        }

        return tx.organizationRoleApprovalPolicy.create({
          data: {
            organizationId,
            version: nextVersion,
            protectedRoles: proposed.protectedRoles as Prisma.InputJsonValue,
            approverRoles: proposed.approverRoles as Prisma.InputJsonValue,
            requiredApprovals: proposed.requiredApprovals,
            approvalExpiryMinutes: proposed.approvalExpiryMinutes,
            ownerChangesRequireOwnerApproval: proposed.ownerChangesRequireOwnerApproval,
            supersedesId: active?.id ?? null,
            createdById: user.id,
          },
        });
      });
    } catch (error) {
      if (error instanceof StalePolicyUpdateError || isUniqueViolation(error)) {
        // Another update committed between our read and our write.
        throw staleUpdate(dto.expectedVersion, null);
      }
      throw error;
    }

    // Written through the patched delegate (not `tx`) so the record joins the
    // organization's tamper-evident audit chain.
    await this.prisma.auditLog.create({
      data: {
        actorType: "User",
        actorId: user.id,
        action: "organization.role_approval_policy.updated",
        resourceType: "OrganizationRoleApprovalPolicy",
        resourceId: created.id,
        organizationId,
        metadata: {
          version: nextVersion,
          previousVersion: currentVersion,
          changedFields: changes.map((change) => change.field),
        },
      },
    });

    return toView(created);
  }

  private validated(dto: RoleApprovalPolicyRulesDto): RoleApprovalPolicyRules {
    const violations = validateRoleApprovalPolicy(dto);
    if (violations.length > 0) {
      throw new BadRequestException({
        message: "The proposed policy violates platform minimums.",
        violations,
      });
    }
    return normalizeRoleApprovalPolicy(dto);
  }

  private findActive(
    organizationId: string,
  ): Promise<OrganizationRoleApprovalPolicy | null> {
    return this.prisma.organizationRoleApprovalPolicy.findFirst({
      where: { organizationId, status: "ACTIVE" },
      orderBy: { version: "desc" },
    });
  }

  /**
   * Resolves the organization and checks the caller's standing in it.
   *
   * A deleted organization is reported as not found. Platform ADMINs pass;
   * everyone else needs an ACTIVE membership at or above `minimum`.
   */
  private async authorize(
    user: AuthenticatedUser,
    organizationId: string,
    minimum: OrganizationMemberRole,
  ): Promise<{ archivedAt: Date | null }> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { archivedAt: true, deletedAt: true },
    });

    if (!organization || organization.deletedAt) {
      throw new NotFoundException(`Organization ${organizationId} not found`);
    }

    if (user.role === "ADMIN") return organization;

    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      select: { role: true, status: true },
    });

    if (!membership || membership.status !== "ACTIVE") {
      throw new ForbiddenException("You are not a member of this organization");
    }

    if (ROLE_RANK[membership.role] < ROLE_RANK[minimum]) {
      throw new ForbiddenException(
        `This action requires the ${minimum} organization role`,
      );
    }

    return organization;
  }
}

function staleUpdate(expected: number, active: number | null): ConflictException {
  return new ConflictException(
    active === null
      ? `Stale update: version ${expected} is no longer active. Re-read the policy and retry.`
      : `Stale update: expected version ${expected} but version ${active} is active. ` +
          "Re-read the policy and retry.",
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function rulesFromRow(row: OrganizationRoleApprovalPolicy): RoleApprovalPolicyRules {
  return {
    protectedRoles: rolesFromJson(row.protectedRoles),
    approverRoles: rolesFromJson(row.approverRoles),
    requiredApprovals: row.requiredApprovals,
    approvalExpiryMinutes: row.approvalExpiryMinutes,
    ownerChangesRequireOwnerApproval: row.ownerChangesRequireOwnerApproval,
  };
}

function toView(row: OrganizationRoleApprovalPolicy): RoleApprovalPolicyView {
  return {
    organizationId: row.organizationId,
    version: row.version,
    status: row.status,
    isDefault: false,
    ...rulesFromRow(row),
    separationOfDuties: SEPARATION_OF_DUTIES,
    supersedesId: row.supersedesId,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
  };
}

function defaultView(organizationId: string): RoleApprovalPolicyView {
  return {
    organizationId,
    version: DEFAULT_POLICY_VERSION,
    status: "ACTIVE",
    isDefault: true,
    ...DEFAULT_ROLE_APPROVAL_POLICY,
    protectedRoles: [...DEFAULT_ROLE_APPROVAL_POLICY.protectedRoles],
    approverRoles: [...DEFAULT_ROLE_APPROVAL_POLICY.approverRoles],
    separationOfDuties: SEPARATION_OF_DUTIES,
    supersedesId: null,
    createdById: null,
    createdAt: null,
  };
}
