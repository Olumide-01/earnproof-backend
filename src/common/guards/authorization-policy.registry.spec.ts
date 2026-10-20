import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiKeysController } from "../../api-keys/api-keys.controller";
import { IntegrationAuthController } from "../../api-keys/integration-auth.controller";
import { AuthController } from "../../auth/auth.controller";
import { CredentialsController } from "../../credentials/credentials.controller";
import { HealthController } from "../../health/health.controller";
import { IssuersController } from "../../issuers/issuers.controller";
import { OrganizationsController } from "../../organizations/organizations.controller";
import { PaymentBackfillsController } from "../../payments/payment-backfills.controller";
import { PaymentsController } from "../../payments/payments.controller";
import { ProofsController } from "../../proofs/proofs.controller";
import { TrustedSourcesController } from "../../trusted-sources/trusted-sources.controller";
import { WebhooksController } from "../../webhooks/webhooks.controller";
import { buildAuthorizationMatrix } from "./authorization-policy.registry";
import {
  AuthenticatedRoute,
  PublicRoute,
} from "../decorators/authorization-policy.decorator";
import { AuthGuard } from "./auth.guard";

@Controller("fixture")
class CompleteController {
  @PublicRoute()
  @Get("public")
  publicRoute() {}

  @AuthenticatedRoute({ ownership: "user" })
  @Post("private")
  privateRoute() {}
}

@Controller("fixture")
class IncompleteController {
  @UseGuards(AuthGuard)
  @Get("unannotated")
  unannotatedRoute() {}
}

describe("authorization policy registry", () => {
  it("covers every application controller method", () => {
    const matrix = buildAuthorizationMatrix([
      ApiKeysController,
      IntegrationAuthController,
      AuthController,
      CredentialsController,
      HealthController,
      IssuersController,
      OrganizationsController,
      PaymentsController,
      PaymentBackfillsController,
      ProofsController,
      TrustedSourcesController,
      WebhooksController,
    ]);

    expect(matrix).toHaveLength(58);
    expect(matrix.every(({ policy }) => policy.access)).toBe(true);
  });

  it("generates a complete matrix with explicit public and authenticated policies", () => {
    expect(buildAuthorizationMatrix([CompleteController])).toEqual([
      expect.objectContaining({
        controller: "CompleteController",
        method: "publicRoute",
        path: "/fixture/public",
        httpMethod: "GET",
        policy: {
          access: "public",
          ownership: "none",
          roles: [],
        },
      }),
      expect.objectContaining({
        controller: "CompleteController",
        method: "privateRoute",
        path: "/fixture/private",
        httpMethod: "POST",
        policy: {
          access: "authenticated",
          ownership: "user",
          roles: [],
        },
      }),
    ]);
  });

  it("rejects a newly added route without an explicit policy", () => {
    expect(() => buildAuthorizationMatrix([IncompleteController])).toThrow(
      "IncompleteController.unannotatedRoute is missing an explicit authorization policy",
    );
  });
});
