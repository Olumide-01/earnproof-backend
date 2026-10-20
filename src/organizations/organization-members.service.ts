import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { OrganizationMemberRole, ResourceStatus } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { SessionService } from "../auth/session.service";
import { AssignOrganizationMemberDto } from "./dto/assign-organization-member.dto";
import { ListOrganizationMembersDto } from "./dto/list-organization-members.dto";
import { OrganizationMemberResponseDto } from "./dto/organization-member-response.dto";
import { UpdateOrganizationMemberRoleDto } from "./dto/update-organization-member-role.dto";

@Injectable()
export class OrganizationMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Assign a user to an organization with a specific role.
   * Only organization owners or admins can assign members.
   */
  async assignMember(
    user: AuthenticatedUser,
    organizationId: string,
    input: AssignOrganizationMemberDto,
  ): Promise<OrganizationMemberResponseDto> {
    // Verify user has permission to manage this organization
    await this.ensureCanManageOrganization(user, organizationId);

    // Verify the user to assign exists
    const targetUser = await this.prisma.user.findUnique({
      where: { id: input.userId },
    });
    if (!targetUser) {
      throw new NotFoundException(`User with ID "${input.userId}" not found`);
    }

    // Check if member already exists
    const existing = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: input.userId },
      },
    });

    if (existing) {
      throw new ConflictException(
        `User is already a member of this organization`,
      );
    }

    // Create the membership
    const member = await this.prisma.organizationMember.create({
      data: {
        organizationId,
        userId: input.userId,
        role: input.role,
        status: ResourceStatus.ACTIVE,
        joinedAt: new Date(),
      },
      include: { user: true },
    });

    // Log audit event
    await this.createAuditLog(user, "CREATE", "OrganizationMember", member.id, {
      organizationId,
      userId: input.userId,
      role: input.role,
    });

    return this.toResponseDto(member);
  }

  /**
   * List members of an organization.
   * Non-owners can only see active members they have permission to see.
   */
  async listMembers(
    user: AuthenticatedUser,
    organizationId: string,
    query: ListOrganizationMembersDto,
  ): Promise<{
    items: OrganizationMemberResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    // Verify user has permission to view this organization
    await this.ensureCanViewOrganization(user, organizationId);

    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: any = { organizationId };

    if (query.role) {
      where.role = query.role;
    }

    if (query.status) {
      where.status = query.status;
    }

    const [items, total] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: { user: true },
      }),
      this.prisma.organizationMember.count({ where }),
    ]);

    return {
      items: items.map((m) => this.toResponseDto(m)),
      total,
      page,
      limit,
    };
  }

  /**
   * Update a member's role in an organization.
   * Only organization owners can change roles.
   * Prevents removing or demoting the final owner.
   */
  async updateMemberRole(
    user: AuthenticatedUser,
    organizationId: string,
    memberId: string,
    input: UpdateOrganizationMemberRoleDto,
  ): Promise<OrganizationMemberResponseDto> {
    // Verify user has permission to manage this organization (must be owner)
    await this.ensureIsOrganizationOwner(user, organizationId);

    // Get the member
    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: { user: true },
    });

    if (!member || member.organizationId !== organizationId) {
      throw new NotFoundException("Organization member not found");
    }

    // Prevent demoting/removing the final owner
    if (
      member.role === "OWNER" &&
      input.role !== "OWNER"
    ) {
      const ownerCount = await this.prisma.organizationMember.count({
        where: { organizationId, role: "OWNER" },
      });

      if (ownerCount === 1) {
        throw new ForbiddenException(
          "Cannot demote the final owner. Assign a new owner first.",
        );
      }
    }

    // Update the role
    const updated = await this.prisma.organizationMember.update({
      where: { id: memberId },
      data: { role: input.role },
      include: { user: true },
    });

    // Invalidate affected user's sessions if their role changed
    if (member.role !== input.role) {
      await this.invalidateUserSessions(member.userId);
    }

    // Log audit event
    await this.createAuditLog(user, "UPDATE", "OrganizationMember", memberId, {
      organizationId,
      userId: member.userId,
      oldRole: member.role,
      newRole: input.role,
    });

    return this.toResponseDto(updated);
  }

  /**
   * Remove a member from an organization.
   * Only organization owners can remove members.
   * Prevents removing the final owner.
   */
  async removeMember(
    user: AuthenticatedUser,
    organizationId: string,
    memberId: string,
  ): Promise<void> {
    // Verify user has permission to manage this organization (must be owner)
    await this.ensureIsOrganizationOwner(user, organizationId);

    // Get the member
    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
    });

    if (!member || member.organizationId !== organizationId) {
      throw new NotFoundException("Organization member not found");
    }

    // Prevent removing the final owner
    if (member.role === "OWNER") {
      const ownerCount = await this.prisma.organizationMember.count({
        where: { organizationId, role: "OWNER" },
      });

      if (ownerCount === 1) {
        throw new ForbiddenException(
          "Cannot remove the final owner. Assign a new owner first.",
        );
      }
    }

    // Remove the member
    await this.prisma.organizationMember.delete({
      where: { id: memberId },
    });

    // Invalidate removed user's sessions
    await this.invalidateUserSessions(member.userId);

    // Log audit event
    await this.createAuditLog(user, "DELETE", "OrganizationMember", memberId, {
      organizationId,
      userId: member.userId,
      role: member.role,
    });
  }

  /**
   * Get a member's role in an organization.
   * Returns null if user is not a member.
   */
  async getMemberRole(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationMemberRole | null> {
    const member = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId },
      },
    });

    return member?.role ?? null;
  }

  /**
   * Check if user can perform actions on the organization via membership.
   * Admins or organization owners/admins can perform management actions.
   */
  async canManageOrganization(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<boolean> {
    // Global admins can manage any organization
    if (user.role === "ADMIN") {
      return true;
    }

    // Check organization membership
    const member = await this.getMemberRole(user.id, organizationId);
    return member === "OWNER" || member === "ADMIN";
  }

  /**
   * Check if user can view the organization.
   * Members, creators, and admins can view.
   */
  async canViewOrganization(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<boolean> {
    // Global admins can view any organization
    if (user.role === "ADMIN") {
      return true;
    }

    // Check if creator
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (org?.createdById === user.id) {
      return true;
    }

    // Check organization membership
    const member = await this.getMemberRole(user.id, organizationId);
    return member !== null;
  }

  /**
   * Ensure user can manage the organization (for admin-only operations).
   * Throws ForbiddenException if not permitted.
   */
  private async ensureCanManageOrganization(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<void> {
    const canManage = await this.canManageOrganization(user, organizationId);
    if (!canManage) {
      throw new ForbiddenException(
        "You do not have permission to manage this organization",
      );
    }
  }

  /**
   * Ensure user is organization owner (for critical operations like role changes).
   * Throws ForbiddenException if not permitted.
   */
  private async ensureIsOrganizationOwner(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<void> {
    // Global admins are treated as owners
    if (user.role === "ADMIN") {
      return;
    }

    const member = await this.getMemberRole(user.id, organizationId);
    if (member !== "OWNER") {
      throw new ForbiddenException(
        "Only organization owners can perform this action",
      );
    }
  }

  /**
   * Ensure user can view the organization.
   * Throws NotFoundException if not permitted (same as not found for info hiding).
   */
  private async ensureCanViewOrganization(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<void> {
    const canView = await this.canViewOrganization(user, organizationId);
    if (!canView) {
      throw new NotFoundException("Organization not found");
    }
  }

  /**
   * Invalidate all sessions for a user to enforce role changes immediately.
   */
  private async invalidateUserSessions(userId: string): Promise<void> {
    const sessions = await this.prisma.authSession.findMany({
      where: {
        userId,
        revokedAt: null,
      },
    });

    if (sessions.length > 0) {
      await Promise.all(
        sessions.map((session) =>
          this.prisma.authSession.update({
            where: { id: session.id },
            data: { revokedAt: new Date() },
          }),
        ),
      );
    }
  }

  private toResponseDto(
    member: any & { user?: any },
  ): OrganizationMemberResponseDto {
    return {
      id: member.id,
      organizationId: member.organizationId,
      userId: member.userId,
      walletAddress: member.user?.walletAddress || "",
      role: member.role,
      status: member.status,
      joinedAt: member.joinedAt,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
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
