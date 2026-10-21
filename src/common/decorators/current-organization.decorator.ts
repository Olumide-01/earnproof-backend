import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { Request } from "express";
import { AuthenticatedUser } from "../../auth/auth.types";

export const CurrentOrganization = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context.switchToHttp().getRequest<Request & { organizationId?: string; user?: AuthenticatedUser & { organizationId?: string } }>();
    return request.organizationId || request.user?.organizationId;
  },
);
