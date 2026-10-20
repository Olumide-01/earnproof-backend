import { ArgumentMetadata, ValidationPipe } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ResourceStatus, UserRole } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { UpdateAccountStatusDto } from "./dto/update-account-status.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UpdateUserRoleDto } from "./dto/update-user-role.dto";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

const SELF: AuthenticatedUser = {
  id: "user_self",
  walletAddress: "GSELF",
  walletHash: `sha256:${"b".repeat(64)}`,
  role: "WORKER",
};

function makeController() {
  const service = {
    getProfile: jest.fn().mockResolvedValue({ id: SELF.id }),
    updateProfile: jest.fn().mockResolvedValue({ id: SELF.id }),
    getUser: jest.fn().mockResolvedValue({ id: "user_target" }),
    changeStatus: jest.fn().mockResolvedValue({ id: "user_target" }),
    changeRole: jest.fn().mockResolvedValue({ id: "user_target" }),
  };
  return {
    service,
    controller: new UsersController(service as unknown as UsersService),
  };
}

/** The pipe `configureApp` installs, so DTO behaviour matches production. */
const pipe = new ValidationPipe({
  forbidNonWhitelisted: true,
  transform: true,
  whitelist: true,
});

function validate<T>(metatype: new () => T, value: unknown): Promise<T> {
  const metadata: ArgumentMetadata = { type: "body", metatype, data: "" };
  return pipe.transform(value, metadata);
}

describe("UsersController", () => {
  describe("delegation", () => {
    it("reads the profile of the session's user, never a path parameter", async () => {
      const { controller, service } = makeController();

      await controller.getProfile(SELF);

      expect(service.getProfile).toHaveBeenCalledWith(SELF.id);
    });

    it("updates the profile of the session's user", async () => {
      const { controller, service } = makeController();

      await controller.updateProfile(SELF, { displayName: "Ada" });

      expect(service.updateProfile).toHaveBeenCalledWith(SELF.id, { displayName: "Ada" });
    });

    it("passes the acting administrator and the target id to status changes", async () => {
      const { controller, service } = makeController();
      const body = { status: ResourceStatus.SUSPENDED };

      await controller.changeStatus(SELF, "user_target", body);

      expect(service.changeStatus).toHaveBeenCalledWith(SELF, "user_target", body);
    });

    it("passes the acting administrator and the target id to role changes", async () => {
      const { controller, service } = makeController();
      const body = { role: UserRole.DEVELOPER };

      await controller.changeRole(SELF, "user_target", body);

      expect(service.changeRole).toHaveBeenCalledWith(SELF, "user_target", body);
    });

    it("reads an account by id for administrators", async () => {
      const { controller, service } = makeController();

      await controller.getUser("user_target");

      expect(service.getUser).toHaveBeenCalledWith("user_target");
    });
  });

  describe("route protection", () => {
    const handler = (name: keyof UsersController) => UsersController.prototype[name];
    const guards = (name: keyof UsersController) =>
      Reflect.getMetadata(GUARDS_METADATA, handler(name)) as unknown[];
    const requiredRole = (name: keyof UsersController) =>
      Reflect.getMetadata("requiredRole", handler(name));

    it.each(["getProfile", "updateProfile"] as const)(
      "%s requires a session but no role",
      (name) => {
        expect(guards(name)).toEqual([AuthGuard]);
        expect(requiredRole(name)).toBeUndefined();
      },
    );

    it.each(["getUser", "changeStatus", "changeRole"] as const)(
      "%s requires a session and the ADMIN role",
      (name) => {
        expect(guards(name)).toEqual([AuthGuard, RoleGuard]);
        expect(requiredRole(name)).toBe("ADMIN");
      },
    );
  });

  describe("UpdateProfileDto", () => {
    it("accepts and trims a display name", async () => {
      await expect(validate(UpdateProfileDto, { displayName: "  Ada  " })).resolves.toEqual({
        displayName: "Ada",
      });
    });

    it("accepts null to clear the display name", async () => {
      await expect(validate(UpdateProfileDto, { displayName: null })).resolves.toEqual({
        displayName: null,
      });
    });

    it("accepts exactly 64 characters and rejects 65", async () => {
      await expect(
        validate(UpdateProfileDto, { displayName: "x".repeat(64) }),
      ).resolves.toBeDefined();
      await expect(
        validate(UpdateProfileDto, { displayName: "x".repeat(65) }),
      ).rejects.toThrow();
    });

    it("rejects a whitespace-only display name", async () => {
      await expect(validate(UpdateProfileDto, { displayName: "   " })).rejects.toThrow();
    });

    it("rejects markup in the display name", async () => {
      await expect(
        validate(UpdateProfileDto, { displayName: "<script>alert(1)</script>" }),
      ).rejects.toThrow();
    });

    it.each([
      { role: "ADMIN" },
      { status: "ACTIVE" },
      { walletAddress: "GOTHER" },
      { id: "user_other" },
    ])("rejects the non-writable field %p", async (body) => {
      await expect(validate(UpdateProfileDto, body)).rejects.toThrow();
    });
  });

  describe("UpdateAccountStatusDto", () => {
    it.each([ResourceStatus.ACTIVE, ResourceStatus.SUSPENDED, ResourceStatus.REVOKED])(
      "accepts %s",
      async (status) => {
        await expect(validate(UpdateAccountStatusDto, { status })).resolves.toEqual({ status });
      },
    );

    it.each([ResourceStatus.DELETED, ResourceStatus.PENDING, "BANNED", undefined])(
      "rejects %p",
      async (status) => {
        await expect(validate(UpdateAccountStatusDto, { status })).rejects.toThrow();
      },
    );

    it("accepts a bounded reason code and rejects free text", async () => {
      await expect(
        validate(UpdateAccountStatusDto, { status: "SUSPENDED", reason: "FRAUD_SUSPECTED" }),
      ).resolves.toBeDefined();
      await expect(
        validate(UpdateAccountStatusDto, { status: "SUSPENDED", reason: "called us rude names" }),
      ).rejects.toThrow();
    });
  });

  describe("UpdateUserRoleDto", () => {
    it("accepts every declared role", async () => {
      for (const role of Object.values(UserRole)) {
        await expect(validate(UpdateUserRoleDto, { role })).resolves.toEqual({ role });
      }
    });

    it("rejects an unknown role and extra fields", async () => {
      await expect(validate(UpdateUserRoleDto, { role: "SUPERUSER" })).rejects.toThrow();
      await expect(
        validate(UpdateUserRoleDto, { role: "ADMIN", status: "ACTIVE" }),
      ).rejects.toThrow();
    });
  });
});
