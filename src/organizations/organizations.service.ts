import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { OrganizationQuotaService } from "../quotas/organization-quota.service";
import { ConflictException } from "../common/exceptions/domain.exceptions";
import { CreateOrganizationDto } from "./dto/create-organization.dto";
import { ListOrganizationsDto } from "./dto/list-organizations.dto";
import { OrganizationResponseDto } from "./dto/organization-response.dto";
import { UpdateOrganizationDto } from "./dto/update-organization.dto";
import { lifecycleStateOf } from "./organization-lifecycle.policy";
import { OrganizationMembersService } from "./organization-members.service";

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotas: OrganizationQuotaService,
    private readonly membersService: OrganizationMembersService,
  ) {}

  async createOrganization(
    user: AuthenticatedUser,
    input: CreateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    if (user.role !== "ADMIN") {
      throw new ForbiddenException("Only admins can create organizations");
    }

    // Check if slug already exists
    const existing = await this.prisma.organization.findUnique({
      where: { slug: input.slug },
    });

    if (existing) {
      throw new ForbiddenException(
        `Organization with slug "${input.slug}" already exists`,
      );
    }

    const org = await this.prisma.organization.create({
      data: {
        name: input.name,
        slug: input.slug,
        website: input.website || null,
        createdById: user.id,
        status: ResourceStatus.PENDING,
        revision: 0,
      },
    });

    // Create initial OWNER membership for creator
    await this.prisma.organizationMember.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        role: "OWNER",
        status: ResourceStatus.ACTIVE,
        joinedAt: new Date(),
      },
    });

    // Log audit event
    await this.createAuditLog(user, "CREATE", "Organization", org.id, {
      name: org.name,
      slug: org.slug,
      website: org.website,
    });

    return this.toResponseDto(org);
  }

  async updateOrganization(
    user: AuthenticatedUser,
    organizationId: string,
    input: UpdateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    const current = await this.getVisibleOrganization(user, organizationId);
    if (current.archivedAt || current.deletedAt) {
      throw new ConflictException(
        "Organization is archived; restore it before changing its profile",
        current.revision,
      );
    }

    // Attempt optimistic update with revision check
    const updated = await this.prisma.organization.updateMany({
      where: {
        id: organizationId,
        revision: input.expectedRevision,
      },
      data: {
        ...(input.name && { name: input.name }),
        ...(input.website !== undefined && { website: input.website || null }),
        revision: input.expectedRevision + 1,
      },
    });

    // If no records were updated, the revision didn't match
    if (updated.count === 0) {
      const current = await this.prisma.organization.findUnique({
        where: { id: organizationId },
      });
      if (!current) {
        throw new NotFoundException(
          `Organization with ID "${organizationId}" not found`,
        );
      }
      throw new ConflictException(
        "Organization has been modified by another request. Please refresh and retry.",
        current.revision,
      );
    }

    const result = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });

    // Log audit event
    await this.createAuditLog(user, "UPDATE", "Organization", organizationId, {
      changes: input,
      revision: result.revision,
    });

    return this.toResponseDto(result);
  }

  async getOrganization(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<OrganizationResponseDto> {
    const org = await this.getVisibleOrganization(user, organizationId);
    const issuerCount = await this.prisma.issuer.count({
      where: { organizationId },
    });

    return {
      ...this.toResponseDto(org),
      issuerCount,
    };
  }

  /**
   * Current quota usage and reset context. Same access rule as
   * {@link getOrganization}: the creator or an ADMIN. Counts and limits only —
   * no resource identifiers.
   */
  async getUsage(user: AuthenticatedUser, organizationId: string) {
    const org = await this.getOrganizationById(organizationId);
    if (user.role !== "ADMIN" && org.createdById !== user.id) {
      throw new ForbiddenException(
        "You do not have permission to access this organization",
      );
    }
    return this.quotas.getUsage(organizationId);
  }

  async listOrganizations(
    user: AuthenticatedUser,
    query: ListOrganizationsDto,
  ): Promise<{
    items: OrganizationResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) {
      where.status = query.status;
    }

    // Non-admins see:
    // 1. Organizations they created
    // 2. Organizations where they are members
    if (user.role !== "ADMIN") {
      where.OR = [
        { createdById: user.id },
        { members: { some: { userId: user.id } } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.organization.count({ where }),
    ]);

    const response = await Promise.all(
      items.map(async (org) => {
        const issuerCount = await this.prisma.issuer.count({
          where: { organizationId: org.id },
        });
        return {
          ...this.toResponseDto(org),
          issuerCount,
        };
      }),
    );

    return {
      items: response,
      total,
      page,
      limit,
    };
  }

  async deleteOrganization(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<void> {
    await this.getVisibleOrganization(user, organizationId);

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { status: ResourceStatus.DELETED },
    });

    await this.createAuditLog(user, "DELETE", "Organization", organizationId, {
      deletedAt: new Date().toISOString(),
    });
  }

  async getOrganizationById(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org) {
      throw new NotFoundException(
        `Organization with ID "${organizationId}" not found`,
      );
    }

    return org;
  }

  /**
   * Fetch organization with membership-aware authorization.
   * A user can view an organization if they are:
   * - A global admin
   * - The creator
   * - A member (any role)
   * Non-authorized users receive 404 (information hiding).
   */
  private async getVisibleOrganization(
    user: AuthenticatedUser,
    organizationId: string,
  ) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org) {
      throw new NotFoundException("Organization not found");
    }

    // Check authorization
    if (user.role === "ADMIN") {
      return org;
    }

    if (org.createdById === user.id) {
      return org;
    }

    // Check membership
    const canView = await this.membersService.canViewOrganization(
      user,
      organizationId,
    );
    if (!canView) {
      throw new NotFoundException("Organization not found");
    }

    return org;
  }

  private toResponseDto(org: any): OrganizationResponseDto {
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      website: org.website,
      status: org.status,
      revision: org.revision,
      createdById: org.createdById,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
      lifecycleState: lifecycleStateOf({
        archivedAt: org.archivedAt ?? null,
        deletedAt: org.deletedAt ?? null,
      }),
      archivedAt: org.archivedAt ?? null,
      legalHold: Boolean(org.legalHoldAt),
      deletedAt: org.deletedAt ?? null,
    };
  }

  private createAuditLog(
    user: AuthenticatedUser,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: any,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action,
        resourceType,
        resourceId,
        metadata,
        createdAt: new Date(),
      },
    });
  }
}
