import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { buildAuthorizationMatrix } from "../common/guards/authorization-policy.registry";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { PaymentBackfillsController } from "./payment-backfills.controller";

describe("PaymentBackfillsController", () => {
  const admin = {
    id: "admin_1",
    walletAddress: "GADMIN",
    walletHash: "sha256:admin",
    role: "ADMIN",
  } as never;

  function controller() {
    const backfills = {
      createJob: jest.fn().mockResolvedValue({ id: "job_1" }),
      getJob: jest.fn().mockResolvedValue({ id: "job_1" }),
      cancelJob: jest.fn().mockResolvedValue({ id: "job_1" }),
    };
    return { backfills, instance: new PaymentBackfillsController(backfills as never) };
  }

  it("delegates create, get and cancel to the service", async () => {
    const { backfills, instance } = controller();
    const body = { userId: "user_1", startLedger: 100, endLedger: 200 };

    await instance.create(admin, body);
    await instance.get("job_1");
    await instance.cancel(admin, "job_1");

    expect(backfills.createJob).toHaveBeenCalledWith(admin, body);
    expect(backfills.getJob).toHaveBeenCalledWith("job_1");
    expect(backfills.cancelJob).toHaveBeenCalledWith(admin, "job_1");
  });

  it("declares every route as authenticated and ADMIN-only", () => {
    const routes = buildAuthorizationMatrix([PaymentBackfillsController]);

    expect(routes.map((route) => `${route.httpMethod} ${route.path}`).sort()).toEqual([
      "GET /payment-backfills/:id",
      // The registry renders a bare @Post() with a trailing slash.
      "POST /payment-backfills/",
      "POST /payment-backfills/:id/cancel",
    ]);
    for (const route of routes) {
      expect(route.policy).toMatchObject({ access: "authenticated", roles: ["ADMIN"] });
    }
  });

  it("guards the controller with session auth and the role guard", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PaymentBackfillsController)).toEqual([
      AuthGuard,
      RoleGuard,
    ]);
  });

  it.each(["create", "get", "cancel"] as const)(
    "rejects a non-admin session on %s",
    (method) => {
      const handler = PaymentBackfillsController.prototype[method];
      const context = {
        getHandler: () => handler,
        switchToHttp: () => ({
          getRequest: () => ({ user: { id: "user_1", role: "WORKER" } }),
        }),
      } as unknown as ExecutionContext;

      expect(() => new RoleGuard().canActivate(context)).toThrow(ForbiddenException);
    },
  );
});
