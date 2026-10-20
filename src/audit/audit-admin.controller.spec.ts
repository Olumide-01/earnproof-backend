import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { AuditAdminController } from "./audit-admin.controller";
import { AuditAdminService } from "./audit-admin.service";
import { AuditVerificationService } from "./audit-verification.service";

describe("AuditAdminController", () => {
  let controller: AuditAdminController;
  let adminService: AuditAdminService;
  let verificationService: AuditVerificationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditAdminController],
      providers: [
        { provide: AuditAdminService, useValue: { list: jest.fn(), export: jest.fn() } },
        { provide: AuditVerificationService, useValue: { verifyChain: jest.fn() } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .overrideGuard(RoleGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get(AuditAdminController);
    adminService = module.get(AuditAdminService);
    verificationService = module.get(AuditVerificationService);
  });

  it("list delegates to AuditAdminService.list with the query", async () => {
    const query = { organizationId: "org-1", limit: 20 } as never;
    jest.spyOn(adminService, "list").mockResolvedValue({
      data: [],
      pageInfo: { hasMore: false, nextCursor: null },
    });

    const result = await controller.list(query);

    expect(adminService.list).toHaveBeenCalledWith(query);
    expect(result.data).toEqual([]);
  });

  it("export delegates to AuditAdminService.export with the query", async () => {
    const query = {
      organizationId: "org-1",
      createdFrom: "2026-01-01T00:00:00.000Z",
      createdTo: "2026-01-02T00:00:00.000Z",
    } as never;
    jest.spyOn(adminService, "export").mockResolvedValue({
      records: [],
      truncated: false,
    });

    const result = await controller.export(query);

    expect(adminService.export).toHaveBeenCalledWith(query);
    expect(result.truncated).toBe(false);
  });

  it("verify delegates to AuditVerificationService.verifyChain with the organizationId param", async () => {
    jest.spyOn(verificationService, "verifyChain").mockResolvedValue({
      chainKey: "org-1",
      ok: true,
      recordsChecked: 0,
      firstSequenceChecked: null,
      lastSequenceChecked: null,
      retentionTruncated: false,
      break: null,
    });

    const result = await controller.verify({ organizationId: "org-1" });

    expect(verificationService.verifyChain).toHaveBeenCalledWith("org-1");
    expect(result.ok).toBe(true);
  });
});

describe("AuditAdminController authorization (RoleGuard, no override)", () => {
  function makeContext(role: string): ExecutionContext {
    const request = { user: { id: "u1", role } };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => AuditAdminController.prototype.list,
    } as unknown as ExecutionContext;
  }

  it("rejects a non-admin caller (negative authorization)", () => {
    const guard = new RoleGuard();
    expect(() => guard.canActivate(makeContext("ISSUER"))).toThrow(
      ForbiddenException,
    );
  });

  it("allows an admin caller (positive authorization)", () => {
    const guard = new RoleGuard();
    expect(guard.canActivate(makeContext("ADMIN"))).toBe(true);
  });
});
