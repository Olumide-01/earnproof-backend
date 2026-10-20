import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { runWithRequestContext } from "./request-context";
import { REQUEST_ID_HEADER } from "../interceptors/request-id.interceptor";

/**
 * Middleware that establishes the request context for AsyncLocalStorage.
 *
 * Must run AFTER RequestIdInterceptor has populated request.requestId.
 * This middleware ensures the request ID and user ID (if authenticated)
 * are available throughout the entire async call chain.
 *
 * Applied globally in the bootstrap phase (main.ts or app.module.ts).
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Extract request ID: first try req.requestId (set by RequestIdInterceptor),
    // then fall back to the header (in case interceptor hasn't run yet).
    const requestId =
      (req as any).requestId ||
      ((Array.isArray(req.headers[REQUEST_ID_HEADER])
        ? req.headers[REQUEST_ID_HEADER][0]
        : req.headers[REQUEST_ID_HEADER]) as string) ||
      "unknown";

    // Extract user ID if available (from auth context, JWT, etc.)
    // This assumes auth middleware/guard has populated req.user or similar.
    const userId = (req as any).user?.id || (req as any).userId;

    // Run the rest of the request lifecycle with this context.
    // Any async operation spawned during this request will see this context.
    runWithRequestContext({ requestId, userId }, () => {
      next();
    });
  }
}
