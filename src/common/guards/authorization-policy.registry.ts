import { Injectable, RequestMethod, Type } from "@nestjs/common";
import { DiscoveryService, ModulesContainer } from "@nestjs/core";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import {
  AuthorizationPolicy,
  getAuthorizationPolicy,
} from "../decorators/authorization-policy.decorator";

export interface AuthorizationMatrixEntry {
  controller: string;
  method: string;
  path: string;
  httpMethod: string;
  policy: AuthorizationPolicy;
}

export function buildAuthorizationMatrix(
  controllers: readonly Type<unknown>[],
): AuthorizationMatrixEntry[] {
  return controllers.flatMap((controller) => {
    const controllerPath = normalizePath(Reflect.getMetadata(PATH_METADATA, controller) ?? "");
    const prototype = controller.prototype;

    return Object.getOwnPropertyNames(prototype)
      .filter((method) => method !== "constructor")
      .flatMap((method) => {
        const handler = prototype[method] as unknown;
        const routePath = Reflect.getMetadata(PATH_METADATA, handler as object);
        const requestMethod = Reflect.getMetadata(
          METHOD_METADATA,
          handler as object,
        );

        if (routePath === undefined || requestMethod === undefined) {
          return [];
        }

        const policy = getAuthorizationPolicy(prototype, method);
        if (!policy) {
          throw new Error(
            `Controller method ${controller.name}.${method} is missing an explicit authorization policy`,
          );
        }

        return [{
          controller: controller.name,
          method,
          path: joinPaths(controllerPath, normalizePath(routePath)),
          httpMethod: requestMethodName(requestMethod),
          policy,
        }];
      });
  });
}

@Injectable()
export class AuthorizationPolicyRegistry {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly modulesContainer: ModulesContainer,
  ) {}

  getMatrix(): AuthorizationMatrixEntry[] {
    return buildAuthorizationMatrix(this.getControllers());
  }

  private getControllers(): Type<unknown>[] {
    const controllers = this.discoveryService.getControllers();
    const registeredControllers = new Set<Type<unknown>>();

    for (const wrapper of controllers) {
      if (isControllerType(wrapper.metatype)) {
        registeredControllers.add(wrapper.metatype);
      }
    }

    // Reading the modules container keeps this registry usable in Nest test
    // applications where DiscoveryService may not expose all wrappers yet.
    for (const moduleRef of this.modulesContainer.values()) {
      for (const wrapper of moduleRef.controllers.values()) {
        if (isControllerType(wrapper.metatype)) {
          registeredControllers.add(wrapper.metatype);
        }
      }
    }

    return [...registeredControllers];
  }
}

function isControllerType(value: unknown): value is Type<unknown> {
  return typeof value === "function";
}

function normalizePath(path: string | string[]): string {
  return Array.isArray(path) ? path[0] ?? "" : path;
}

function joinPaths(controllerPath: string, routePath: string): string {
  return `/${[controllerPath, routePath]
    .filter(Boolean)
    .join("/")}`.replace(/\/+/g, "/");
}

function requestMethodName(method: number): string {
  return RequestMethod[method] ?? String(method);
}
