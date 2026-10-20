import { ArgumentMetadata, HttpStatus, ValidationPipe } from "@nestjs/common";
import { GUARDS_METADATA, HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { AuthenticatedUser } from "../auth/auth.types";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { PlaceLegalHoldDto } from "./dto/organization-lifecycle.dto";
import { OrganizationLifecycleController } from "./organization-lifecycle.controller";
import { OrganizationLifecycleService } from "./organization-lifecycle.service";

const ADMIN: AuthenticatedUser = {
  id: "user_admin",
  walletAddress: "GADMIN",
  walletHash: "sha256:abc",
  role: "ADMIN",
};

const pipe = new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true });
const validate = (value: unknown) =>
  pipe.transform(value, { type: "body", metatype: PlaceLegalHoldDto, data: "" } as ArgumentMetadata);

const HANDLERS = [
  "archive",
  "restore",
  "placeLegalHold",
  "releaseLegalHold",
  "getDeletionEligibility",
  "deleteOrganization",
] as const;

describe("OrganizationLifecycleController", () => {
  function makeController() {
    const service = {
      archive: jest.fn().mockResolvedValue({}),
      restore: jest.fn().mockResolvedValue({}),
      placeLegalHold: jest.fn().mockResolvedValue({}),
      releaseLegalHold: jest.fn().mockResolvedValue({}),
      getDeletionEligibility: jest.fn().mockResolvedValue({}),
      deleteOrganization: jest.fn().mockResolvedValue({}),
    };
    return {
      service,
      controller: new OrganizationLifecycleController(
        service as unknown as OrganizationLifecycleService,
      ),
    };
  }

  it("requires a session and the ADMIN role on every route", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OrganizationLifecycleController)).toEqual([
      AuthGuard,
      RoleGuard,
    ]);
    for (const name of HANDLERS) {
      expect(
        Reflect.getMetadata("requiredRole", OrganizationLifecycleController.prototype[name]),
      ).toBe("ADMIN");
    }
  });

  it("answers archive and restore with 200", () => {
    for (const name of ["archive", "restore"] as const) {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, OrganizationLifecycleController.prototype[name]),
      ).toBe(HttpStatus.OK);
    }
  });

  it("passes the acting administrator and organization to every transition", async () => {
    const { controller, service } = makeController();

    await controller.archive(ADMIN, "org_1");
    await controller.restore(ADMIN, "org_1");
    await controller.placeLegalHold(ADMIN, "org_1", { reference: "LEGAL-1" });
    await controller.releaseLegalHold(ADMIN, "org_1");
    await controller.getDeletionEligibility("org_1");
    await controller.deleteOrganization(ADMIN, "org_1");

    expect(service.archive).toHaveBeenCalledWith(ADMIN, "org_1");
    expect(service.restore).toHaveBeenCalledWith(ADMIN, "org_1");
    expect(service.placeLegalHold).toHaveBeenCalledWith(ADMIN, "org_1", "LEGAL-1");
    expect(service.releaseLegalHold).toHaveBeenCalledWith(ADMIN, "org_1");
    expect(service.getDeletionEligibility).toHaveBeenCalledWith("org_1");
    expect(service.deleteOrganization).toHaveBeenCalledWith(ADMIN, "org_1");
  });

  describe("legal hold reference", () => {
    it.each(["LEGAL-2026-014", "Case 42/7", "matter:ab.c#1", "x".repeat(64)])(
      "accepts %p",
      async (reference) => {
        await expect(validate({ reference })).resolves.toEqual({ reference });
      },
    );

    it.each([
      ["empty", ""],
      ["too long", "x".repeat(65)],
      ["leading space", " LEGAL-1"],
      ["an email address", "counsel@example.com"],
      ["markup", "<b>hold</b>"],
      ["missing", undefined],
    ])("rejects %s", async (_label, reference) => {
      await expect(validate({ reference })).rejects.toThrow();
    });

    it("rejects extra fields", async () => {
      await expect(validate({ reference: "LEGAL-1", organizationId: "org_2" })).rejects.toThrow();
    });
  });
});
