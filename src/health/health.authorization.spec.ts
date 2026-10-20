import { ApiKeyScope } from "@prisma/client";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { ScopesGuard } from "../common/guards/scopes.guard";
import { HealthController } from "./health.controller";

/**
 * Authorization wiring for the health endpoints.
 *
 * These assertions read the decorator metadata rather than issuing HTTP
 * requests, because the risk being guarded against is that someone removes a
 * @UseGuards line. A test that mocked the guards away would keep passing
 * through exactly that mistake.
 */
describe("health endpoint authorization", () => {
  const handlerOf = (name: string): object =>
    HealthController.prototype[name as keyof HealthController] as object;

  const guardsFor = (handler: string): unknown[] =>
    (Reflect.getMetadata("__guards__", handlerOf(handler)) as unknown[]) ?? [];

  const scopesFor = (handler: string): ApiKeyScope[] =>
    (Reflect.getMetadata("requiredScopes", handlerOf(handler)) as
      | ApiKeyScope[]
      | undefined) ?? [];

  describe("public probes", () => {
    it.each([
      "getHealth",
      "getLiveness",
      "getReadiness",
      "getDeploymentMetadata",
    ])(
      "%s stays unauthenticated so orchestrators can poll it",
      (handler) => {
        // Load balancers and kubelets cannot present an API key. Requiring one
        // here would make every probe fail closed and the service look dead.
        expect(guardsFor(handler)).toHaveLength(0);
        expect(scopesFor(handler)).toHaveLength(0);
      },
    );
  });

  describe("diagnostics", () => {
    it("requires API key authentication and scope enforcement", () => {
      const guards = guardsFor("getDiagnostics");

      expect(guards).toContain(ApiKeyGuard);
      expect(guards).toContain(ScopesGuard);
    });

    it("requires the ORG_ADMIN scope", () => {
      // Diagnostics enumerates every dependency and its state, which is useful
      // reconnaissance; it is gated at the highest existing scope rather than
      // being merely authenticated.
      expect(scopesFor("getDiagnostics")).toEqual([ApiKeyScope.ORG_ADMIN]);
    });
  });
});
