import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataResidencyClass, DataResidencyPolicy, Prisma } from "@prisma/client";
import { AuthenticatedUser } from "../../auth/auth.types";
import { PrismaService } from "../../database/prisma.service";
import { RecordResidencyAssignmentDto } from "./dto/record-residency-assignment.dto";
import { SetResidencyPolicyDto } from "./dto/set-residency-policy.dto";

/**
 * Enforces per-organization, per-data-class region allow-lists.
 *
 * The allow-list is explicit: a data class with no ACTIVE policy is denied
 * outright rather than falling back to some default region, and updating a
 * policy is itself rejected if it would strand data already assigned
 * outside the new allow-list.
 */
@Injectable()
export class DataResidencyService {
  constructor(private readonly prisma: PrismaService) {}

  async setPolicy(
    user: AuthenticatedUser,
    organizationId: string,
    dto: SetResidencyPolicyDto,
  ): Promise<DataResidencyPolicy> {
    await this.assertOrgAccess(user, organizationId);

    const allowedRegions = [...new Set(dto.allowedRegions)];

    // Fail the policy change if any existing assignment would be stranded
    // outside the new allow-list, rather than letting data silently become
    // non-compliant.
    const violating = await this.prisma.dataResidencyAssignment.findFirst({
      where: {
        organizationId,
        dataClass: dto.dataClass,
        region: { notIn: allowedRegions },
      },
    });

    if (violating) {
      throw new ConflictException(
        `Cannot update residency policy: ${violating.resourceType} "${violating.resourceId}" ` +
          `is assigned to region "${violating.region}", which is outside the requested allow-list`,
      );
    }

    const current = await this.prisma.dataResidencyPolicy.findFirst({
      where: { organizationId, dataClass: dto.dataClass, status: "ACTIVE" },
      orderBy: { version: "desc" },
    });

    const nextVersion = (current?.version ?? 0) + 1;

    const created = await this.prisma.$transaction(async (tx) => {
      if (current) {
        await tx.dataResidencyPolicy.update({
          where: { id: current.id },
          data: { status: "SUPERSEDED" },
        });
      }

      return tx.dataResidencyPolicy.create({
        data: {
          organizationId,
          dataClass: dto.dataClass,
          allowedRegions: allowedRegions as Prisma.InputJsonValue,
          version: nextVersion,
          createdById: user.id,
          supersedesId: current?.id,
        },
      });
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action: "residency.policy.set",
        resourceType: "DataResidencyPolicy",
        resourceId: created.id,
        metadata: { organizationId, dataClass: dto.dataClass, allowedRegions, version: nextVersion },
      },
    });

    return created;
  }

  getActivePolicy(
    organizationId: string,
    dataClass: DataResidencyClass,
  ): Promise<DataResidencyPolicy | null> {
    return this.prisma.dataResidencyPolicy.findFirst({
      where: { organizationId, dataClass, status: "ACTIVE" },
    });
  }

  /**
   * Throws unless the given region is explicitly permitted by the
   * organization's active policy for this data class. A missing policy is a
   * denial, never an implicit allow.
   */
  async assertRegionAllowed(
    organizationId: string,
    dataClass: DataResidencyClass,
    region: string,
  ): Promise<void> {
    const policy = await this.getActivePolicy(organizationId, dataClass);

    if (!policy) {
      throw new ForbiddenException(
        `No active ${dataClass} residency policy for this organization — refusing to place data in "${region}"`,
      );
    }

    const allowedRegions = policy.allowedRegions as unknown as string[];
    if (!allowedRegions.includes(region)) {
      throw new ForbiddenException(
        `Region "${region}" is not permitted by the active ${dataClass} residency policy ` +
          `(allowed: ${allowedRegions.join(", ")})`,
      );
    }
  }

  /**
   * Record where a concrete resource (a write, export, backup, queued job,
   * or deployment target) lives, after checking it against the active
   * policy. Upsert is keyed on (org, dataClass, resourceType, resourceId) so
   * re-recording the same resource in a now-disallowed region is rejected
   * rather than silently overwritten.
   */
  async recordAssignment(organizationId: string, dto: RecordResidencyAssignmentDto) {
    await this.assertRegionAllowed(organizationId, dto.dataClass, dto.region);

    return this.prisma.dataResidencyAssignment.upsert({
      where: {
        organizationId_dataClass_resourceType_resourceId: {
          organizationId,
          dataClass: dto.dataClass,
          resourceType: dto.resourceType,
          resourceId: dto.resourceId,
        },
      },
      create: {
        organizationId,
        dataClass: dto.dataClass,
        resourceType: dto.resourceType,
        resourceId: dto.resourceId,
        region: dto.region,
      },
      update: { region: dto.region },
    });
  }

  private async assertOrgAccess(user: AuthenticatedUser, organizationId: string): Promise<void> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { createdById: true },
    });

    if (!org) {
      throw new NotFoundException(`Organization ${organizationId} not found`);
    }

    if (user.role !== "ADMIN" && org.createdById !== user.id) {
      throw new ForbiddenException(
        "You do not have permission to manage residency policy for this organization",
      );
    }
  }
}
