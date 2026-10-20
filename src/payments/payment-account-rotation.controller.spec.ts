import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ValidationPipe } from "@nestjs/common";
import { buildAuthorizationMatrix } from "../common/guards/authorization-policy.registry";
import { AuthGuard } from "../common/guards/auth.guard";
import { RequestPaymentAccountRotationDto } from "./dto/payment-account-rotation.dto";
import { PaymentAccountRotationController } from "./payment-account-rotation.controller";

describe("PaymentAccountRotationController", () => {
  it("declares user-owned, authenticated policies on every route", () => {
    const matrix = buildAuthorizationMatrix([PaymentAccountRotationController]);
    expect(matrix.map((entry) => `${entry.httpMethod} ${entry.path}`).sort()).toEqual([
      "GET /payments/account-rotations/:id",
      "GET /payments/account-rotations/current",
      "POST /payments/account-rotations/",
      "POST /payments/account-rotations/:id/activate",
      "POST /payments/account-rotations/:id/cancel",
      "POST /payments/account-rotations/:id/rollback",
      "POST /payments/account-rotations/:id/verify",
    ]);
    for (const entry of matrix) {
      expect(entry.policy).toEqual({ access: "authenticated", ownership: "user", roles: [] });
    }
  });

  it("requires authentication", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PaymentAccountRotationController)).toEqual([AuthGuard]);
  });

  it("declares /current before /:id so it is not shadowed", () => {
    const names = Object.getOwnPropertyNames(PaymentAccountRotationController.prototype);
    expect(names.indexOf("current")).toBeLessThan(names.indexOf("get"));
  });

  it("always passes the authenticated user, never a client-supplied id", async () => {
    const service = { activate: jest.fn().mockResolvedValue({}) };
    const controller = new PaymentAccountRotationController(service as never);
    const user = { id: "user-1" } as never;
    await controller.activate(user, "rot-1", { expectedVersion: 3 });
    expect(service.activate).toHaveBeenCalledWith(user, "rot-1", 3);
  });

  describe("request validation", () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const validate = (body: unknown) =>
      pipe.transform(body, { type: "body", metatype: RequestPaymentAccountRotationDto });

    it("rejects an extra secret-bearing field outright instead of dropping it", async () => {
      await expect(
        validate({ network: "testnet", newAccountId: "G".padEnd(56, "A"), secretKey: "S".padEnd(56, "A") }),
      ).rejects.toMatchObject({ response: { message: ["property secretKey should not exist"] } });
    });

    it("rejects an unknown network name", async () => {
      await expect(validate({ network: "devnet", newAccountId: "G".padEnd(56, "A") })).rejects.toBeDefined();
    });
  });
});
