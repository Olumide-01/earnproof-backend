import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../database/prisma.service";
import { DataResidencyService } from "./data-residency.service";

describe("DataResidencyService", () => {
  let service: DataResidencyService;
  let prisma: {
    organization: { findUnique: jest.Mock };
    dataResidencyPolicy: {
      findFirst: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
    };
    dataResidencyAssignment: { findFirst: jest.Mock; upsert: jest.Mock };
    auditLog: { create: jest.Mock };
    $transaction: jest.Mock;
  };

  const admin = { id: "admin-1", walletAddress: "G1", walletHash: "h1", role: "ADMIN" };
  const creator = { id: "creator-1", walletAddress: "G2", walletHash: "h2", role: "WORKER" };
  const bystander = { id: "bystander-1", walletAddress: "G3", walletHash: "h3", role: "WORKER" };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataResidencyService,
        {
          provide: PrismaService,
          useValue: {
            organization: { findUnique: jest.fn() },
            dataResidencyPolicy: {
              findFirst: jest.fn(),
              update: jest.fn(),
              create: jest.fn(),
            },
            dataResidencyAssignment: { findFirst: jest.fn(), upsert: jest.fn() },
            auditLog: { create: jest.fn() },
            $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prismaForTx())),
          },
        },
      ],
    }).compile();

    service = module.get(DataResidencyService);
    prisma = module.get(PrismaService) as unknown as typeof prisma;
  });

  function prismaForTx() {
    return {
      dataResidencyPolicy: prisma.dataResidencyPolicy,
    };
  }

  describe("setPolicy — authorization", () => {
    it("rejects a non-creator, non-admin caller", async () => {
      prisma.organization.findUnique.mockResolvedValue({ createdById: creator.id });

      await expect(
        service.setPolicy(bystander, "org-1", {
          dataClass: "PAYMENT_DATA",
          allowedRegions: ["eu-west-1"],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException for an unknown organization", async () => {
      prisma.organization.findUnique.mockResolvedValue(null);

      await expect(
        service.setPolicy(admin, "missing-org", {
          dataClass: "PAYMENT_DATA",
          allowedRegions: ["eu-west-1"],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("allows the organization's creator even without ADMIN role", async () => {
      prisma.organization.findUnique.mockResolvedValue({ createdById: creator.id });
      prisma.dataResidencyAssignment.findFirst.mockResolvedValue(null);
      prisma.dataResidencyPolicy.findFirst.mockResolvedValue(null);
      prisma.dataResidencyPolicy.create.mockResolvedValue({
        id: "policy-1",
        version: 1,
        allowedRegions: ["eu-west-1"],
      });

      await expect(
        service.setPolicy(creator, "org-1", {
          dataClass: "PAYMENT_DATA",
          allowedRegions: ["eu-west-1"],
        }),
      ).resolves.toMatchObject({ id: "policy-1" });
    });
  });

  describe("setPolicy — versioning and data-safety", () => {
    it("creates version 1 when no prior policy exists", async () => {
      prisma.organization.findUnique.mockResolvedValue({ createdById: admin.id });
      prisma.dataResidencyAssignment.findFirst.mockResolvedValue(null);
      prisma.dataResidencyPolicy.findFirst.mockResolvedValue(null);
      prisma.dataResidencyPolicy.create.mockResolvedValue({ id: "p1", version: 1 });

      await service.setPolicy(admin, "org-1", {
        dataClass: "PAYMENT_DATA",
        allowedRegions: ["eu-west-1"],
      });

      expect(prisma.dataResidencyPolicy.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ version: 1, supersedesId: undefined }) }),
      );
    });

    it("supersedes the current policy and increments the version", async () => {
      prisma.organization.findUnique.mockResolvedValue({ createdById: admin.id });
      prisma.dataResidencyAssignment.findFirst.mockResolvedValue(null);
      prisma.dataResidencyPolicy.findFirst.mockResolvedValue({ id: "p1", version: 1 });
      prisma.dataResidencyPolicy.create.mockResolvedValue({ id: "p2", version: 2 });

      await service.setPolicy(admin, "org-1", {
        dataClass: "PAYMENT_DATA",
        allowedRegions: ["eu-central-1"],
      });

      expect(prisma.dataResidencyPolicy.update).toHaveBeenCalledWith({
        where: { id: "p1" },
        data: { status: "SUPERSEDED" },
      });
      expect(prisma.dataResidencyPolicy.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: 2, supersedesId: "p1" }),
        }),
      );
    });

    it("refuses to narrow the allow-list when existing data would be stranded", async () => {
      prisma.organization.findUnique.mockResolvedValue({ createdById: admin.id });
      prisma.dataResidencyAssignment.findFirst.mockResolvedValue({
        resourceType: "backup",
        resourceId: "backup-1",
        region: "us-east-1",
      });

      await expect(
        service.setPolicy(admin, "org-1", {
          dataClass: "BACKUP_DATA",
          allowedRegions: ["eu-west-1"],
        }),
      ).rejects.toThrow(ConflictException);

      expect(prisma.dataResidencyPolicy.create).not.toHaveBeenCalled();
    });
  });

  describe("assertRegionAllowed", () => {
    it("denies by default when no policy exists for the data class", async () => {
      prisma.dataResidencyPolicy.findFirst.mockResolvedValue(null);

      await expect(
        service.assertRegionAllowed("org-1", "QUEUE_DATA", "eu-west-1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("denies a region outside the allow-list", async () => {
      prisma.dataResidencyPolicy.findFirst.mockResolvedValue({
        allowedRegions: ["eu-west-1"],
      });

      await expect(
        service.assertRegionAllowed("org-1", "QUEUE_DATA", "us-east-1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows a region explicitly present in the allow-list", async () => {
      prisma.dataResidencyPolicy.findFirst.mockResolvedValue({
        allowedRegions: ["eu-west-1"],
      });

      await expect(
        service.assertRegionAllowed("org-1", "QUEUE_DATA", "eu-west-1"),
      ).resolves.toBeUndefined();
    });
  });

  describe("recordAssignment", () => {
    it("never persists an assignment to a disallowed region", async () => {
      prisma.dataResidencyPolicy.findFirst.mockResolvedValue({
        allowedRegions: ["eu-west-1"],
      });

      await expect(
        service.recordAssignment("org-1", {
          dataClass: "QUEUE_DATA",
          resourceType: "queueJob",
          resourceId: "job-1",
          region: "ap-southeast-1",
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.dataResidencyAssignment.upsert).not.toHaveBeenCalled();
    });

    it("upserts an allowed assignment keyed by resource identity", async () => {
      prisma.dataResidencyPolicy.findFirst.mockResolvedValue({
        allowedRegions: ["eu-west-1"],
      });
      prisma.dataResidencyAssignment.upsert.mockResolvedValue({ id: "a1" });

      await service.recordAssignment("org-1", {
        dataClass: "QUEUE_DATA",
        resourceType: "queueJob",
        resourceId: "job-1",
        region: "eu-west-1",
      });

      expect(prisma.dataResidencyAssignment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId_dataClass_resourceType_resourceId: {
              organizationId: "org-1",
              dataClass: "QUEUE_DATA",
              resourceType: "queueJob",
              resourceId: "job-1",
            },
          },
        }),
      );
    });
  });
});
