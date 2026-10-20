import { ArgumentMetadata, HttpStatus, ValidationPipe } from "@nestjs/common";
import { GUARDS_METADATA, HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { AuthenticatedUser } from "../auth/auth.types";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { IssuerAddressRotationJob } from "../jobs/issuer-address-rotation.job";
import { RequestIssuerAddressRotationDto } from "./dto/issuer-address-rotation.dto";
import { IssuerAddressRotationController } from "./issuer-address-rotation.controller";
import { IssuerAddressRotationService } from "./issuer-address-rotation.service";

const ADMIN: AuthenticatedUser = {
  id: "user_admin",
  walletAddress: "GADMIN",
  walletHash: "sha256:abc",
  role: "ADMIN",
};
const ADDRESS = "GBFXVVSIVZHCSLMZ23N7QDOSFKMCXFQZ7S3KBXCGYZTZZBDSJ2SPCZYZ";

const pipe = new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true });
const validate = (value: unknown) =>
  pipe.transform(value, {
    type: "body",
    metatype: RequestIssuerAddressRotationDto,
    data: "",
  } as ArgumentMetadata);

describe("IssuerAddressRotationController", () => {
  function makeController() {
    const service = {
      requestRotation: jest.fn().mockResolvedValue({ id: "rotation_1" }),
      listForIssuer: jest.fn().mockResolvedValue({ rotations: [], addressHistory: [] }),
      reconcileForIssuer: jest.fn().mockResolvedValue({ id: "rotation_1" }),
    };
    return {
      service,
      controller: new IssuerAddressRotationController(
        service as unknown as IssuerAddressRotationService,
      ),
    };
  }

  it("requires a session and the ADMIN role on every route", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, IssuerAddressRotationController)).toEqual([
      AuthGuard,
      RoleGuard,
    ]);
    for (const name of ["request", "list", "reconcile"] as const) {
      expect(
        Reflect.getMetadata("requiredRole", IssuerAddressRotationController.prototype[name]),
      ).toBe("ADMIN");
    }
  });

  it("answers a request with 202, since confirmation may complete later", () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, IssuerAddressRotationController.prototype.request),
    ).toBe(HttpStatus.ACCEPTED);
  });

  it("delegates with the acting administrator and path identifiers", async () => {
    const { controller, service } = makeController();
    const body = { newStellarAddress: ADDRESS, expectedRevision: 2 };

    await controller.request(ADMIN, "issuer_1", body);
    await controller.list("issuer_1");
    await controller.reconcile(ADMIN, "issuer_1", "rotation_1");

    expect(service.requestRotation).toHaveBeenCalledWith(ADMIN, "issuer_1", body);
    expect(service.listForIssuer).toHaveBeenCalledWith("issuer_1");
    expect(service.reconcileForIssuer).toHaveBeenCalledWith(ADMIN, "issuer_1", "rotation_1");
  });

  describe("request validation", () => {
    it("accepts an address and a non-negative integer revision", async () => {
      await expect(
        validate({ newStellarAddress: ADDRESS, expectedRevision: 0 }),
      ).resolves.toEqual({ newStellarAddress: ADDRESS, expectedRevision: 0 });
    });

    it.each([
      ["a missing revision", { newStellarAddress: ADDRESS }],
      ["a negative revision", { newStellarAddress: ADDRESS, expectedRevision: -1 }],
      ["a fractional revision", { newStellarAddress: ADDRESS, expectedRevision: 1.5 }],
      ["a short address", { newStellarAddress: ADDRESS.slice(1), expectedRevision: 0 }],
      ["an extra field", { newStellarAddress: ADDRESS, expectedRevision: 0, issuerId: "x" }],
    ])("rejects %s", async (_label, body) => {
      await expect(validate(body)).rejects.toThrow();
    });
  });
});

describe("IssuerAddressRotationJob", () => {
  it("reconciles due rotations and never overlaps itself", async () => {
    let release!: () => void;
    const service = {
      reconcileDue: jest.fn(
        () => new Promise<number>((resolve) => (release = () => resolve(2))),
      ),
    };
    const job = new IssuerAddressRotationJob(service as never);

    const first = job.run();
    await expect(job.run()).resolves.toBe(0);
    release();

    await expect(first).resolves.toBe(2);
    expect(service.reconcileDue).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed pass so the schedule keeps running", async () => {
    const job = new IssuerAddressRotationJob({
      reconcileDue: jest.fn().mockRejectedValue(new Error("database unavailable")),
    } as never);

    await expect(job.run()).resolves.toBe(0);
    await expect(job.run()).resolves.toBe(0);
  });
});
