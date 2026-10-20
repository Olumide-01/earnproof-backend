import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";
import { RequestIdInterceptor } from "./common/interceptors/request-id.interceptor";
import { RequestContextMiddleware } from "./common/logger/request-context.middleware";
import {
  GLOBAL_BODY_LIMIT_BYTES,
  ROUTE_BODY_LIMITS,
} from "./common/limits/request-limits";
import { requestShapeMiddleware } from "./common/middleware/request-shape.middleware";

/**
 * The HTTP-level configuration of the application.
 *
 * Extracted from `main.ts` so that the pipeline a request actually meets —
 * body limits, structural limits, the validation pipe, the error envelope — can
 * be exercised by tests. Configuration that only exists inside `bootstrap()`
 * is configuration nothing can assert, and request limits are exactly the kind
 * of thing that gets silently dropped in a refactor and noticed during an
 * incident.
 *
 * Order is load-bearing and is the reason this is one function rather than a
 * handful of calls at the call site:
 *
 * 1. **Body parsing, with a limit.** Refuses an oversized body while it is
 *    still bytes arriving on a socket. Nothing downstream ever sees it.
 * 2. **Structural limits.** The first thing to look at a parsed body, before
 *    guards do database work and before class-transformer walks it.
 * 3. Security headers and CORS.
 * 4. Interceptors, then the exception filter, then validation — unchanged.
 */
export interface AppConfiguration {
  /** Allowed CORS origin. Omitted in tests that do not exercise CORS. */
  readonly corsOrigin?: string;
}

export function configureApp(
  app: INestApplication,
  config: AppConfiguration = {},
): void {
  app.setGlobalPrefix("api/v1");

  // ── Body limits ──────────────────────────────────────────────────────────
  // Mounted per prefix, longest first, then a global parser. body-parser skips
  // a request whose body another parser already read, so the first matching
  // mount is the one that applies — which is how the unauthenticated auth
  // endpoints get a tighter limit than the one endpoint that legitimately
  // accepts a document.
  for (const route of [...ROUTE_BODY_LIMITS].sort(
    (a, b) => b.prefix.length - a.prefix.length,
  )) {
    app.use(route.prefix, json({ limit: route.bytes }));
    app.use(route.prefix, urlencoded({ extended: false, limit: route.bytes }));
  }

  app.use(json({ limit: GLOBAL_BODY_LIMIT_BYTES }));
  app.use(urlencoded({ extended: false, limit: GLOBAL_BODY_LIMIT_BYTES }));

  // ── Structural limits ────────────────────────────────────────────────────
  app.use(requestShapeMiddleware);

  // ── Request context middleware (must run after structural limits but before
  //    other middleware, to establish AsyncLocalStorage for request/user IDs).
  app.use((req: any, res: any, next: any) =>
    new RequestContextMiddleware().use(req, res, next),
  );

  app.use(helmet());

  if (config.corsOrigin) {
    app.enableCors({
      origin: config.corsOrigin,
      credentials: true,
      exposedHeaders: ["x-request-id"],
    });
  }

  // ── Request-ID interceptor (must run before the exception filter so that
  //    req.requestId is populated when an error is thrown by a guard or pipe).
  app.useGlobalInterceptors(
    new RequestIdInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector)),
  );

  // ── Global exception filter — converts every thrown error to ApiErrorDto.
  //    Registered after interceptors so it can read req.requestId.
  app.useGlobalFilters(new GlobalExceptionFilter());

  // ── Validation pipe — forbids unknown fields, enables implicit type coercion.
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
}
