import { SetMetadata } from "@nestjs/common";

/**
 * Decorator to specify required role for an endpoint.
 * Must be used with @UseGuards(AuthGuard, RoleGuard)
 * Usage: @RequiredRole('ADMIN')
 */
export const RequiredRole = (role: string | string[]) => SetMetadata("requiredRole", role);
