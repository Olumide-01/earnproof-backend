import { BadRequestException } from "@nestjs/common";
import {
  BulkAdminItemStatus,
  BulkAdminJobStatus,
  BulkAdminJobType,
  ResourceStatus,
} from "@prisma/client";
import { BulkAdminService } from "./bulk-admin.service";

describe("BulkAdminService", () => {
  let service: BulkAdminService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      organization: {
        findUnique: jest.fn(),
      },
      organizationMember: {
        findUnique: jest.fn(),
      },
      issuer: {
        findFirst: jest.fn(),
      },
      webhook: {
        findFirst: jest.fn(),
      },
      bulkAdminJob: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      bulkAdminJobItem: {
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    service = new BulkAdminService(prisma);
  });

  describe("createJob", () => {
    it("creates a bounded bulk admin job with pending items", async () => {
      prisma.organization.findUnique.mockResolvedValue({
        id: "org_1",
        status: ResourceStatus.ACTIVE,
        archivedAt: null,
      });
      prisma.bulkAdminJob.findUnique.mockResolvedValue(null);

      const now = new Date();
      prisma.bulkAdminJob.create.mockResolvedValue({
        id: "job_1",
        organizationId: "org_1",
        jobType: BulkAdminJobType.MEMBER_ROLE_UPDATE,
        status: BulkAdminJobStatus.PENDING,
        atomic: false,
        totalItems: 2,
        processedItems: 0,
        succeededItems: 0,
        failedItems: 0,
        idempotencyKey: "idem_1",
        cancelRequestedAt: null,
        createdAt: now,
        completedAt: null,
        items: [
          {
            itemIndex: 0,
            action: "UPDATE_ROLE",
            resourceId: "user_a",
            status: BulkAdminItemStatus.PENDING,
            errorCategory: null,
            errorMessage: null,
            completedAt: null,
          },
          {
            itemIndex: 1,
            action: "UPDATE_ROLE",
            resourceId: "user_b",
            status: BulkAdminItemStatus.PENDING,
            errorCategory: null,
            errorMessage: null,
            completedAt: null,
          },
        ],
      });

      const res = await service.createJob("org_1", "admin_1", {
        jobType: BulkAdminJobType.MEMBER_ROLE_UPDATE,
        idempotencyKey: "idem_1",
        items: [
          { action: "UPDATE_ROLE", resourceId: "user_a", payload: { role: "ADMIN" } },
          { action: "UPDATE_ROLE", resourceId: "user_b", payload: { role: "MEMBER" } },
        ],
      });

      expect(res.id).toBe("job_1");
      expect(res.totalItems).toBe(2);
      expect(res.status).toBe(BulkAdminJobStatus.PENDING);
      expect(prisma.bulkAdminJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: "org_1",
          requestedById: "admin_1",
          totalItems: 2,
          retainUntil: expect.any(Date),
        }),
        include: expect.anything(),
      });
    });

    it("returns existing job on duplicate idempotency key submission", async () => {
      prisma.organization.findUnique.mockResolvedValue({
        id: "org_1",
        status: ResourceStatus.ACTIVE,
        archivedAt: null,
      });
      prisma.bulkAdminJob.findUnique.mockResolvedValue({
        id: "job_existing",
        organizationId: "org_1",
        jobType: BulkAdminJobType.MEMBER_ROLE_UPDATE,
        status: BulkAdminJobStatus.COMPLETED,
        atomic: false,
        totalItems: 1,
        processedItems: 1,
        succeededItems: 1,
        failedItems: 0,
        idempotencyKey: "idem_dup",
        cancelRequestedAt: null,
        createdAt: new Date(),
        completedAt: new Date(),
        items: [],
      });

      const res = await service.createJob("org_1", "admin_1", {
        jobType: BulkAdminJobType.MEMBER_ROLE_UPDATE,
        idempotencyKey: "idem_dup",
        items: [{ action: "UPDATE_ROLE", resourceId: "u1", payload: {} }],
      });

      expect(res.id).toBe("job_existing");
      expect(prisma.bulkAdminJob.create).not.toHaveBeenCalled();
    });

    it("rejects job when organization is archived", async () => {
      prisma.organization.findUnique.mockResolvedValue({
        id: "org_1",
        status: ResourceStatus.ACTIVE,
        archivedAt: new Date(),
      });

      await expect(
        service.createJob("org_1", "admin_1", {
          jobType: BulkAdminJobType.MEMBER_ROLE_UPDATE,
          idempotencyKey: "idem_archived",
          items: [{ action: "ACT", resourceId: "r1", payload: {} }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("executeJob", () => {
    it("processes items with non-atomic partial failure reporting", async () => {
      prisma.bulkAdminJob.updateMany.mockResolvedValue({ count: 1 });

      const items = [
        {
          id: "item_0",
          itemIndex: 0,
          action: "UPDATE_ROLE",
          resourceId: "user_valid",
          payload: {},
          status: BulkAdminItemStatus.PENDING,
        },
        {
          id: "item_1",
          itemIndex: 1,
          action: "UPDATE_ROLE",
          resourceId: "user_invalid_tenant",
          payload: {},
          status: BulkAdminItemStatus.PENDING,
        },
      ];

      const jobData = {
        id: "job_1",
        organizationId: "org_1",
        jobType: BulkAdminJobType.MEMBER_ROLE_UPDATE,
        atomic: false,
        status: BulkAdminJobStatus.RUNNING,
        totalItems: 2,
        processedItems: 0,
        succeededItems: 0,
        failedItems: 0,
        idempotencyKey: "idem_1",
        cancelRequestedAt: null,
        createdAt: new Date(),
        completedAt: null,
        items,
      };

      prisma.bulkAdminJob.findUniqueOrThrow.mockResolvedValue(jobData);
      prisma.bulkAdminJob.findUnique.mockResolvedValue(jobData);
      prisma.bulkAdminJob.update.mockImplementation(({ data }: any) => ({
        ...jobData,
        ...data,
      }));

      // item 0: member exists
      prisma.organizationMember.findUnique.mockImplementation(({ where }: any) => {
        if (where.organizationId_userId.userId === "user_valid") return { id: "m_1" };
        return null;
      });

      const res = await service.executeJob("job_1", "worker_1");

      expect(res.processedItems).toBe(2);
      expect(res.succeededItems).toBe(1);
      expect(res.failedItems).toBe(1);
      expect(res.status).toBe(BulkAdminJobStatus.COMPLETED);

      // Item 0 succeeded
      expect(prisma.bulkAdminJobItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "item_0" },
          data: expect.objectContaining({ status: BulkAdminItemStatus.SUCCESS }),
        }),
      );

      // Item 1 failed due to unauthorized tenant check
      expect(prisma.bulkAdminJobItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "item_1" },
          data: expect.objectContaining({
            status: BulkAdminItemStatus.FAILED,
            errorCategory: "UNAUTHORIZED",
          }),
        }),
      );
    });

    it("aborts subsequent items when atomic is true and an item fails", async () => {
      prisma.bulkAdminJob.updateMany.mockResolvedValue({ count: 1 });

      const items = [
        {
          id: "item_0",
          itemIndex: 0,
          action: "UPDATE_ROLE",
          resourceId: "user_invalid",
          payload: {},
          status: BulkAdminItemStatus.PENDING,
        },
        {
          id: "item_1",
          itemIndex: 1,
          action: "UPDATE_ROLE",
          resourceId: "user_valid",
          payload: {},
          status: BulkAdminItemStatus.PENDING,
        },
      ];

      const jobData = {
        id: "job_atomic",
        organizationId: "org_1",
        jobType: BulkAdminJobType.MEMBER_ROLE_UPDATE,
        atomic: true,
        status: BulkAdminJobStatus.RUNNING,
        totalItems: 2,
        processedItems: 0,
        succeededItems: 0,
        failedItems: 0,
        idempotencyKey: "idem_atomic",
        cancelRequestedAt: null,
        createdAt: new Date(),
        completedAt: null,
        items,
      };

      prisma.bulkAdminJob.findUniqueOrThrow.mockResolvedValue(jobData);
      prisma.bulkAdminJob.findUnique.mockResolvedValue(jobData);
      prisma.organizationMember.findUnique.mockResolvedValue(null);
      prisma.bulkAdminJob.update.mockImplementation(({ data }: any) => ({
        ...jobData,
        ...data,
      }));

      const res = await service.executeJob("job_atomic", "worker_1");

      expect(res.status).toBe(BulkAdminJobStatus.FAILED);
      expect(prisma.bulkAdminJobItem.updateMany).toHaveBeenCalledWith({
        where: { jobId: "job_atomic", status: BulkAdminItemStatus.PENDING },
        data: expect.objectContaining({
          status: BulkAdminItemStatus.SKIPPED,
          errorCategory: "ATOMIC_ROLLBACK",
        }),
      });
    });

    it("does not repeat already succeeded items when resumed after crash", async () => {
      prisma.bulkAdminJob.updateMany.mockResolvedValue({ count: 1 });

      const items = [
        {
          id: "item_0",
          itemIndex: 0,
          action: "UPDATE_ROLE",
          resourceId: "user_already_done",
          payload: {},
          status: BulkAdminItemStatus.SUCCESS, // Already completed
        },
        {
          id: "item_1",
          itemIndex: 1,
          action: "UPDATE_ROLE",
          resourceId: "user_pending",
          payload: {},
          status: BulkAdminItemStatus.PENDING,
        },
      ];

      const jobData = {
        id: "job_resume",
        organizationId: "org_1",
        jobType: BulkAdminJobType.MEMBER_ROLE_UPDATE,
        atomic: false,
        status: BulkAdminJobStatus.RUNNING,
        totalItems: 2,
        processedItems: 1,
        succeededItems: 1,
        failedItems: 0,
        idempotencyKey: "idem_resume",
        cancelRequestedAt: null,
        createdAt: new Date(),
        completedAt: null,
        items,
      };

      prisma.bulkAdminJob.findUniqueOrThrow.mockResolvedValue(jobData);
      prisma.bulkAdminJob.findUnique.mockResolvedValue(jobData);
      prisma.organizationMember.findUnique.mockResolvedValue({ id: "m_2" });
      prisma.bulkAdminJob.update.mockImplementation(({ data }: any) => ({
        ...jobData,
        ...data,
      }));

      await service.executeJob("job_resume", "worker_2");

      // Item 0 was skipped because already SUCCESS
      expect(prisma.bulkAdminJobItem.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "item_0" } }),
      );

      // Item 1 was processed
      expect(prisma.bulkAdminJobItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "item_1" } }),
      );
    });

    it("respects cancellation request and marks unexecuted items skipped", async () => {
      prisma.bulkAdminJob.updateMany.mockResolvedValue({ count: 1 });

      const items = [
        {
          id: "item_0",
          itemIndex: 0,
          action: "UPDATE_ROLE",
          resourceId: "user_1",
          payload: {},
          status: BulkAdminItemStatus.PENDING,
        },
      ];

      const jobData = {
        id: "job_cancel",
        organizationId: "org_1",
        jobType: BulkAdminJobType.MEMBER_ROLE_UPDATE,
        atomic: false,
        status: BulkAdminJobStatus.RUNNING,
        totalItems: 1,
        processedItems: 0,
        succeededItems: 0,
        failedItems: 0,
        idempotencyKey: "idem_c",
        cancelRequestedAt: new Date(), // Cancel requested!
        createdAt: new Date(),
        completedAt: null,
        items,
      };

      prisma.bulkAdminJob.findUniqueOrThrow.mockResolvedValue(jobData);
      prisma.bulkAdminJob.findUnique.mockResolvedValue(jobData);
      prisma.bulkAdminJob.update.mockImplementation(({ data }: any) => ({
        ...jobData,
        ...data,
        items: [],
      }));

      const res = await service.executeJob("job_cancel", "worker_1");

      expect(prisma.bulkAdminJobItem.updateMany).toHaveBeenCalledWith({
        where: { jobId: "job_cancel", status: BulkAdminItemStatus.PENDING },
        data: expect.objectContaining({ status: BulkAdminItemStatus.SKIPPED }),
      });
      expect(res.status).toBe(BulkAdminJobStatus.CANCELLED);
    });
  });
});
