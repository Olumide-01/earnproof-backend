import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  MembershipImportStatus,
  MembershipImportRowResult,
  OrganizationMemberRole,
  ResourceStatus,
} from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { JobExecutionService } from "../jobs/execution/job-execution.service";
import { OrganizationMembersService } from "./organization-members.service";
import {
  CreateMembershipImportDto,
  MembershipImportRowDto,
} from "./dto/create-membership-import.dto";
import {
  MembershipImportResponseDto,
  MembershipImportResultDto,
  ListMembershipImportsDto,
} from "./dto/membership-import-response.dto";

const MAX_IMPORT_SIZE = 1000;
const SUPPORTED_VERSIONS = ["1.0"];

@Injectable()
export class MembershipImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobExecutions: JobExecutionService,
    private readonly membersService: OrganizationMembersService,
  ) {}

  async createImport(
    user: AuthenticatedUser,
    organizationId: string,
    input: CreateMembershipImportDto,
  ): Promise<MembershipImportResponseDto> {
    // Verify user has permission to manage this organization
    const canManage = await this.membersService.canManageOrganization(user, organizationId);
    if (!canManage) {
      throw new ForbiddenException(
        "You do not have permission to import members for this organization",
      );
    }

    // Validate version
    const version = input.version || "1.0";
    if (!SUPPORTED_VERSIONS.includes(version)) {
      throw new ForbiddenException(`Unsupported import version: ${version}`);
    }

    // Validate row count
    if (input.members.length === 0) {
      throw new ForbiddenException("Import cannot be empty");
    }

    if (input.members.length > MAX_IMPORT_SIZE) {
      throw new ForbiddenException(
        `Cannot import more than ${MAX_IMPORT_SIZE} members at once`,
      );
    }

    // Validate for duplicates within the import
    const walletAddresses = input.members.map((m) => m.walletAddress);
    const uniqueAddresses = new Set(walletAddresses);
    if (uniqueAddresses.size !== walletAddresses.length) {
      throw new ForbiddenException("Import contains duplicate wallet addresses");
    }

    // Create the import job
    const importJob = await this.prisma.membershipImportJob.create({
      data: {
        organizationId,
        createdById: user.id,
        version,
        filename: input.filename,
        rowCount: input.members.length,
        status: MembershipImportStatus.PENDING,
        progress: 0,
      },
    });

    // Create placeholder results to maintain order
    await Promise.all(
      input.members.map((member, index) =>
        this.prisma.membershipImportResult.create({
          data: {
            importJobId: importJob.id,
            rowIndex: index,
            walletAddress: member.walletAddress,
            requestedRole: member.role,
            result: MembershipImportRowResult.FAILED, // Will be updated during processing
            reasonCode: "PENDING",
          },
        }),
      ),
    );

    // Log audit event
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action: "CREATE",
        resourceType: "MembershipImportJob",
        resourceId: importJob.id,
        metadata: {
          organizationId,
          rowCount: input.members.length,
          version,
          filename: input.filename,
        },
      },
    });

    // Start background processing
    this.processImportAsync(importJob.id);

    return this.toResponseDto(importJob);
  }

  async getImport(
    user: AuthenticatedUser,
    organizationId: string,
    importId: string,
  ): Promise<MembershipImportResponseDto> {
    const canView = await this.membersService.canViewOrganization(user, organizationId);
    if (!canView) {
      throw new NotFoundException("Organization not found");
    }

    const importJob = await this.prisma.membershipImportJob.findFirst({
      where: {
        id: importId,
        organizationId,
      },
      include: {
        results: {
          orderBy: { rowIndex: "asc" },
        },
      },
    });

    if (!importJob) {
      throw new NotFoundException("Import job not found");
    }

    return this.toResponseDto(importJob);
  }

  async listImports(
    user: AuthenticatedUser,
    organizationId: string,
    query: ListMembershipImportsDto,
  ): Promise<{
    items: MembershipImportResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const canView = await this.membersService.canViewOrganization(user, organizationId);
    if (!canView) {
      throw new NotFoundException("Organization not found");
    }

    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: any = { organizationId };
    if (query.status) {
      where.status = query.status;
    }

    const [items, total] = await Promise.all([
      this.prisma.membershipImportJob.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.membershipImportJob.count({ where }),
    ]);

    return {
      items: items.map((job) => this.toResponseDto(job)),
      total,
      page,
      limit,
    };
  }

  async cancelImport(
    user: AuthenticatedUser,
    organizationId: string,
    importId: string,
  ): Promise<void> {
    const canManage = await this.membersService.canManageOrganization(user, organizationId);
    if (!canManage) {
      throw new ForbiddenException(
        "You do not have permission to cancel imports for this organization",
      );
    }

    const importJob = await this.prisma.membershipImportJob.findFirst({
      where: {
        id: importId,
        organizationId,
        status: { in: [MembershipImportStatus.PENDING, MembershipImportStatus.PROCESSING] },
      },
    });

    if (!importJob) {
      throw new NotFoundException("Import job not found or cannot be cancelled");
    }

    await this.prisma.membershipImportJob.update({
      where: { id: importId },
      data: {
        status: MembershipImportStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });

    // Log audit event
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action: "CANCEL",
        resourceType: "MembershipImportJob",
        resourceId: importId,
        metadata: {
          organizationId,
        },
      },
    });
  }

  private async processImportAsync(importJobId: string): Promise<void> {
    // Use job execution service for tracking
    await this.jobExecutions.track(
      {
        jobName: "membership-import",
        jobVersion: "1.0",
        leaseOwner: process.env.HOSTNAME || "unknown",
      },
      async () => {
        await this.processImport(importJobId);
      },
    );
  }

  private async processImport(importJobId: string): Promise<void> {
    // Mark as processing
    const importJob = await this.prisma.membershipImportJob.update({
      where: { id: importJobId },
      data: { status: MembershipImportStatus.PROCESSING },
      include: {
        results: {
          orderBy: { rowIndex: "asc" },
        },
        organization: true,
      },
    });

    if (importJob.status === MembershipImportStatus.CANCELLED) {
      return; // Job was cancelled before we could start
    }

    let processed = 0;
    let hasErrors = false;

    try {
      // Process each row in order
      for (const result of importJob.results) {
        // Check if import was cancelled
        const currentStatus = await this.prisma.membershipImportJob.findUnique({
          where: { id: importJobId },
          select: { status: true },
        });

        if (currentStatus?.status === MembershipImportStatus.CANCELLED) {
          return; // Stop processing if cancelled
        }

        const processResult = await this.processImportRow(
          importJob.organizationId,
          result,
        );

        // Update the result
        await this.prisma.membershipImportResult.update({
          where: { id: result.id },
          data: {
            result: processResult.result,
            reasonCode: processResult.reasonCode,
            errorMessage: processResult.errorMessage,
            processedAt: new Date(),
          },
        });

        processed++;

        // Update progress
        await this.prisma.membershipImportJob.update({
          where: { id: importJobId },
          data: { progress: processed },
        });

        if (processResult.result === MembershipImportRowResult.FAILED) {
          hasErrors = true;
        }
      }

      // Mark as completed
      await this.prisma.membershipImportJob.update({
        where: { id: importJobId },
        data: {
          status: MembershipImportStatus.COMPLETED,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      hasErrors = true;
      
      // Mark as failed
      await this.prisma.membershipImportJob.update({
        where: { id: importJobId },
        data: {
          status: MembershipImportStatus.FAILED,
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        },
      });
    }
  }

  private async processImportRow(
    organizationId: string,
    row: any,
  ): Promise<{
    result: MembershipImportRowResult;
    reasonCode: string;
    errorMessage?: string;
  }> {
    try {
      // Validate wallet address exists as a user
      const user = await this.prisma.user.findUnique({
        where: { walletAddress: row.walletAddress },
      });

      if (!user) {
        return {
          result: MembershipImportRowResult.REJECTED,
          reasonCode: "USER_NOT_FOUND",
          errorMessage: "Wallet address is not registered as a user",
        };
      }

      // Check if user is already a member
      const existingMember = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId,
            userId: user.id,
          },
        },
      });

      if (existingMember) {
        // Check if role needs updating
        if (existingMember.role === row.requestedRole) {
          return {
            result: MembershipImportRowResult.NO_OP,
            reasonCode: "ALREADY_MEMBER_SAME_ROLE",
          };
        }

        // TODO: Implement role change logic with proper authorization checks
        // For now, we'll reject role changes via import
        return {
          result: MembershipImportRowResult.REJECTED,
          reasonCode: "ROLE_CHANGE_NOT_SUPPORTED",
          errorMessage: "Use direct role management for existing members",
        };
      }

      // Create new membership
      await this.prisma.organizationMember.create({
        data: {
          organizationId,
          userId: user.id,
          role: row.requestedRole,
          status: ResourceStatus.ACTIVE,
          joinedAt: new Date(),
        },
      });

      return {
        result: MembershipImportRowResult.ACCEPTED,
        reasonCode: "MEMBER_ADDED",
      };
    } catch (error) {
      return {
        result: MembershipImportRowResult.FAILED,
        reasonCode: "PROCESSING_ERROR",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private toResponseDto(job: any): MembershipImportResponseDto {
    return {
      id: job.id,
      organizationId: job.organizationId,
      createdById: job.createdById,
      version: job.version,
      filename: job.filename,
      rowCount: job.rowCount,
      status: job.status,
      progress: job.progress,
      cancelledAt: job.cancelledAt,
      completedAt: job.completedAt,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      results: job.results?.map((result: any) => ({
        id: result.id,
        rowIndex: result.rowIndex,
        walletAddress: result.walletAddress,
        requestedRole: result.requestedRole,
        result: result.result,
        reasonCode: result.reasonCode,
        errorMessage: result.errorMessage,
        processedAt: result.processedAt,
        createdAt: result.createdAt,
      })),
    };
  }
}