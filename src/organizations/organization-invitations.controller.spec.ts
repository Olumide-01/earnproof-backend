import { Test, TestingModule } from "@nestjs/testing";
import { OrganizationInvitationStatus, OrganizationMemberRole } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { AuthGuard } from "../common/guards/auth.guard";
import { InvitationsController } from "./invitations.controller";
import { OrganizationInvitationsController } from "./organization-invitations.controller";
import { OrganizationInvitationsService } from "./organization-invitations.service";
import { OrganizationMemberGuard } from "./guards/organization-member.guard";

describe("OrganizationInvitationsController and InvitationsController", () => {
  let orgController: OrganizationInvitationsController;
  let publicController: InvitationsController;
  let service: jest.Mocked<OrganizationInvitationsService>;

  const ORG_ID = "org_test_123";
  const INVITATION_ID = "inv_test_123";
  const WALLET_INVITEE = "GA2C5RFPE6GCKMY3Z4BDTJNNCYDCPQDZJNO5ZPBG6R7CQBFE5QDKQ6Y7";

  const adminUser: AuthenticatedUser = {
    id: "user_admin",
    walletAddress: "GBWM4FST7D2Q5YJ6F2R2L3D7Y4Y5W6E7R8T9Y0U1I2O3P4A5S6D7F8G9",
    walletHash: "sha256:admin",
    role: "WORKER",
  };

  const inviteeUser: AuthenticatedUser = {
    id: "user_invitee",
    walletAddress: WALLET_INVITEE,
    walletHash: "sha256:invitee",
    role: "WORKER",
  };

  beforeEach(async () => {
    const mockService = {
      createInvitation: jest.fn(),
      inspectInvitation: jest.fn(),
      acceptInvitation: jest.fn(),
      declineInvitation: jest.fn(),
      revokeInvitation: jest.fn(),
      listInvitations: jest.fn(),
      getInvitation: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationInvitationsController, InvitationsController],
      providers: [
        {
          provide: OrganizationInvitationsService,
          useValue: mockService,
        },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .overrideGuard(OrganizationMemberGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    orgController = module.get<OrganizationInvitationsController>(
      OrganizationInvitationsController,
    );
    publicController = module.get<InvitationsController>(InvitationsController);
    service = module.get(OrganizationInvitationsService);
  });

  describe("OrganizationInvitationsController", () => {
    it("create delegates to service.createInvitation", async () => {
      const mockResult: any = {
        id: INVITATION_ID,
        organizationId: ORG_ID,
        role: OrganizationMemberRole.MEMBER,
        token: `${INVITATION_ID}.secret123`,
      };
      service.createInvitation.mockResolvedValueOnce(mockResult);

      const result = await orgController.create(adminUser, ORG_ID, {
        recipientWalletAddress: WALLET_INVITEE,
        role: OrganizationMemberRole.MEMBER,
      });

      expect(result).toBe(mockResult);
      expect(service.createInvitation).toHaveBeenCalledWith(
        adminUser,
        ORG_ID,
        {
          recipientWalletAddress: WALLET_INVITEE,
          role: OrganizationMemberRole.MEMBER,
        },
      );
    });

    it("list delegates to service.listInvitations", async () => {
      const mockResult: any = { items: [], total: 0, page: 1, limit: 20 };
      service.listInvitations.mockResolvedValueOnce(mockResult);

      const result = await orgController.list(adminUser, ORG_ID, {
        page: 1,
        limit: 20,
      });

      expect(result).toBe(mockResult);
      expect(service.listInvitations).toHaveBeenCalledWith(
        adminUser,
        ORG_ID,
        { page: 1, limit: 20 },
      );
    });

    it("get delegates to service.getInvitation", async () => {
      const mockResult: any = { id: INVITATION_ID, organizationId: ORG_ID };
      service.getInvitation.mockResolvedValueOnce(mockResult);

      const result = await orgController.get(adminUser, ORG_ID, INVITATION_ID);

      expect(result).toBe(mockResult);
      expect(service.getInvitation).toHaveBeenCalledWith(
        adminUser,
        ORG_ID,
        INVITATION_ID,
      );
    });

    it("inspect delegates to service.inspectInvitation", async () => {
      const mockResult: any = { id: INVITATION_ID, organizationId: ORG_ID };
      service.inspectInvitation.mockResolvedValueOnce(mockResult);

      const result = await orgController.inspect(ORG_ID, INVITATION_ID);

      expect(result).toBe(mockResult);
      expect(service.inspectInvitation).toHaveBeenCalledWith(
        INVITATION_ID,
        ORG_ID,
      );
    });

    it("revoke delegates to service.revokeInvitation", async () => {
      const mockResult: any = {
        id: INVITATION_ID,
        status: OrganizationInvitationStatus.REVOKED,
      };
      service.revokeInvitation.mockResolvedValueOnce(mockResult);

      const result = await orgController.revoke(
        adminUser,
        ORG_ID,
        INVITATION_ID,
      );

      expect(result).toBe(mockResult);
      expect(service.revokeInvitation).toHaveBeenCalledWith(
        adminUser,
        ORG_ID,
        INVITATION_ID,
      );
    });

    it("accept delegates to service.acceptInvitation with route organizationId", async () => {
      const mockResult: any = { invitation: {}, membership: {} };
      service.acceptInvitation.mockResolvedValueOnce(mockResult);

      const result = await orgController.accept(
        inviteeUser,
        ORG_ID,
        INVITATION_ID,
        { token: "secret_token" },
      );

      expect(result).toBe(mockResult);
      expect(service.acceptInvitation).toHaveBeenCalledWith(
        inviteeUser,
        { token: "secret_token", organizationId: ORG_ID },
        ORG_ID,
      );
    });

    it("decline delegates to service.declineInvitation with route organizationId", async () => {
      const mockResult: any = { id: INVITATION_ID };
      service.declineInvitation.mockResolvedValueOnce(mockResult);

      const result = await orgController.decline(
        inviteeUser,
        ORG_ID,
        INVITATION_ID,
        { token: "secret_token" },
      );

      expect(result).toBe(mockResult);
      expect(service.declineInvitation).toHaveBeenCalledWith(
        inviteeUser,
        { token: "secret_token", organizationId: ORG_ID },
        ORG_ID,
      );
    });
  });

  describe("InvitationsController (Public / Invitee)", () => {
    it("inspect delegates to service.inspectInvitation", async () => {
      const mockResult: any = { id: INVITATION_ID };
      service.inspectInvitation.mockResolvedValueOnce(mockResult);

      const result = await publicController.inspect({ token: "raw_token" });

      expect(result).toBe(mockResult);
      expect(service.inspectInvitation).toHaveBeenCalledWith("raw_token");
    });

    it("inspectByParam delegates to service.inspectInvitation", async () => {
      const mockResult: any = { id: INVITATION_ID };
      service.inspectInvitation.mockResolvedValueOnce(mockResult);

      const result = await publicController.inspectByParam("raw_token");

      expect(result).toBe(mockResult);
      expect(service.inspectInvitation).toHaveBeenCalledWith("raw_token");
    });

    it("accept delegates to service.acceptInvitation", async () => {
      const mockResult: any = { invitation: {}, membership: {} };
      service.acceptInvitation.mockResolvedValueOnce(mockResult);

      const result = await publicController.accept(inviteeUser, {
        token: "raw_token",
      });

      expect(result).toBe(mockResult);
      expect(service.acceptInvitation).toHaveBeenCalledWith(inviteeUser, {
        token: "raw_token",
      });
    });

    it("decline delegates to service.declineInvitation", async () => {
      const mockResult: any = { id: INVITATION_ID };
      service.declineInvitation.mockResolvedValueOnce(mockResult);

      const result = await publicController.decline(inviteeUser, {
        token: "raw_token",
      });

      expect(result).toBe(mockResult);
      expect(service.declineInvitation).toHaveBeenCalledWith(inviteeUser, {
        token: "raw_token",
      });
    });
  });
});
