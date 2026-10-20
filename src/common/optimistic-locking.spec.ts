import { Test, TestingModule } from "@nestjs/testing";
import { ResourceStatus } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { OrganizationsService } from "../organizations/organizations.service";
import { IssuersService } from "../issuers/issuers.service";
import { TrustedSourcesService } from "../trusted-sources/trusted-sources.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { ConflictException } from "./exceptions/domain.exceptions";
import { IssuerRegistryService } from "../issuers/issuer-registry.service";
import { PaymentEncryptionKeyringService } from "./crypto/payment-encryption-keyring.service";
import { ConfigService } from "@nestjs/config";
import { WebhookDeliveryService } from "../webhooks/webhook-delivery.service";

describe("Optimistic Concurrency Control", () => {
  let orgsService: OrganizationsService;
  let issuersService: IssuersService;
  let trustedSourcesService: TrustedSourcesService;
  let webhooksService: WebhooksService;
  let prisma: PrismaService;

  const mockAdmin = {
    id: "admin-1",
    walletAddress: "GADMIN1111111111111111111111111111111111111111111111111111",
    walletHash: "sha256:admin",
    role: "ADMIN" as const,
  };

  const mockUser = {
    id: "user-1",
    walletAddress: "GUSER11111111111111111111111111111111111111111111111111111",
    walletHash: "sha256:user",
    role: "WORKER" as const,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        IssuersService,
        TrustedSourcesService,
        WebhooksService,
        {
          provide: PrismaService,
          useValue: {
            organization: {
              create: jest.fn(),
              updateMany: jest.fn(),
              update: jest.fn(),
              findFirst: jest.fn(),
              findUnique: jest.fn(),
              findUniqueOrThrow: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
            },
            issuer: {
              create: jest.fn(),
              updateMany: jest.fn(),
              update: jest.fn(),
              findFirst: jest.fn(),
              findUnique: jest.fn(),
              findUniqueOrThrow: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
            },
            trustedSource: {
              create: jest.fn(),
              updateMany: jest.fn(),
              update: jest.fn(),
              findFirst: jest.fn(),
              findUnique: jest.fn(),
              findUniqueOrThrow: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
            },
            webhook: {
              create: jest.fn(),
              updateMany: jest.fn(),
              update: jest.fn(),
              findFirst: jest.fn(),
              findUnique: jest.fn(),
              findUniqueOrThrow: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
            },
            auditLog: {
              create: jest.fn(),
            },
          },
        },
        {
          provide: IssuerRegistryService,
          useValue: {
            sync: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: WebhookDeliveryService,
          useValue: {
            replay: jest.fn(),
          },
        },
      ],
    }).compile();

    orgsService = module.get<OrganizationsService>(OrganizationsService);
    issuersService = module.get<IssuersService>(IssuersService);
    trustedSourcesService = module.get<TrustedSourcesService>(TrustedSourcesService);
    webhooksService = module.get<WebhooksService>(WebhooksService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe("Organizations - Concurrent Updates", () => {
    it("should fail when revision does not match during update", async () => {
      const org = {
        id: "org-1",
        name: "Original Name",
        slug: "test-org",
        website: "https://example.com",
        status: ResourceStatus.PENDING,
        revision: 2,
        createdById: mockAdmin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(prisma.organization, "findFirst")
        .mockResolvedValue(org);
      jest.spyOn(prisma.organization, "updateMany").mockResolvedValue({
        count: 0,
      });

      const updateInput = {
        expectedRevision: 1,
        name: "Updated Name",
      };

      await expect(
        orgsService.updateOrganization(mockAdmin, "org-1", updateInput),
      ).rejects.toThrow(ConflictException);
    });

    it("should succeed when revision matches and increment revision", async () => {
      const org = {
        id: "org-1",
        name: "Original Name",
        slug: "test-org",
        website: "https://example.com",
        status: ResourceStatus.PENDING,
        revision: 1,
        createdById: mockAdmin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(prisma.organization, "findFirst")
        .mockResolvedValue(org);
      jest.spyOn(prisma.organization, "updateMany").mockResolvedValue({
        count: 1,
      });
      jest
        .spyOn(prisma.organization, "findUniqueOrThrow")
        .mockResolvedValue({
          ...org,
          name: "Updated Name",
          revision: 2,
        });
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const updateInput = {
        expectedRevision: 1,
        name: "Updated Name",
      };

      const result = await orgsService.updateOrganization(
        mockAdmin,
        "org-1",
        updateInput,
      );

      expect(result.revision).toBe(2);
      expect(prisma.organization.updateMany).toHaveBeenCalledWith({
        where: {
          id: "org-1",
          revision: 1,
        },
        data: expect.objectContaining({
          revision: 2,
        }),
      });
    });

    it("should return current revision in ConflictException", async () => {
      const org = {
        id: "org-1",
        name: "Original Name",
        slug: "test-org",
        website: "https://example.com",
        status: ResourceStatus.PENDING,
        revision: 5,
        createdById: mockAdmin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(prisma.organization, "findFirst")
        .mockResolvedValue(org);
      jest.spyOn(prisma.organization, "updateMany").mockResolvedValue({
        count: 0,
      });

      const updateInput = {
        expectedRevision: 3,
        name: "Updated Name",
      };

      try {
        await orgsService.updateOrganization(mockAdmin, "org-1", updateInput);
        fail("Should have thrown ConflictException");
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        const conflictError = error as any;
        expect(conflictError.getResponse().currentRevision).toBe(5);
      }
    });
  });

  describe("Issuers - Concurrent Updates", () => {
    const issuer = {
      id: "issuer-1",
      organizationId: "org-1",
      stellarAddress: "GISSUER1111111111111111111111111111111111111111111111111111",
      status: ResourceStatus.PENDING,
      revision: 1,
      metadataHash: null,
      publicMetadata: null,
      contractSyncState: "PENDING",
      contractSyncedStatus: null,
      contractTransactionHash: null,
      contractSyncedAt: null,
      contractSyncError: null,
      verifiedAt: null,
      suspendedAt: null,
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("should fail when metadata revision does not match", async () => {
      jest.spyOn(prisma.issuer, "findUniqueOrThrow").mockResolvedValue(issuer);
      jest.spyOn(prisma.issuer, "updateMany").mockResolvedValue({
        count: 0,
      });

      const updateInput = {
        expectedRevision: 0,
        publicMetadata: { name: "Test Issuer" },
      };

      await expect(
        issuersService.updateIssuerMetadata(mockAdmin, "issuer-1", updateInput),
      ).rejects.toThrow(ConflictException);
    });

    it("should fail when status revision does not match", async () => {
      jest.spyOn(prisma.issuer, "findUniqueOrThrow").mockResolvedValue(issuer);
      jest.spyOn(prisma.issuer, "updateMany").mockResolvedValue({
        count: 0,
      });

      const updateInput = {
        expectedRevision: 5,
        status: ResourceStatus.ACTIVE,
      };

      await expect(
        issuersService.updateIssuerStatus(mockAdmin, "issuer-1", updateInput),
      ).rejects.toThrow(ConflictException);
    });

    it("should succeed with matching revision and increment", async () => {
      jest.spyOn(prisma.issuer, "findUniqueOrThrow").mockResolvedValue(issuer);
      jest.spyOn(prisma.issuer, "updateMany").mockResolvedValue({
        count: 1,
      });
      jest
        .spyOn(prisma.issuer, "findUniqueOrThrow")
        .mockResolvedValueOnce(issuer)
        .mockResolvedValueOnce({
          ...issuer,
          revision: 2,
        });
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const updateInput = {
        expectedRevision: 1,
        publicMetadata: { name: "Updated Issuer" },
      };

      const result = await issuersService.updateIssuerMetadata(
        mockAdmin,
        "issuer-1",
        updateInput,
      );

      expect(result.revision).toBe(2);
    });
  });

  describe("TrustedSources - Concurrent Updates", () => {
    const trustedSource = {
      id: "ts-1",
      userId: mockUser.id,
      sourceAddress: "GSOURCE1111111111111111111111111111111111111111111111111111",
      displayName: "My Employer",
      sourceType: "stellar",
      issuerId: null,
      status: ResourceStatus.ACTIVE,
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("should fail when revision does not match", async () => {
      jest
        .spyOn(prisma.trustedSource, "findFirst")
        .mockResolvedValue(trustedSource);
      jest.spyOn(prisma.trustedSource, "updateMany").mockResolvedValue({
        count: 0,
      });

      const updateInput = {
        expectedRevision: 0,
        displayName: "Updated Name",
      };

      await expect(
        trustedSourcesService.updateTrustedSource(mockUser, "ts-1", updateInput),
      ).rejects.toThrow(ConflictException);
    });

    it("should succeed with matching revision", async () => {
      jest
        .spyOn(prisma.trustedSource, "findFirst")
        .mockResolvedValue(trustedSource);
      jest.spyOn(prisma.trustedSource, "updateMany").mockResolvedValue({
        count: 1,
      });
      jest
        .spyOn(prisma.trustedSource, "findUniqueOrThrow")
        .mockResolvedValue({
          ...trustedSource,
          displayName: "Updated Name",
          revision: 2,
        });
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const updateInput = {
        expectedRevision: 1,
        displayName: "Updated Name",
      };

      const result = await trustedSourcesService.updateTrustedSource(
        mockUser,
        "ts-1",
        updateInput,
      );

      expect(result.revision).toBe(2);
    });
  });

  describe("Webhooks - Concurrent Updates", () => {
    const webhook = {
      id: "webhook-1",
      organizationId: "org-1",
      url: "https://example.com/webhook",
      secretEncrypted: "encrypted-secret",
      events: ["proof.created"],
      status: ResourceStatus.ACTIVE,
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("should fail when updateEvents revision does not match", async () => {
      jest
        .spyOn(prisma.webhook, "findUnique")
        .mockResolvedValue(webhook);
      jest.spyOn(prisma.webhook, "updateMany").mockResolvedValue({
        count: 0,
      });

      const updateInput = {
        expectedRevision: 0,
        events: ["proof.created", "proof.revoked"],
      };

      await expect(
        webhooksService.updateEvents("org-1", "webhook-1", updateInput),
      ).rejects.toThrow(ConflictException);
    });

    it("should succeed with matching revision for updateEvents", async () => {
      jest
        .spyOn(prisma.webhook, "findUnique")
        .mockResolvedValue(webhook);
      jest.spyOn(prisma.webhook, "updateMany").mockResolvedValue({
        count: 1,
      });
      jest
        .spyOn(prisma.webhook, "findUnique")
        .mockResolvedValueOnce(webhook)
        .mockResolvedValueOnce({
          ...webhook,
          events: ["proof.created", "proof.revoked"],
          revision: 2,
        });

      const updateInput = {
        expectedRevision: 1,
        events: ["proof.created", "proof.revoked"],
      };

      const result = await webhooksService.updateEvents(
        "org-1",
        "webhook-1",
        updateInput,
      );

      expect(result.revision).toBe(2);
    });

    it("should increment revision on status changes", async () => {
      jest
        .spyOn(prisma.webhook, "findUnique")
        .mockResolvedValue(webhook);

      await webhooksService.disable("org-1", "webhook-1");

      expect(prisma.webhook.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            revision: 2,
          }),
        }),
      );
    });
  });

  describe("Revision Atomicity", () => {
    it("should not partially update when revision check fails", async () => {
      const org = {
        id: "org-1",
        name: "Original Name",
        slug: "test-org",
        website: "https://example.com",
        status: ResourceStatus.PENDING,
        revision: 2,
        createdById: mockAdmin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(prisma.organization, "findFirst")
        .mockResolvedValue(org);
      // updateMany returns 0 count - no rows matched the where clause
      jest.spyOn(prisma.organization, "updateMany").mockResolvedValue({
        count: 0,
      });

      const updateInput = {
        expectedRevision: 1,
        name: "New Name",
        website: "https://newsite.com",
      };

      await expect(
        orgsService.updateOrganization(mockAdmin, "org-1", updateInput),
      ).rejects.toThrow(ConflictException);

      // Verify updateMany was called with the exact where clause including revision
      expect(prisma.organization.updateMany).toHaveBeenCalledWith({
        where: {
          id: "org-1",
          revision: 1,
        },
        data: expect.any(Object),
      });
    });
  });

  describe("Boundary Cases", () => {
    it("should handle revision 0 correctly", async () => {
      const org = {
        id: "org-1",
        name: "Original Name",
        slug: "test-org",
        website: "https://example.com",
        status: ResourceStatus.PENDING,
        revision: 0,
        createdById: mockAdmin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(prisma.organization, "findFirst")
        .mockResolvedValue(org);
      jest.spyOn(prisma.organization, "updateMany").mockResolvedValue({
        count: 1,
      });
      jest
        .spyOn(prisma.organization, "findUniqueOrThrow")
        .mockResolvedValue({
          ...org,
          revision: 1,
        });
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const updateInput = {
        expectedRevision: 0,
        name: "Updated Name",
      };

      const result = await orgsService.updateOrganization(
        mockAdmin,
        "org-1",
        updateInput,
      );

      expect(result.revision).toBe(1);
    });

    it("should handle large revision numbers", async () => {
      const org = {
        id: "org-1",
        name: "Original Name",
        slug: "test-org",
        website: "https://example.com",
        status: ResourceStatus.PENDING,
        revision: 9999,
        createdById: mockAdmin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(prisma.organization, "findFirst")
        .mockResolvedValue(org);
      jest.spyOn(prisma.organization, "updateMany").mockResolvedValue({
        count: 1,
      });
      jest
        .spyOn(prisma.organization, "findUniqueOrThrow")
        .mockResolvedValue({
          ...org,
          revision: 10000,
        });
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const updateInput = {
        expectedRevision: 9999,
        name: "Updated Name",
      };

      const result = await orgsService.updateOrganization(
        mockAdmin,
        "org-1",
        updateInput,
      );

      expect(result.revision).toBe(10000);
    });
  });

  describe("Regression - Existing Behavior Preserved", () => {
    it("should preserve authorization checks", async () => {
      jest
        .spyOn(prisma.organization, "findFirst")
        .mockResolvedValue(null);

      const updateInput = {
        expectedRevision: 0,
        name: "Updated Name",
      };

      await expect(
        orgsService.updateOrganization(mockUser, "org-1", updateInput),
      ).rejects.toThrow();
    });

    it("should preserve status validation for issuers", async () => {
      const issuer = {
        id: "issuer-1",
        organizationId: "org-1",
        stellarAddress:
          "GISSUER1111111111111111111111111111111111111111111111111111",
        status: ResourceStatus.REVOKED,
        revision: 1,
        metadataHash: null,
        publicMetadata: null,
        contractSyncState: "PENDING",
        contractSyncedStatus: null,
        contractTransactionHash: null,
        contractSyncedAt: null,
        contractSyncError: null,
        verifiedAt: null,
        suspendedAt: null,
        revokedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.issuer, "findUniqueOrThrow").mockResolvedValue(issuer);

      const updateInput = {
        expectedRevision: 1,
        status: ResourceStatus.ACTIVE,
      };

      await expect(
        issuersService.updateIssuerStatus(mockAdmin, "issuer-1", updateInput),
      ).rejects.toThrow();
    });

    it("should preserve audit logging", async () => {
      const org = {
        id: "org-1",
        name: "Original Name",
        slug: "test-org",
        website: "https://example.com",
        status: ResourceStatus.PENDING,
        revision: 1,
        createdById: mockAdmin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(prisma.organization, "findFirst")
        .mockResolvedValue(org);
      jest.spyOn(prisma.organization, "updateMany").mockResolvedValue({
        count: 1,
      });
      jest
        .spyOn(prisma.organization, "findUniqueOrThrow")
        .mockResolvedValue({
          ...org,
          name: "Updated Name",
          revision: 2,
        });
      jest.spyOn(prisma.auditLog, "create").mockResolvedValue({} as any);

      const updateInput = {
        expectedRevision: 1,
        name: "Updated Name",
      };

      await orgsService.updateOrganization(mockAdmin, "org-1", updateInput);

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorId: mockAdmin.id,
            action: "UPDATE",
            resourceType: "Organization",
            resourceId: "org-1",
          }),
        }),
      );
    });
  });
});
