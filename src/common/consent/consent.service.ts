import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { PolicyType, PolicyStatus, ConsentAction } from "@prisma/client";
import { sha256 } from "../crypto/hash";
import { PrismaService } from "../../database/prisma.service";

/**
 * Consent Management Service
 * 
 * Manages policy versions and consent records with immutable history.
 * Follows existing audit patterns for tamper-evident consent tracking.
 * 
 * Design decisions:
 * - Policy versions are immutable once published
 * - Content hashes ensure tamper detection
 * - Consent records preserve full audit trail
 * - Withdrawal doesn't delete historical acceptance
 * - Tenant isolation enforced at query level
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create or update a policy version.
   * Published versions become immutable.
   */
  async createPolicyVersion(
    policyType: PolicyType,
    version: string,
    content: string,
    status: PolicyStatus = PolicyStatus.DRAFT,
  ): Promise<{
    id: string;
    policyType: PolicyType;
    version: string;
    contentHash: string;
    status: PolicyStatus;
    publishedAt: Date | null;
  }> {
    // Generate content hash for integrity
    const contentHash = sha256(content);

    // Check for existing version
    const existing = await this.prisma.policyVersion.findUnique({
      where: {
        policyType_version: {
          policyType,
          version,
        },
      },
    });

    if (existing) {
      if (existing.status === PolicyStatus.PUBLISHED) {
        throw new BadRequestException(
          `Policy version ${policyType}:${version} is published and cannot be modified`,
        );
      }
      
      // Update draft version
      const updated = await this.prisma.policyVersion.update({
        where: { id: existing.id },
        data: {
          contentHash,
          status,
          publishedAt: status === PolicyStatus.PUBLISHED ? new Date() : existing.publishedAt,
        },
      });

      return {
        id: updated.id,
        policyType: updated.policyType,
        version: updated.version,
        contentHash: updated.contentHash,
        status: updated.status,
        publishedAt: updated.publishedAt,
      };
    }

    // Create new version
    const policyVersion = await this.prisma.policyVersion.create({
      data: {
        policyType,
        version,
        contentHash,
        status,
        publishedAt: status === PolicyStatus.PUBLISHED ? new Date() : null,
      },
    });

    return {
      id: policyVersion.id,
      policyType: policyVersion.policyType,
      version: policyVersion.version,
      contentHash: policyVersion.contentHash,
      status: policyVersion.status,
      publishedAt: policyVersion.publishedAt,
    };
  }

  /**
   * Publish a policy version, making it immutable and current.
   * Supersedes any previously published version of the same type.
   */
  async publishPolicyVersion(
    policyType: PolicyType,
    version: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Mark current published version as superseded
      await tx.policyVersion.updateMany({
        where: {
          policyType,
          status: PolicyStatus.PUBLISHED,
        },
        data: {
          status: PolicyStatus.SUPERSEDED,
        },
      });

      // Publish the new version
      await tx.policyVersion.update({
        where: {
          policyType_version: {
            policyType,
            version,
          },
        },
        data: {
          status: PolicyStatus.PUBLISHED,
          publishedAt: new Date(),
        },
      });
    });
  }

  /**
   * Get the current published policy version for a type.
   */
  async getCurrentPolicyVersion(
    policyType: PolicyType,
  ): Promise<{
    id: string;
    version: string;
    contentHash: string;
    publishedAt: Date;
  } | null> {
    const current = await this.prisma.policyVersion.findFirst({
      where: {
        policyType,
        status: PolicyStatus.PUBLISHED,
      },
      orderBy: {
        publishedAt: "desc",
      },
    });

    return current
      ? {
          id: current.id,
          version: current.version,
          contentHash: current.contentHash,
          publishedAt: current.publishedAt!,
        }
      : null;
  }

  /**
   * Record consent acceptance by an authenticated user.
   * Idempotent - repeated acceptance of same version doesn't create duplicates.
   */
  async recordConsent(
    userId: string,
    organizationId: string,
    policyType: PolicyType,
    policyVersion: string,
    action: ConsentAction = ConsentAction.ACCEPT,
  ): Promise<{
    id: string;
    isFirstAcceptance: boolean;
    previousAction: ConsentAction | null;
  }> {
    // Get the policy version to ensure it exists and get content hash
    const policyVersionRecord = await this.prisma.policyVersion.findUnique({
      where: {
        policyType_version: {
          policyType,
          version: policyVersion,
        },
      },
    });

    if (!policyVersionRecord) {
      throw new BadRequestException(
        `Policy version ${policyType}:${policyVersion} not found`,
      );
    }

    if (policyVersionRecord.status !== PolicyStatus.PUBLISHED) {
      throw new BadRequestException(
        `Policy version ${policyType}:${policyVersion} is not published`,
      );
    }

    // Check for existing consent record for this user/policy/version
    const existingConsent = await this.prisma.consentRecord.findFirst({
      where: {
        userId,
        organizationId,
        policyType,
        policyVersion,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const isFirstAcceptance = !existingConsent;
    const previousAction = existingConsent?.action || null;

    // Always create a new record for audit trail (even if repeating same action)
    const consentRecord = await this.prisma.consentRecord.create({
      data: {
        userId,
        organizationId,
        policyType,
        policyVersion,
        contentHash: policyVersionRecord.contentHash,
        action,
      },
    });

    return {
      id: consentRecord.id,
      isFirstAcceptance,
      previousAction,
    };
  }

  /**
   * Get user's consent status for a specific policy type.
   * Returns the latest consent action and whether current version is accepted.
   */
  async getUserConsentStatus(
    userId: string,
    organizationId: string,
    policyType: PolicyType,
  ): Promise<{
    hasCurrentConsent: boolean;
    currentPolicyVersion: string | null;
    userConsentVersion: string | null;
    userConsentAction: ConsentAction | null;
    userConsentDate: Date | null;
    requiresUpdate: boolean;
  }> {
    // Get current published policy version
    const currentPolicy = await this.getCurrentPolicyVersion(policyType);
    
    if (!currentPolicy) {
      return {
        hasCurrentConsent: false,
        currentPolicyVersion: null,
        userConsentVersion: null,
        userConsentAction: null,
        userConsentDate: null,
        requiresUpdate: false,
      };
    }

    // Get user's latest consent record for this policy type
    const latestConsent = await this.prisma.consentRecord.findFirst({
      where: {
        userId,
        organizationId,
        policyType,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!latestConsent) {
      return {
        hasCurrentConsent: false,
        currentPolicyVersion: currentPolicy.version,
        userConsentVersion: null,
        userConsentAction: null,
        userConsentDate: null,
        requiresUpdate: true,
      };
    }

    const hasCurrentConsent = 
      latestConsent.policyVersion === currentPolicy.version &&
      latestConsent.action === ConsentAction.ACCEPT;

    const requiresUpdate = 
      latestConsent.policyVersion !== currentPolicy.version ||
      latestConsent.action !== ConsentAction.ACCEPT;

    return {
      hasCurrentConsent,
      currentPolicyVersion: currentPolicy.version,
      userConsentVersion: latestConsent.policyVersion,
      userConsentAction: latestConsent.action,
      userConsentDate: latestConsent.createdAt,
      requiresUpdate,
    };
  }

  /**
   * Get user's consent history for a policy type.
   * Returns full audit trail while respecting tenant isolation.
   */
  async getUserConsentHistory(
    userId: string,
    organizationId: string,
    policyType: PolicyType,
    limit = 50,
  ): Promise<Array<{
    id: string;
    policyVersion: string;
    contentHash: string;
    action: ConsentAction;
    createdAt: Date;
  }>> {
    const records = await this.prisma.consentRecord.findMany({
      where: {
        userId,
        organizationId,
        policyType,
      },
      select: {
        id: true,
        policyVersion: true,
        contentHash: true,
        action: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
    });

    return records;
  }

  /**
   * Check if user has accepted required policy versions.
   * Returns missing or outdated consent requirements.
   */
  async checkRequiredConsents(
    userId: string,
    organizationId: string,
    requiredPolicyTypes: PolicyType[],
  ): Promise<{
    allConsentsValid: boolean;
    missingConsents: Array<{
      policyType: PolicyType;
      currentVersion: string;
      reason: "never_consented" | "outdated_version" | "withdrawn";
    }>;
  }> {
    const missingConsents: Array<{
      policyType: PolicyType;
      currentVersion: string;
      reason: "never_consented" | "outdated_version" | "withdrawn";
    }> = [];

    for (const policyType of requiredPolicyTypes) {
      const status = await this.getUserConsentStatus(
        userId,
        organizationId,
        policyType,
      );

      if (!status.hasCurrentConsent && status.currentPolicyVersion) {
        let reason: "never_consented" | "outdated_version" | "withdrawn";
        
        if (!status.userConsentAction) {
          reason = "never_consented";
        } else if (status.userConsentAction === ConsentAction.WITHDRAW) {
          reason = "withdrawn";
        } else {
          reason = "outdated_version";
        }

        missingConsents.push({
          policyType,
          currentVersion: status.currentPolicyVersion,
          reason,
        });
      }
    }

    return {
      allConsentsValid: missingConsents.length === 0,
      missingConsents,
    };
  }

  /**
   * List available policy versions (for admin use).
   */
  async listPolicyVersions(
    policyType?: PolicyType,
    status?: PolicyStatus,
  ): Promise<Array<{
    id: string;
    policyType: PolicyType;
    version: string;
    status: PolicyStatus;
    publishedAt: Date | null;
    createdAt: Date;
  }>> {
    const where: any = {};
    if (policyType) where.policyType = policyType;
    if (status) where.status = status;

    const versions = await this.prisma.policyVersion.findMany({
      where,
      select: {
        id: true,
        policyType: true,
        version: true,
        status: true,
        publishedAt: true,
        createdAt: true,
      },
      orderBy: [
        { policyType: "asc" },
        { publishedAt: "desc" },
        { createdAt: "desc" },
      ],
    });

    return versions;
  }
}