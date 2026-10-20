import { GUARDS_METADATA } from "@nestjs/common/constants";
import { buildAuthorizationMatrix } from "../common/guards/authorization-policy.registry";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { ConfigRolloutController } from "./config-rollout.controller";

describe("ConfigRolloutController", () => {
  const handlers = [
    "capture",
    "import",
    "compare",
    "getSnapshot",
    "create",
    "get",
    "gate",
    "promote",
    "rollback",
    "cohort",
  ] as const;

  it("declares an admin-only policy on every route", () => {
    const matrix = buildAuthorizationMatrix([ConfigRolloutController]);
    expect(matrix).toHaveLength(handlers.length);
    for (const entry of matrix) {
      expect(entry.policy).toEqual({ access: "authenticated", ownership: "none", roles: ["ADMIN"] });
    }
  });

  it("is guarded by authentication and the role guard", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ConfigRolloutController)).toEqual([AuthGuard, RoleGuard]);
  });

  it.each(handlers)("requires the ADMIN role on %s", (handler) => {
    expect(Reflect.getMetadata("requiredRole", ConfigRolloutController.prototype[handler])).toBe("ADMIN");
  });

  it("declares the compare route before the :id route so it is not shadowed", () => {
    const paths = buildAuthorizationMatrix([ConfigRolloutController]).map((entry) => entry.path);
    expect(paths.indexOf("/deployments/config/snapshots/compare")).toBeLessThan(
      paths.indexOf("/deployments/config/snapshots/:id"),
    );
  });

  it("converts gate timestamps before delegating", async () => {
    const service = { recordGate: jest.fn().mockResolvedValue({}) };
    const controller = new ConfigRolloutController(service as never);
    const user = { id: "admin-1" } as never;
    await controller.gate(user, "r1", {
      expectedVersion: 2,
      stageIndex: 0,
      checks: [{ name: "readiness", passed: true, observedAt: "2030-01-01T00:00:00.000Z" }],
    });
    expect(service.recordGate).toHaveBeenCalledWith(user, "r1", {
      expectedVersion: 2,
      stageIndex: 0,
      checks: [{ name: "readiness", passed: true, observedAtMs: Date.parse("2030-01-01T00:00:00.000Z") }],
    });
  });
});
