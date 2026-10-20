import { NotFoundException } from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { AuthTokenService } from "../auth/auth-token.service";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { OrganizationLifecycleState } from "./organization-lifecycle.policy";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";

describe("OrganizationsController", () => {
  let controller: OrganizationsController;
  let service: OrganizationsService;

  const mockUser = {
    id: "user-1",
    walletAddress: "G1111111111111111111111111111111111111111111111111111111",
    walletHash: "sha256:hash1",
    role: "ADMIN",
  };

  const mockOrganization = {
    id: "org-1",
    name: "Test Organization",
    slug: "test-org",
    website: "https://example.com",
    status: ResourceStatus.PENDING,
    createdById: mockUser.id,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    lifecycleState: OrganizationLifecycleState.LIVE,
    archivedAt: null,
    legalHold: false,
    deletedAt: null,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [
        {
          provide: OrganizationsService,
          useValue: {
            createOrganization: jest.fn(),
            updateOrganization: jest.fn(),
            getOrganization: jest.fn(),
            listOrganizations: jest.fn(),
          },
        },
        {
          provide: AuthTokenService,
          useValue: {
            verify: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .overrideGuard(RoleGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get<OrganizationsController>(OrganizationsController);
    service = module.get<OrganizationsService>(OrganizationsService);
  });

  describe("createOrganization", () => {
    it("should call service and return result", async () => {
      const input = {
        name: "Test Organization",
        slug: "test-org",
        website: "https://example.com",
      };

      jest
        .spyOn(service, "createOrganization")
        .mockResolvedValue(mockOrganization);

      const result = await controller.createOrganization(mockUser, input);

      expect(result).toEqual(mockOrganization);
      expect(service.createOrganization).toHaveBeenCalledWith(mockUser, input);
    });
  });

  describe("updateOrganization", () => {
    it("should call service and return result", async () => {
      const input = { name: "Updated Name" };

      jest.spyOn(service, "updateOrganization").mockResolvedValue({
        ...mockOrganization,
        name: input.name,
      });

      const result = await controller.updateOrganization(
        mockUser,
        "org-1",
        input,
      );

      expect(result.name).toEqual(input.name);
      expect(service.updateOrganization).toHaveBeenCalledWith(
        mockUser,
        "org-1",
        input,
      );
    });
  });

  describe("getOrganization", () => {
    it("should return organization with issuer count", async () => {
      const response = { ...mockOrganization, issuerCount: 2 };
      jest.spyOn(service, "getOrganization").mockResolvedValue(response);

      const result = await controller.getOrganization(mockUser, "org-1");

      expect(result).toEqual(response);
      expect(service.getOrganization).toHaveBeenCalledWith(mockUser, "org-1");
    });

    it("should handle 404 from service", async () => {
      jest
        .spyOn(service, "getOrganization")
        .mockRejectedValue(new NotFoundException());

      await expect(
        controller.getOrganization(mockUser, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("listOrganizations", () => {
    it("should return paginated list", async () => {
      const response = {
        items: [mockOrganization],
        total: 1,
        page: 1,
        limit: 20,
      };

      jest.spyOn(service, "listOrganizations").mockResolvedValue(response);

      const result = await controller.listOrganizations(mockUser, {});

      expect(result).toEqual(response);
      expect(service.listOrganizations).toHaveBeenCalledWith(
        mockUser,
        expect.any(Object),
      );
    });
  });
});
