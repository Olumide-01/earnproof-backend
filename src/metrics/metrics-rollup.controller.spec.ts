import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Logger } from "@nestjs/common";
import { buildAuthorizationMatrix } from "../common/guards/authorization-policy.registry";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { MetricsRollupJob } from "../jobs/metrics-rollup.job";
import { MetricsRollupController } from "./metrics-rollup.controller";

describe("MetricsRollupController", () => {
  it("declares an admin-only policy on every route", () => {
    const matrix = buildAuthorizationMatrix([MetricsRollupController]);
    expect(matrix.map((entry) => `${entry.httpMethod} ${entry.path}`).sort()).toEqual([
      "GET /metrics/rollups/",
      "GET /metrics/rollups/status",
    ]);
    for (const entry of matrix) {
      expect(entry.policy).toEqual({ access: "authenticated", ownership: "none", roles: ["ADMIN"] });
    }
  });

  it("is guarded by authentication and the role guard", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MetricsRollupController)).toEqual([AuthGuard, RoleGuard]);
  });

  it.each(["query", "status"])("requires the ADMIN role on %s", (handler) => {
    const method = MetricsRollupController.prototype[handler as keyof MetricsRollupController];
    expect(Reflect.getMetadata("requiredRole", method)).toBe("ADMIN");
  });

  it("parses ISO bounds before delegating", async () => {
    const service = { query: jest.fn().mockResolvedValue({}), status: jest.fn() };
    const controller = new MetricsRollupController(service as never);
    await controller.query({
      tier: "HOUR",
      metric: "http_requests_total",
      from: "2030-01-01T00:00:00.000Z",
      to: "2030-01-02T00:00:00.000Z",
    });
    expect(service.query).toHaveBeenCalledWith({
      tier: "HOUR",
      metric: "http_requests_total",
      fromMs: Date.parse("2030-01-01T00:00:00.000Z"),
      toMs: Date.parse("2030-01-02T00:00:00.000Z"),
    });
  });
});

describe("MetricsRollupJob", () => {
  it("logs and swallows failures so the scheduler keeps running", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const failing = jest.fn().mockRejectedValue(new TypeError("boom"));
    const job = new MetricsRollupJob({ collect: failing, rollup: failing, cleanup: failing } as never);

    await expect(job.collect()).resolves.toBeUndefined();
    await expect(job.aggregate()).resolves.toBeUndefined();
    await expect(job.retention()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(3);
    expect(error.mock.calls[0][0]).toBe("Metrics rollup collect failed: TypeError");
    error.mockRestore();
  });
});
