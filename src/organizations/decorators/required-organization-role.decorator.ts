import { SetMetadata } from "@nestjs/common";
import { OrganizationMemberRole } from "@prisma/client";

/**
 * Decorator to specify required organization role for an endpoint.
 * Used with OrganizationMemberGuard to enforce authorization.
 * 
 * Usage: @RequiredOrganizationRole('OWNER')
 */
export const RequiredOrganizationRole = (role: OrganizationMemberRole) =>
  SetMetadata("requiredOrganizationRole", role);
