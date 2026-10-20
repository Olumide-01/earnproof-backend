import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Request } from "express";
import { AuthenticatedUser } from "../../auth/auth.types";
import { OrganizationMembersService } from "../organization-members.service";
import { OrganizationMemberRole } from "@prisma/client";

/**
 * Organization membership guard.
 * Validates that user has required role in the specified organization.
 * 
 * Usage: @UseGuards(AuthGuard, OrganizationMemberGuard)
 *        @RequiredOrganizationRole('OWNER')
 * 
 * The organization ID is extracted from route parameters (id or organizationId).
 */
@Injectable()
export class OrganizationMemberGuard implements CanActivate {
  constructor(private readonly membersService: OrganizationMembersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser;

    // Global admins bypass all checks
    if (user.role === "ADMIN") {
      return true;
    }

    const requiredRole = Reflect.getMetadata(
      "requiredOrganizationRole",
      context.getHandler(),
    );

    // If no role is required, allow access
    if (!requiredRole) {
      return true;
    }

    // Extract organization ID from route parameters
    const organizationId = this.extractOrganizationId(request);
    if (!organizationId) {
      throw new NotFoundException("Organization ID not found in request");
    }

    // Get user's role in the organization
    const userRole = await this.membersService.getMemberRole(
      user.id,
      organizationId,
    );

    if (!userRole) {
      throw new ForbiddenException(
        "You are not a member of this organization",
      );
    }

    // Check if user's role satisfies the requirement
    if (!this.hasRequiredRole(userRole, requiredRole)) {
      throw new ForbiddenException(
        `This action requires ${requiredRole} role in the organization`,
      );
    }

    return true;
  }

  /**
   * Determine if a user role satisfies the required role.
   * Role hierarchy: OWNER > ADMIN > MEMBER > VIEWER
   */
  private hasRequiredRole(
    userRole: OrganizationMemberRole,
    requiredRole: OrganizationMemberRole,
  ): boolean {
    const roleHierarchy: Record<OrganizationMemberRole, number> = {
      OWNER: 4,
      ADMIN: 3,
      MEMBER: 2,
      VIEWER: 1,
    };

    return roleHierarchy[userRole] >= roleHierarchy[requiredRole];
  }

  /**
   * Extract organization ID from route parameters.
   * Tries common parameter names: id, organizationId, orgId
   */
  private extractOrganizationId(request: Request): string | null {
    const params = request.params as Record<string, string>;
    return (
      params.organizationId ||
      params.id ||
      params.orgId ||
      null
    );
  }
}
