import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { Observable } from "rxjs";

export const API_DEPRECATION_METADATA =
  "earnproof:api-deprecation";

export interface ApiDeprecationPolicy {
  deprecationAt: Date;
  sunsetAt: Date;
  documentationUrl: string;
}

export interface ApiDeprecationRoutePolicy {
  route: string;
  method?: string;
  policy: ApiDeprecationPolicy;
}

@Injectable()
export class ApiDeprecationInterceptor
  implements NestInterceptor, OnModuleInit
{
  private readonly policies = new Map<
    string,
    ApiDeprecationPolicy
  >();

  private allowedDocumentationOrigins: Set<string> =
    new Set();

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const allowed =
      this.config.get<string[]>(
        "apiDeprecation.allowedDocumentationOrigins",
      ) ?? [];

    this.allowedDocumentationOrigins = new Set(
      allowed.map((origin) => origin.replace(/\/$/, "")),
    );

    const configured =
      this.config.get<ApiDeprecationRoutePolicy[]>(
        "apiDeprecation.routes",
      ) ?? [];

    for (const entry of configured) {
      this.validatePolicy(entry.route, entry.policy);

      const key = this.key(
        entry.method ?? "*",
        entry.route,
      );

      this.policies.set(key, entry.policy);
    }
  }

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const route =
      request.route?.path ??
      request.path ??
      request.url;

    const method =
      String(request.method ?? "GET").toUpperCase();

    const metadata =
      this.reflector.get<ApiDeprecationPolicy | undefined>(
        API_DEPRECATION_METADATA,
        context.getHandler(),
      );

    const policy =
      metadata ??
      this.policies.get(this.key(method, route)) ??
      this.policies.get(this.key("*", route));

    if (policy) {
      response.setHeader(
        "Deprecation",
        `@${Math.floor(policy.deprecationAt.getTime() / 1000)}`,
      );

      response.setHeader(
        "Sunset",
        policy.sunsetAt.toUTCString(),
      );

      response.setHeader(
        "Link",
        `<${policy.documentationUrl}>; rel="deprecation"`,
      );
    }

    return next.handle();
  }

  private key(method: string, route: string): string {
    return `${method.toUpperCase()} ${route}`;
  }

  private validatePolicy(
    route: string,
    policy: ApiDeprecationPolicy,
  ): void {
    if (!route || !route.startsWith("/")) {
      throw new Error(
        `Invalid API deprecation route: ${route}`,
      );
    }

    if (
      !(policy.deprecationAt instanceof Date) ||
      Number.isNaN(policy.deprecationAt.getTime())
    ) {
      throw new Error(
        `Invalid deprecation date for ${route}`,
      );
    }

    if (
      !(policy.sunsetAt instanceof Date) ||
      Number.isNaN(policy.sunsetAt.getTime())
    ) {
      throw new Error(
        `Invalid sunset date for ${route}`,
      );
    }

    if (policy.sunsetAt < policy.deprecationAt) {
      throw new Error(
        `Sunset date must not precede deprecation date for ${route}`,
      );
    }

    let parsed: URL;

    try {
      parsed = new URL(policy.documentationUrl);
    } catch {
      throw new Error(
        `Invalid deprecation documentation URL for ${route}`,
      );
    }

    if (
      parsed.protocol !== "https:" &&
      parsed.protocol !== "http:"
    ) {
      throw new Error(
        `Unsupported deprecation documentation URL scheme for ${route}`,
      );
    }

    const origin = parsed.origin.replace(/\/$/, "");

    if (!this.allowedDocumentationOrigins.has(origin)) {
      throw new Error(
        `Deprecation documentation URL is not allowlisted for ${route}`,
      );
    }
  }
}
