import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Request } from "express";
import { AuthenticatedUser } from "../../auth/auth.types";

/**
 * Role-based access control guard.
 * Usage: @UseGuards(AuthGuard, RoleGuard) with @RequiredRole('ADMIN')
 */
@Injectable()
export class RoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser;
    const requiredRole = Reflect.getMetadata(
      "requiredRole",
      context.getHandler(),
    );

    if (!requiredRole) {
      return true;
    }

    if (Array.isArray(requiredRole)) {
      if (!requiredRole.includes(user.role)) {
        throw new ForbiddenException(
          `This action requires one of [${requiredRole.join(", ")}] roles`,
        );
      }
    } else if (user.role !== requiredRole) {
      throw new ForbiddenException(
        `This action requires ${requiredRole} role access`,
      );
    }

    return true;
  }
}
