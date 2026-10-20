import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  BulkAdminItemStatus,
  BulkAdminJobStatus,
  BulkAdminJobType,
  Prisma,
  ResourceStatus,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { StructuredLogger } from "../../common/logger";
import {
  BulkAdminJobResponseDto,
  CreateBulkAdminJobDto,
  MAX_BULK_ITEMS,
} from "./dto/bulk-admin.dto";

const LEASE_DURATION_MS = 30 * 1000; // 30 seconds
const DEFAULT_RETENTION_DAYS = 90;

@Injectable()
export class BulkAdminService {
  private readonly logger = new StructuredLogger(BulkAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Submit a bounded bulk administration job with idempotency.
   */
  async createJob(
    organizationId: string,
    requestedById: string,
    dto: CreateBulkAdminJobDto,
  ): Promise<BulkAdminJobResponseDto> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, status: true, archivedAt: true },
    });

    if (!org || org.status !== ResourceStatus.ACTIVE) {
      throw new BadRequestException("Organization not found or not active");
    }

    if (org.archivedAt) {
      throw new BadRequestException("Cannot create bulk job for archived organization");
    }

    if (dto.items.length > MAX_BULK_ITEMS) {
      throw new BadRequestException(
        `Bulk job exceeds maximum item capacity of ${MAX_BULK_ITEMS}`,
      );
    }

    // Check for existing job with same idempotency key
    const existing = await this.prisma.bulkAdminJob.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
      include: { items: { orderBy: { itemIndex: "asc" } } },
    });

    if (existing) {
      if (existing.organizationId !== organizationId) {
        throw new ConflictException("Idempotency key collision across organizations");
      }
      return this.toResponseDto(existing);
    }

    const retainUntil = new Date(
      Date.now() + DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    const created = await this.prisma.bulkAdminJob.create({
      data: {
        organizationId,
        requestedById,
        jobType: dto.jobType,
        status: BulkAdminJobStatus.PENDING,
        atomic: dto.atomic ?? false,
        totalItems: dto.items.length,
        processedItems: 0,
        succeededItems: 0,
        failedItems: 0,
        idempotencyKey: dto.idempotencyKey,
        retainUntil,
        items: {
          create: dto.items.map((item, index) => ({
            itemIndex: index,
            action: item.action,
            resourceId: item.resourceId,
            payload: item.payload as Prisma.InputJsonValue,
            status: BulkAdminItemStatus.PENDING,
          })),
        },
      },
      include: { items: { orderBy: { itemIndex: "asc" } } },
    });

    this.logger.log("Created bulk administration job", {
      workflow: "bulk_admin",
      outcome: "created",
      organizationId,
      jobId: created.id,
      jobType: created.jobType,
      itemCount: dto.items.length,
    });

    return this.toResponseDto(created);
  }

  /**
   * Acquire a lease and execute the bulk job items.
   * Resumes seamlessly if a previous worker crashed.
   */
  async executeJob(
    jobId: string,
    workerId: string,
  ): Promise<BulkAdminJobResponseDto> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

    // Acquire lease atomically
    const claim = await this.prisma.bulkAdminJob.updateMany({
      where: {
        id: jobId,
        status: { in: [BulkAdminJobStatus.PENDING, BulkAdminJobStatus.RUNNING] },
        OR: [
          { leaseOwner: null },
          { leaseExpiresAt: { lt: now } },
          { leaseOwner: workerId },
        ],
      },
      data: {
        status: BulkAdminJobStatus.RUNNING,
        leaseOwner: workerId,
        leaseExpiresAt,
      },
    });

    if (claim.count === 0) {
      const current = await this.prisma.bulkAdminJob.findUnique({
        where: { id: jobId },
        include: { items: { orderBy: { itemIndex: "asc" } } },
      });
      if (!current) throw new NotFoundException("Bulk job not found");
      return this.toResponseDto(current);
    }

    const job = await this.prisma.bulkAdminJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { items: { orderBy: { itemIndex: "asc" } } },
    });

    let succeeded = job.succeededItems;
    let failed = job.failedItems;
    let processed = job.processedItems;
    let aborted = false;

    for (const item of job.items) {
      // 1. Check for cancellation
      const freshJob = await this.prisma.bulkAdminJob.findUnique({
        where: { id: jobId },
        select: { cancelRequestedAt: true },
      });

      if (freshJob?.cancelRequestedAt) {
        // Mark all remaining PENDING items as SKIPPED
        await this.prisma.bulkAdminJobItem.updateMany({
          where: { jobId, status: BulkAdminItemStatus.PENDING },
          data: {
            status: BulkAdminItemStatus.SKIPPED,
            errorMessage: "Job execution cancelled by user request",
            completedAt: new Date(),
          },
        });

        const cancelledJob = await this.prisma.bulkAdminJob.update({
          where: { id: jobId },
          data: {
            status: BulkAdminJobStatus.CANCELLED,
            completedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
          include: { items: { orderBy: { itemIndex: "asc" } } },
        });
        return this.toResponseDto(cancelledJob);
      }

      // 2. Skip already processed items (ensures retries do not repeat completed mutations)
      if (item.status === BulkAdminItemStatus.SUCCESS) {
        continue;
      }

      // 3. Process item with tenant validation
      const itemOutcome = await this.processItem(job.organizationId, job.jobType, item);

      if (itemOutcome.success) {
        succeeded++;
        processed++;
        await this.prisma.bulkAdminJobItem.update({
          where: { id: item.id },
          data: {
            status: BulkAdminItemStatus.SUCCESS,
            completedAt: new Date(),
          },
        });
      } else {
        failed++;
        processed++;
        await this.prisma.bulkAdminJobItem.update({
          where: { id: item.id },
          data: {
            status: BulkAdminItemStatus.FAILED,
            errorCategory: itemOutcome.errorCategory,
            errorMessage: itemOutcome.errorMessage,
            completedAt: new Date(),
          },
        });

        // If job is atomic and an item failed, abort remaining items
        if (job.atomic) {
          aborted = true;
          await this.prisma.bulkAdminJobItem.updateMany({
            where: {
              jobId,
              status: BulkAdminItemStatus.PENDING,
            },
            data: {
              status: BulkAdminItemStatus.SKIPPED,
              errorCategory: "ATOMIC_ROLLBACK",
              errorMessage: "Operation declared atomic; prior item failed",
              completedAt: new Date(),
            },
          });
          break;
        }
      }

      // Update progress
      await this.prisma.bulkAdminJob.update({
        where: { id: jobId },
        data: {
          processedItems: processed,
          succeededItems: succeeded,
          failedItems: failed,
        },
      });
    }

    const finalStatus = aborted
      ? BulkAdminJobStatus.FAILED
      : failed > 0 && succeeded === 0
        ? BulkAdminJobStatus.FAILED
        : BulkAdminJobStatus.COMPLETED;

    const completed = await this.prisma.bulkAdminJob.update({
      where: { id: jobId },
      data: {
        status: finalStatus,
        processedItems: processed,
        succeededItems: succeeded,
        failedItems: failed,
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      include: { items: { orderBy: { itemIndex: "asc" } } },
    });

    this.logger.log("Bulk admin job completed execution", {
      workflow: "bulk_admin",
      outcome: finalStatus,
      jobId,
      succeeded,
      failed,
      processed,
    });

    return this.toResponseDto(completed);
  }

  /**
   * Request job cancellation.
   */
  async cancelJob(organizationId: string, jobId: string): Promise<BulkAdminJobResponseDto> {
    const job = await this.prisma.bulkAdminJob.findUnique({
      where: { id: jobId },
    });

    if (!job) throw new NotFoundException("Bulk job not found");
    if (job.organizationId !== organizationId) {
      throw new BadRequestException("Job does not belong to organization");
    }

    if (
      job.status === BulkAdminJobStatus.COMPLETED ||
      job.status === BulkAdminJobStatus.CANCELLED ||
      job.status === BulkAdminJobStatus.FAILED
    ) {
      throw new BadRequestException(`Cannot cancel job in ${job.status} state`);
    }

    const updated = await this.prisma.bulkAdminJob.update({
      where: { id: jobId },
      data: { cancelRequestedAt: new Date() },
      include: { items: { orderBy: { itemIndex: "asc" } } },
    });

    return this.toResponseDto(updated);
  }

  /**
   * Get job progress and results.
   */
  async getJob(organizationId: string, jobId: string): Promise<BulkAdminJobResponseDto> {
    const job = await this.prisma.bulkAdminJob.findUnique({
      where: { id: jobId },
      include: { items: { orderBy: { itemIndex: "asc" } } },
    });

    if (!job) throw new NotFoundException("Bulk job not found");
    if (job.organizationId !== organizationId) {
      throw new BadRequestException("Job does not belong to organization");
    }

    return this.toResponseDto(job);
  }

  /**
   * Process a single item with tenant authorization validation.
   */
  private async processItem(
    organizationId: string,
    jobType: BulkAdminJobType,
    item: { action: string; resourceId: string; payload: Prisma.JsonValue },
  ): Promise<{ success: boolean; errorCategory?: string; errorMessage?: string }> {
    try {
      if (jobType === BulkAdminJobType.MEMBER_ROLE_UPDATE) {
        // Validate member belongs to organization
        const member = await this.prisma.organizationMember.findUnique({
          where: {
            organizationId_userId: {
              organizationId,
              userId: item.resourceId,
            },
          },
        });
        if (!member) {
          return {
            success: false,
            errorCategory: "UNAUTHORIZED",
            errorMessage: `Member ${item.resourceId} does not belong to organization`,
          };
        }
        return { success: true };
      }

      if (jobType === BulkAdminJobType.ISSUER_STATUS_UPDATE) {
        // Validate issuer belongs to organization
        const issuer = await this.prisma.issuer.findFirst({
          where: {
            id: item.resourceId,
            organizationId,
          },
        });
        if (!issuer) {
          return {
            success: false,
            errorCategory: "UNAUTHORIZED",
            errorMessage: `Issuer ${item.resourceId} does not belong to organization`,
          };
        }
        return { success: true };
      }

      if (jobType === BulkAdminJobType.WEBHOOK_CONFIG_UPDATE) {
        // Validate webhook belongs to organization
        const webhook = await this.prisma.webhook.findFirst({
          where: {
            id: item.resourceId,
            organizationId,
          },
        });
        if (!webhook) {
          return {
            success: false,
            errorCategory: "UNAUTHORIZED",
            errorMessage: `Webhook ${item.resourceId} does not belong to organization`,
          };
        }
        return { success: true };
      }

      // Default generic handling
      return { success: true };
    } catch (err) {
      return {
        success: false,
        errorCategory: "EXECUTION_ERROR",
        errorMessage: String(err),
      };
    }
  }

  private toResponseDto(job: {
    id: string;
    organizationId: string;
    jobType: BulkAdminJobType;
    status: BulkAdminJobStatus;
    atomic: boolean;
    totalItems: number;
    processedItems: number;
    succeededItems: number;
    failedItems: number;
    idempotencyKey: string;
    cancelRequestedAt: Date | null;
    createdAt: Date;
    completedAt: Date | null;
    items?: Array<{
      itemIndex: number;
      action: string;
      resourceId: string;
      status: BulkAdminItemStatus;
      errorCategory: string | null;
      errorMessage: string | null;
      completedAt: Date | null;
    }>;
  }): BulkAdminJobResponseDto {
    return {
      id: job.id,
      organizationId: job.organizationId,
      jobType: job.jobType,
      status: job.status,
      atomic: job.atomic,
      totalItems: job.totalItems,
      processedItems: job.processedItems,
      succeededItems: job.succeededItems,
      failedItems: job.failedItems,
      idempotencyKey: job.idempotencyKey,
      cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
      items: job.items?.map((i) => ({
        itemIndex: i.itemIndex,
        action: i.action,
        resourceId: i.resourceId,
        status: i.status,
        errorCategory: i.errorCategory,
        errorMessage: i.errorMessage,
        completedAt: i.completedAt?.toISOString() ?? null,
      })),
    };
  }
}
