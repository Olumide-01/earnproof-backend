import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, ResourceStatus } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { ConflictException } from "../common/exceptions/domain.exceptions";
import { CreateSupportedAssetDto } from "./dto/create-supported-asset.dto";
import { UpdateSupportedAssetDto } from "./dto/update-supported-asset.dto";
import { UpdateAssetStatusDto } from "./dto/update-asset-status.dto";
import { ListSupportedAssetsDto } from "./dto/list-supported-assets.dto";
import { SupportedAssetResponseDto } from "./dto/supported-asset-response.dto";

// Valid status transitions
const VALID_TRANSITIONS: Record<ResourceStatus, ResourceStatus[]> = {
  [ResourceStatus.PENDING]: [ResourceStatus.ACTIVE],
  [ResourceStatus.ACTIVE]: [ResourceStatus.SUSPENDED, ResourceStatus.REVOKED],
  [ResourceStatus.SUSPENDED]: [ResourceStatus.ACTIVE, ResourceStatus.REVOKED],
  [ResourceStatus.REVOKED]: [],
  [ResourceStatus.DELETED]: [],
  [ResourceStatus.EXPIRED]: [],
};

@Injectable()
export class SupportedAssetsService {
  constructor(private readonly prisma: PrismaService) {}

  async createAsset(
    user: AuthenticatedUser,
    input: CreateSupportedAssetDto,
  ): Promise<SupportedAssetResponseDto> {
    // Verify organization exists and user has access
    const org = await this.prisma.organization.findUnique({
      where: { id: input.organizationId },
    });

    if (!org) {
      throw new NotFoundException(
        `Organization with ID "${input.organizationId}" not found`,
      );
    }

    // Authorization check
    if (user.role !== "ADMIN") {
      const membership = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: input.organizationId,
            userId: user.id,
          },
        },
      });

      if (!membership) {
        throw new ForbiddenException(
          "You do not have permission to manage this organization",
        );
      }

      if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
        throw new ForbiddenException(
          "Only organization owners and admins can create assets",
        );
      }
    }

    // Compute assetKey
    const assetKey = this.computeAssetKey(
      input.network,
      input.code,
      input.issuer,
    );

    // Check for duplicate asset in the same organization
    const existing = await this.prisma.supportedAsset.findUnique({
      where: {
        organizationId_assetKey: {
          organizationId: input.organizationId,
          assetKey,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        `Asset "${input.code}" on network "${input.network}" with issuer "${input.issuer || "native"}" already exists in this organization`,
        existing.revision,
      );
    }

    // Create the asset
    const asset = await this.prisma.supportedAsset.create({
      data: {
        organizationId: input.organizationId,
        assetKey,
        code: input.code,
        issuer: input.issuer ?? null,
        network: input.network,
        decimals: input.decimals ?? 7,
        status: ResourceStatus.ACTIVE,
        revision: 0,
      },
    });

    // Log audit event
    await this.createAuditLog(user, "CREATE", "SupportedAsset", asset.id, {
      organizationId: input.organizationId,
      assetKey,
      code: input.code,
      issuer: input.issuer,
      network: input.network,
      decimals: input.decimals ?? 7,
    });

    return this.toResponseDto(asset);
  }

  async updateAsset(
    user: AuthenticatedUser,
    assetId: string,
    input: UpdateSupportedAssetDto,
  ): Promise<SupportedAssetResponseDto> {
    const asset = await this.getAssetById(assetId);

    // Authorization check
    await this.checkAssetAccess(
      user,
      asset.organizationId,
      ["OWNER", "ADMIN"],
    );

    // Attempt optimistic update with revision check
    const updated = await this.prisma.supportedAsset.updateMany({
      where: {
        id: assetId,
        revision: input.expectedRevision,
      },
      data: {
        decimals: input.decimals,
        revision: input.expectedRevision + 1,
      },
    });

    // If no records were updated, the revision didn't match
    if (updated.count === 0) {
      throw new ConflictException(
        "Asset has been modified by another request. Please refresh and retry.",
        asset.revision,
      );
    }

    const result = await this.prisma.supportedAsset.findUniqueOrThrow({
      where: { id: assetId },
    });

    // Log audit event
    await this.createAuditLog(user, "UPDATE", "SupportedAsset", assetId, {
      previousDecimals: asset.decimals,
      newDecimals: input.decimals,
      revision: result.revision,
    });

    return this.toResponseDto(result);
  }

  async updateAssetStatus(
    user: AuthenticatedUser,
    assetId: string,
    input: UpdateAssetStatusDto,
  ): Promise<SupportedAssetResponseDto> {
    const asset = await this.getAssetById(assetId);

    // Authorization check
    await this.checkAssetAccess(
      user,
      asset.organizationId,
      ["OWNER", "ADMIN"],
    );

    // Validate status transition
    const validNextStatuses = VALID_TRANSITIONS[asset.status];
    if (!validNextStatuses.includes(input.status)) {
      throw new BadRequestException(
        `Invalid status transition: ${asset.status} → ${input.status}. ` +
          `Valid transitions from ${asset.status} are: ${validNextStatuses.join(", ") || "none"}`,
      );
    }

    // Attempt optimistic update with revision check
    const updated = await this.prisma.supportedAsset.updateMany({
      where: {
        id: assetId,
        revision: input.expectedRevision,
      },
      data: {
        status: input.status,
        revision: input.expectedRevision + 1,
      },
    });

    // If no records were updated, the revision didn't match
    if (updated.count === 0) {
      throw new ConflictException(
        "Asset has been modified by another request. Please refresh and retry.",
        asset.revision,
      );
    }

    const result = await this.prisma.supportedAsset.findUniqueOrThrow({
      where: { id: assetId },
    });

    // Log audit event
    await this.createAuditLog(
      user,
      "UPDATE_STATUS",
      "SupportedAsset",
      assetId,
      {
        previousStatus: asset.status,
        newStatus: input.status,
        revision: result.revision,
      },
    );

    return this.toResponseDto(result);
  }

  async deleteAsset(
    user: AuthenticatedUser,
    assetId: string,
  ): Promise<SupportedAssetResponseDto> {
    const asset = await this.getAssetById(assetId);

    // Authorization check - only owners can delete
    await this.checkAssetAccess(user, asset.organizationId, ["OWNER"]);

    // Soft delete by setting status to DELETED
    const deleted = await this.prisma.supportedAsset.update({
      where: { id: assetId },
      data: {
        status: ResourceStatus.DELETED,
        revision: asset.revision + 1,
      },
    });

    // Log audit event
    await this.createAuditLog(user, "DELETE", "SupportedAsset", assetId, {
      assetKey: asset.assetKey,
      organizationId: asset.organizationId,
    });

    return this.toResponseDto(deleted);
  }

  async getAsset(
    user: AuthenticatedUser,
    assetId: string,
  ): Promise<SupportedAssetResponseDto> {
    const asset = await this.getAssetById(assetId);

    // Authorization check - members can read
    await this.checkAssetAccess(
      user,
      asset.organizationId,
      ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
    );

    return this.toResponseDto(asset);
  }

  async listAssets(
    user: AuthenticatedUser,
    query: ListSupportedAssetsDto,
  ): Promise<{
    items: SupportedAssetResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.SupportedAssetWhereInput = {};

    // Apply filters
    if (query.organizationId) {
      // Check access to the organization
      await this.checkAssetAccess(
        user,
        query.organizationId,
        ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
      );
      where.organizationId = query.organizationId;
    } else if (user.role !== "ADMIN") {
      // Non-admins can only see assets from their organizations
      const memberships = await this.prisma.organizationMember.findMany({
        where: { userId: user.id, status: ResourceStatus.ACTIVE },
        select: { organizationId: true },
      });

      where.organizationId = {
        in: memberships.map((m) => m.organizationId),
      };
    }

    if (query.network) {
      where.network = query.network;
    }

    if (query.status) {
      where.status = query.status;
    }

    const [items, total] = await Promise.all([
      this.prisma.supportedAsset.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.supportedAsset.count({ where }),
    ]);

    return {
      items: items.map((asset) => this.toResponseDto(asset)),
      total,
      page,
      limit,
    };
  }

  private async getAssetById(assetId: string) {
    const asset = await this.prisma.supportedAsset.findUnique({
      where: { id: assetId },
    });

    if (!asset) {
      throw new NotFoundException(
        `Supported asset with ID "${assetId}" not found`,
      );
    }

    return asset;
  }

  private async checkAssetAccess(
    user: AuthenticatedUser,
    organizationId: string,
    allowedRoles: string[],
  ) {
    if (user.role === "ADMIN") {
      return; // Admins have full access
    }

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: user.id,
        },
      },
    });

    if (!membership || membership.status !== ResourceStatus.ACTIVE) {
      throw new ForbiddenException(
        "You do not have permission to access this organization",
      );
    }

    if (!allowedRoles.includes(membership.role)) {
      throw new ForbiddenException(
        `Insufficient permissions. Required role: ${allowedRoles.join(" or ")}`,
      );
    }
  }

  private computeAssetKey(
    network: string,
    code: string,
    issuer?: string | null,
  ): string {
    return `${network}:${code}:${issuer || "native"}`;
  }

  private toResponseDto(asset: any): SupportedAssetResponseDto {
    return {
      id: asset.id,
      organizationId: asset.organizationId,
      assetKey: asset.assetKey,
      code: asset.code,
      issuer: asset.issuer,
      network: asset.network,
      decimals: asset.decimals,
      status: asset.status,
      revision: asset.revision,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    };
  }

  private createAuditLog(
    user: AuthenticatedUser,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: any,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action,
        resourceType,
        resourceId,
        metadata,
        createdAt: new Date(),
      },
    });
  }
}
