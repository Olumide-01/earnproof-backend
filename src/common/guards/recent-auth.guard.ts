import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { DestructiveAction, RecentAuthService } from "../../auth/recent-auth.service";
import { AuthenticatedSession } from "../../auth/auth.types";

export const RECENT_AUTH_ACTION_KEY = "recentAuthAction";

/**
 * Marks a route as requiring a recent-auth assertion.
 *
 * Usage:
 *   @UseGuards(AuthGuard, RecentAuthGuard)
 *   @RequireRecentAuth(DESTRUCTIVE_ACTIONS.ORG_DELETE)
 *   @Delete(":id")
 *   deleteOrganization(...)
 *
 * The caller must present the assertion token in the `X-Recent-Auth` header.
 * The assertion must have been issued for the exact same action.
 */
export const RequireRecentAuth = (action: DestructiveAction) =>
  SetMetadata(RECENT_AUTH_ACTION_KEY, action);

/**
 * RecentAuthGuard
 *
 * Runs AFTER AuthGuard (session token validated, user attached to request).
 * Checks the `X-Recent-Auth` header for a valid, unexpired, unconsumed
 * assertion that matches:
 *   - the required action (from @RequireRecentAuth decorator)
 *   - the authenticated user
 *   - the request origin
 *
 * The assertion is NOT consumed here — consumption happens inside the
 * controller method after all business logic succeeds, ensuring failed
 * operations never broaden assertion scope.
 *
 * A normal session bearer token cannot substitute for the assertion header —
 * the guard specifically requires `X-Recent-Auth` to be distinct from
 * `Authorization: Bearer`.
 */
@Injectable()
export class RecentAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly recentAuthService: RecentAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<DestructiveAction>(
      RECENT_AUTH_ACTION_KEY,
      context.getHandler(),
    );

    if (!action) {
      // No action bound — guard is a no-op for this route.
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedSession; recentAuthUserId?: string }>();

    // AuthGuard must run first — user must be attached.
    const sessionUser = request.user;
    if (!sessionUser) {
      throw new UnauthorizedException("Authentication required");
    }

    // Extract assertion token from X-Recent-Auth header.
    const assertionToken = this.extractAssertionToken(request);
    if (!assertionToken) {
      throw new UnauthorizedException(
        "A valid recent-auth assertion is required for this operation. " +
        "Re-authenticate via POST /auth/verify and include the assertion " +
        "token in the X-Recent-Auth header.",
      );
    }

    const origin = this.extractOrigin(request);

    // Verify (but do not consume) the assertion.
    const { userId } = await this.recentAuthService.verify({
      token: assertionToken,
      action,
      origin,
    });

    // Cross-check: assertion must belong to the authenticated user.
    if (userId !== sessionUser.id) {
      throw new UnauthorizedException(
        "Recent-auth assertion does not belong to the authenticated user.",
      );
    }

    // Attach for controller use (consumption and resource binding checks).
    request.recentAuthUserId = userId;

    return true;
  }

  private extractAssertionToken(request: Request): string | null {
    const header = request.headers["x-recent-auth"];
    if (typeof header === "string" && header.trim().length > 0) {
      return header.trim();
    }
    return null;
  }

  private extractOrigin(request: Request): string {
    // Use Origin header when present; fall back to a stable placeholder so
    // the hash is consistent across requests in the same client context.
    const origin = request.headers["origin"];
    if (typeof origin === "string" && origin.trim().length > 0) {
      return origin.trim();
    }
    // Fall back to a deterministic placeholder so server-to-server callers
    // without an Origin header are still bound to a consistent value.
    return "null";
  }
}