import {
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ResourceStatus,
  OrganizationMemberRole,
} from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import {
  OrganizationReadinessCheckDto,
  OrganizationReadinessResponseDto,
  OrganizationReadinessState,
} from "./dto/organization-readiness-response.dto";

const READINESS_VERSION = "1.0";

@Injectable()
export class OrganizationReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async assess(
    organizationId: string,
  ): Promise<OrganizationReadinessResponseDto> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        status: true,
        members: {
          where: {
            status: ResourceStatus.ACTIVE,
          },
          select: {
            role: true,
          },
        },
        issuers: {
          where: {
            status: {
              not: ResourceStatus.DELETED,
            },
          },
          select: {
            id: true,
            status: true,
            contractSyncState: true,
            contractSyncedStatus: true,
          },
        },
        apiKeys: {
          where: {
            status: ResourceStatus.ACTIVE,
          },
          select: {
            id: true,
          },
        },
        webhooks: {
          where: {
            status: ResourceStatus.ACTIVE,
          },
          select: {
            id: true,
          },
        },
      },
    });

    if (!organization) {
      throw new NotFoundException("Organization not found");
    }

    if (organization.status === ResourceStatus.DELETED) {
      return {
        organizationId,
        version: READINESS_VERSION,
        state: "ARCHIVED",
        checks: [
          {
            id: "organization-active",
            name: "Organization is active",
            kind: "REQUIRED",
            status: "FAILED",
            action: "restore-organization",
            message: "The organization is archived.",
          },
        ],
        generatedAt: new Date().toISOString(),
      };
    }

    const hasOwner = organization.members.some(
      (member) => member.role === OrganizationMemberRole.OWNER,
    );

    const activeIssuer = organization.issuers.find(
      (issuer) => issuer.status === ResourceStatus.ACTIVE,
    );

    const checks: OrganizationReadinessCheckDto[] = [
      {
        id: "organization-active",
        name: "Organization is active",
        kind: "REQUIRED",
        status:
          organization.status === ResourceStatus.ACTIVE
            ? "PASSED"
            : "FAILED",
        action:
          organization.status === ResourceStatus.ACTIVE
            ? "none"
            : "activate-organization",
        message:
          organization.status === ResourceStatus.ACTIVE
            ? "Organization is active."
            : "Organization is not active.",
      },
      {
        id: "organization-owner",
        name: "Organization has an active owner",
        kind: "REQUIRED",
        status: hasOwner ? "PASSED" : "FAILED",
        action: hasOwner ? "none" : "assign-owner",
        message: hasOwner
          ? "An active owner is assigned."
          : "No active owner is assigned.",
      },
      {
        id: "issuer-configured",
        name: "Active issuer configured",
        kind: "REQUIRED",
        status: activeIssuer ? "PASSED" : "FAILED",
        action: activeIssuer ? "none" : "create-issuer",
        message: activeIssuer
          ? "At least one active issuer is configured."
          : "No active issuer is configured.",
      },
      {
        id: "issuer-contract-sync",
        name: "Issuer contract state synchronized",
        kind: "REQUIRED",
        status: this.contractStatus(activeIssuer),
        action:
          activeIssuer?.contractSyncState === "FAILED"
            ? "sync-issuer-contract"
            : "none",
        message: this.contractMessage(activeIssuer),
      },
      {
        id: "api-key",
        name: "Active API key configured",
        kind: "OPTIONAL",
        status:
          organization.apiKeys.length > 0 ? "PASSED" : "FAILED",
        action:
          organization.apiKeys.length > 0
            ? "none"
            : "create-api-key",
        message:
          organization.apiKeys.length > 0
            ? "At least one active API key is configured."
            : "No active API key is configured.",
      },
      {
        id: "webhook",
        name: "Active webhook configured",
        kind: "OPTIONAL",
        status:
          organization.webhooks.length > 0 ? "PASSED" : "FAILED",
        action:
          organization.webhooks.length > 0
            ? "none"
            : "create-webhook",
        message:
          organization.webhooks.length > 0
            ? "At least one active webhook is configured."
            : "No active webhook is configured.",
      },
    ];

    return {
      organizationId,
      version: READINESS_VERSION,
      state: this.resolveState(
        organization.status,
        checks,
      ),
      checks,
      generatedAt: new Date().toISOString(),
    };
  }

  private contractStatus(
    issuer:
      | {
          contractSyncState: string;
          contractSyncedStatus: ResourceStatus | null;
        }
      | undefined,
  ): "PASSED" | "FAILED" | "UNAVAILABLE" {
    if (!issuer) {
      return "UNAVAILABLE";
    }

    if (
      issuer.contractSyncState === "FAILED" ||
      issuer.contractSyncedStatus === ResourceStatus.REVOKED ||
      issuer.contractSyncedStatus === ResourceStatus.SUSPENDED
    ) {
      return "FAILED";
    }

    if (
      issuer.contractSyncState !== "CONFIRMED" ||
      !issuer.contractSyncedStatus
    ) {
      return "UNAVAILABLE";
    }

    return "PASSED";
  }

  private contractMessage(
    issuer:
      | {
          contractSyncState: string;
          contractSyncedStatus: ResourceStatus | null;
        }
      | undefined,
  ): string {
    if (!issuer) {
      return "No issuer is available for contract synchronization.";
    }

    if (issuer.contractSyncState === "FAILED") {
      return "Issuer contract synchronization failed.";
    }

    if (
      issuer.contractSyncState !== "CONFIRMED" ||
      !issuer.contractSyncedStatus
    ) {
      return "Issuer contract synchronization is not yet confirmed.";
    }

    return "Issuer contract state is synchronized.";
  }

  private resolveState(
    organizationStatus: ResourceStatus,
    checks: OrganizationReadinessCheckDto[],
  ): OrganizationReadinessState {
    if (organizationStatus === ResourceStatus.DELETED) {
      return "ARCHIVED";
    }

    const required = checks.filter(
      (check) => check.kind === "REQUIRED",
    );

    const failedRequired = required.some(
      (check) => check.status === "FAILED",
    );

    const unavailableRequired = required.some(
      (check) => check.status === "UNAVAILABLE",
    );

    const failedOptional = checks.some(
      (check) =>
        check.kind === "OPTIONAL" &&
        check.status === "FAILED",
    );

    if (failedRequired) {
      return "BLOCKED";
    }

    if (unavailableRequired) {
      return "DEGRADED";
    }

    if (failedOptional) {
      return "PARTIAL";
    }

    return "READY";
  }
}
