import { applyDecorators, SetMetadata, Type } from "@nestjs/common";
import { ApiExtension } from "@nestjs/swagger";

export const AUTHORIZATION_POLICY_METADATA =
  "earnproof:authorization-policy";

export type AuthorizationAccess = "public" | "authenticated";
export type AuthorizationOwnership = "none" | "user";

export interface AuthorizationPolicy {
  access: AuthorizationAccess;
  ownership: AuthorizationOwnership;
  roles: readonly string[];
}

export type AuthorizationPolicyInput = Partial<
  Omit<AuthorizationPolicy, "access">
> & {
  access: AuthorizationAccess;
};

const PUBLIC_POLICY: AuthorizationPolicy = {
  access: "public",
  ownership: "none",
  roles: [],
};

export function AuthorizationPolicy(
  policy: AuthorizationPolicyInput,
): MethodDecorator & ClassDecorator {
  const normalizedPolicy: AuthorizationPolicy = {
    access: policy.access,
    ownership: policy.ownership ?? "none",
    roles: policy.roles ?? [],
  };

  return applyDecorators(
    SetMetadata(AUTHORIZATION_POLICY_METADATA, normalizedPolicy),
    ApiExtension("x-authorization-policy", normalizedPolicy),
  );
}

export function PublicRoute(): MethodDecorator & ClassDecorator {
  return AuthorizationPolicy(PUBLIC_POLICY);
}

export function AuthenticatedRoute(
  options: Omit<AuthorizationPolicyInput, "access"> = {},
): MethodDecorator & ClassDecorator {
  return AuthorizationPolicy({
    access: "authenticated",
    ...options,
  });
}

export function getAuthorizationPolicy(
  target: Type<unknown> | object,
  propertyKey?: string | symbol,
): AuthorizationPolicy | undefined {
  if (propertyKey === undefined) {
    return Reflect.getMetadata(AUTHORIZATION_POLICY_METADATA, target);
  }

  const handler = (target as Record<string | symbol, unknown>)[propertyKey];

  return (
    Reflect.getMetadata(AUTHORIZATION_POLICY_METADATA, target, propertyKey) ??
    Reflect.getMetadata(
      AUTHORIZATION_POLICY_METADATA,
      handler as object,
    ) ??
    Reflect.getMetadata(
      AUTHORIZATION_POLICY_METADATA,
      (target as { constructor: Type<unknown> }).constructor,
    )
  );
}
