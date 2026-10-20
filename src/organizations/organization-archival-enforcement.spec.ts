import { ConflictException } from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { ApiKeyService } from "../api-keys/api-key.service";
import { ApiKeysController } from "../api-keys/api-keys.controller";
import { AttestationsService } from "../attestations/attestations.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { IssuersService } from "../issuers/issuers.service";
import { OrganizationLifecycleState } from "./organization-lifecycle.policy";
import { OrganizationsService } from "./organizations.service";

/**
 * Archival disables new privileged operations everywhere an organization's
 * authority is exercised. Each of those paths reads `archivedAt` itself, so
 * each is checked here rather than trusted to a single choke point.
 */

const ADMIN: AuthenticatedUser = {
  id: "user_admin",
  walletAddress: "GADMIN",
  walletHash: `sha256:${"a".repeat(64)}`,
  role: "ADMIN",
};
const ARCHIVED_AT = new Date("2026-01-01T00:00:00.000Z");

describe("organization archival enforcement", () => {
  describe("API key authentication", () => {
    it("only matches keys whose organization is not archived", async () => {
      const prisma = { apiKey: { findFirst: jest.fn().mockResolvedValue(null) } };

      await new ApiKeyService(prisma as never).lookupAndVerifyKey("ak012345", "secret", "org_1");

      expect(prisma.apiKey.findFirst.mock.calls[0][0].where).toMatchObject({
        organizationId: "org_1",
        status: ResourceStatus.ACTIVE,
        organization: { archivedAt: null },
      });
    });
  });

  describe("API key management", () => {
    function controllerFor(org: { id: string; archivedAt: Date | null }) {
      const apiKeyService = {
        createKey: jest.fn().mockResolvedValue({ id: "key_1" }),
        rotateKey: jest.fn().mockResolvedValue({ id: "key_1" }),
        revokeKey: jest.fn().mockResolvedValue(undefined),
        listKeysForOrganization: jest.fn().mockResolvedValue([]),
      };
      const prisma = {
        organization: {
          findFirst: jest.fn().mockResolvedValue(org),
          findMany: jest.fn().mockResolvedValue([org]),
        },
        apiKey: {
          findFirst: jest.fn().mockResolvedValue({ id: "key_1", organizationId: org.id }),
        },
      };
      return {
        apiKeyService,
        prisma,
        controller: new ApiKeysController(apiKeyService as never, prisma as never),
      };
    }

    it("refuses to issue or rotate keys for an archived organization", async () => {
      const { controller, apiKeyService } = controllerFor({ id: "org_1", archivedAt: ARCHIVED_AT });

      await expect(
        controller.createKey(ADMIN, { organizationId: "org_1", name: "ci" } as never),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        controller.rotateKey(ADMIN, "key_1", { organizationId: "org_1" } as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(apiKeyService.createKey).not.toHaveBeenCalled();
      expect(apiKeyService.rotateKey).not.toHaveBeenCalled();
    });

    it("still lets an archived organization list and revoke keys so it can be wound down", async () => {
      const { controller, apiKeyService } = controllerFor({ id: "org_1", archivedAt: ARCHIVED_AT });

      await controller.listKeys(ADMIN, { organizationId: "org_1" } as never);
      await controller.revokeKey(ADMIN, "key_1", { organizationId: "org_1" } as never);

      expect(apiKeyService.listKeysForOrganization).toHaveBeenCalledWith("org_1");
      expect(apiKeyService.revokeKey).toHaveBeenCalled();
    });

    it("never resolves a deleted organization", async () => {
      const { controller, prisma } = controllerFor({ id: "org_1", archivedAt: null });

      await controller.listKeys(ADMIN, { organizationId: "org_1" } as never);

      expect(prisma.organization.findFirst.mock.calls[0][0].where).toMatchObject({
        deletedAt: null,
      });
    });

    it("issues keys normally for a live organization", async () => {
      const { controller, apiKeyService } = controllerFor({ id: "org_1", archivedAt: null });

      await controller.createKey(ADMIN, { organizationId: "org_1", name: "ci" } as never);

      expect(apiKeyService.createKey).toHaveBeenCalled();
    });
  });

  describe("issuers", () => {
    const issuer = {
      id: "issuer_1",
      organizationId: "org_1",
      stellarAddress: "GISSUER",
      status: ResourceStatus.SUSPENDED,
      metadataHash: null,
      publicMetadata: {},
      contractSyncState: "SYNCED",
      contractSyncedStatus: ResourceStatus.SUSPENDED,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    function serviceFor(archivedAt: Date | null) {
      const prisma = {
        organization: {
          findUnique: jest.fn().mockResolvedValue({ id: "org_1", createdById: ADMIN.id, archivedAt }),
        },
        issuer: {
          findUnique: jest.fn().mockResolvedValue(issuer),
          update: jest.fn(async ({ data }) => ({ ...issuer, ...data })),
          create: jest.fn(),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      };
      return { prisma, service: new IssuersService(prisma as never, {} as never) };
    }

    it("refuses to register an issuer for an archived organization", async () => {
      const { service, prisma } = serviceFor(ARCHIVED_AT);

      await expect(
        service.createIssuer(ADMIN, { organizationId: "org_1", stellarAddress: "GNEW" } as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.issuer.create).not.toHaveBeenCalled();
    });

    it("refuses to re-activate an issuer of an archived organization", async () => {
      const { service, prisma } = serviceFor(ARCHIVED_AT);

      await expect(
        service.updateIssuerStatus(ADMIN, "issuer_1", { status: ResourceStatus.ACTIVE }),
      ).rejects.toThrow("Organization is archived; its issuers cannot be activated");
      expect(prisma.issuer.update).not.toHaveBeenCalled();
    });

    it("still lets an archived organization's issuer be revoked", async () => {
      const { service, prisma } = serviceFor(ARCHIVED_AT);

      await service.updateIssuerStatus(ADMIN, "issuer_1", { status: ResourceStatus.REVOKED });

      expect(prisma.issuer.update).toHaveBeenCalled();
    });

    it("re-activates normally for a live organization", async () => {
      const { service, prisma } = serviceFor(null);

      await service.updateIssuerStatus(ADMIN, "issuer_1", { status: ResourceStatus.ACTIVE });

      expect(prisma.issuer.update).toHaveBeenCalled();
    });
  });

  describe("attestations", () => {
    it("refuses to issue an attestation for an archived organization's issuer", async () => {
      const prisma = {
        issuer: {
          findUnique: jest.fn().mockResolvedValue({
            id: "issuer_1",
            status: ResourceStatus.ACTIVE,
            organizationId: "org_1",
            organization: { archivedAt: ARCHIVED_AT },
          }),
        },
        $transaction: jest.fn(),
      };

      await expect(
        new AttestationsService(prisma as never).createAttestation(ADMIN, "issuer_1", {
          subjectWalletHash: `sha256:${"b".repeat(64)}`,
          type: "PAYMENT",
          signedPayload: {},
        } as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("organization profile", () => {
    const org = {
      id: "org_1",
      name: "Acme",
      slug: "acme",
      website: null,
      status: ResourceStatus.ACTIVE,
      createdById: ADMIN.id,
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: ARCHIVED_AT,
      legalHoldAt: null,
      legalHoldReference: null,
      deletedAt: null,
    };

    it("refuses profile changes while archived", async () => {
      const prisma = {
        organization: { findFirst: jest.fn().mockResolvedValue(org), update: jest.fn() },
        auditLog: { create: jest.fn() },
      };

      await expect(
        new OrganizationsService(prisma as never).updateOrganization(ADMIN, "org_1", {
          name: "Renamed",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.organization.update).not.toHaveBeenCalled();
    });

    it("reports the lifecycle state and legal hold, never the hold reference", async () => {
      const prisma = {
        organization: {
          findFirst: jest.fn().mockResolvedValue({
            ...org,
            legalHoldAt: new Date(),
            legalHoldReference: "CASE-SECRET-7",
          }),
        },
        issuer: { count: jest.fn().mockResolvedValue(0) },
      };

      const view = await new OrganizationsService(prisma as never).getOrganization(ADMIN, "org_1");

      expect(view).toMatchObject({
        lifecycleState: OrganizationLifecycleState.ARCHIVED,
        archivedAt: ARCHIVED_AT,
        legalHold: true,
        deletedAt: null,
      });
      expect(JSON.stringify(view)).not.toContain("CASE-SECRET-7");
    });
  });
});
