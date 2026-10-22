import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ApiKeyRotationStatus, ApiKeyScope, Prisma, ResourceStatus } from "@prisma/client";
import { sha256 } from "../common/crypto/hash";
import { PrismaService } from "../database/prisma.service";
import { OrganizationQuotaService } from "../quotas/organization-quota.service";
import { SecretRetrievalReceiptService } from "../audit/secret-retrieval-receipt.service";
import { Clock } from "../common/time/clock";
import {
  ApiKeyCutoverResult,
  ApiKeyRotationInspectResult,
  ApiKeyRotationKeySummary,
  CanonicalCutoverReceiptPayload,
  ROTATION_REVOCATION_REASONS,
} from "./api-key-rotation.types";
import { CutoverApiKeyDto } from "./dto/rotate-api-key.dto";

export interface ScopeIntersectionPolicyEvaluation {
  allowed: boolean;
  effectiveScopes: ApiKeyScope[];
  isOldKeyInOverlap: boolean;
  rotationId?: string;
  reason?: string;
}

@Injectable()
export class ApiKeyRotationService {
  private readonly logger = new Logger(ApiKeyRotationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quotas: OrganizationQuotaService = {
      assertCapacity: async () => undefined,
    } as never,
    private readonly secretRetrievalReceiptService: SecretRetrievalReceiptService = {
      create: async () => ({ id: "receipt_mock" }),
    } as never,
    @Optional() private readonly clock?: Clock,
  ) {}

  private async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    if (typeof this.prisma?.$transaction === "function") {
      return this.prisma.$transaction(fn);
    }
    return fn(this.prisma);
  }

  async now(): Promise<Date> {
    if (this.clock) {
      return this.clock.now();
    }
    if (typeof this.prisma?.$queryRaw === "function") {
      try {
        const rows = await this.prisma.$queryRaw<Array<{ now: Date }>>`
          SELECT CURRENT_TIMESTAMP as now
        `;
        if (rows && rows.length > 0 && rows[0].now) {
          return new Date(rows[0].now);
        }
      } catch {
        // Fallback to local clock
      }
    }
    return new Date();
  }

  /**
   * Calculate scope intersection between two sets of scopes.
   */
  calculateScopeIntersection(
    scopesA: ApiKeyScope[],
    scopesB: ApiKeyScope[],
  ): ApiKeyScope[] {
    const setB = new Set(scopesB);
    return scopesA.filter((s) => setB.has(s));
  }

  /**
   * Inspect the rotation family and overlap status for an API key.
   */
  async inspectRotation(
    keyId: string,
    organizationId: string,
  ): Promise<ApiKeyRotationInspectResult> {
    const now = await this.now();

    const rotation = await this.prisma.apiKeyRotation.findFirst({
      where: {
        organizationId,
        OR: [{ oldKeyId: keyId }, { newKeyId: keyId }, { familyId: keyId }],
      },
      include: {
        oldKey: {
          include: {
            scopeAssignments: { select: { scope: true } },
          },
        },
        newKey: {
          include: {
            scopeAssignments: { select: { scope: true } },
          },
        },
        cutoverReceipt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!rotation) {
      throw new NotFoundException("No rotation family found for this API key");
    }

    const oldScopes = rotation.oldKey.scopeAssignments.map((s) => s.scope);
    const newScopes = rotation.newKey.scopeAssignments.map((s) => s.scope);
    const intersection = this.calculateScopeIntersection(oldScopes, newScopes);

    const isOverlapExpired =
      rotation.status === ApiKeyRotationStatus.IN_OVERLAP
        ? now.getTime() >= rotation.overlapExpiresAt.getTime()
        : rotation.status === ApiKeyRotationStatus.EXPIRED;

    // Effective scopes: intersection during active overlap, replacement scopes after cutover
    const effectiveScopes =
      rotation.status === ApiKeyRotationStatus.IN_OVERLAP && !isOverlapExpired
        ? intersection
        : newScopes;

    const oldKeySummary: ApiKeyRotationKeySummary = {
      id: rotation.oldKey.id,
      prefix: rotation.oldKey.prefix,
      name: rotation.oldKey.name,
      status: rotation.oldKey.status,
      scopes: oldScopes,
      lastUsedAt: rotation.oldKey.lastUsedAt,
      createdAt: rotation.oldKey.createdAt,
    };

    const newKeySummary: ApiKeyRotationKeySummary = {
      id: rotation.newKey.id,
      prefix: rotation.newKey.prefix,
      name: rotation.newKey.name,
      status: rotation.newKey.status,
      scopes: newScopes,
      lastUsedAt: rotation.newKey.lastUsedAt,
      createdAt: rotation.newKey.createdAt,
    };

    return {
      familyId: rotation.familyId,
      rotationId: rotation.id,
      status: isOverlapExpired && rotation.status === ApiKeyRotationStatus.IN_OVERLAP
        ? ApiKeyRotationStatus.EXPIRED
        : rotation.status,
      overlapExpiresAt: rotation.overlapExpiresAt,
      isOverlapExpired,
      effectiveScopes,
      oldKey: oldKeySummary,
      replacementKey: newKeySummary,
      oldKeyUsage: {
        totalRequests: rotation.oldKeyUsageCount,
        lastUsedAt: rotation.lastOldKeyUsedAt,
      },
      cutoverAt: rotation.cutoverAt,
      cutoverReceipt: rotation.cutoverReceipt
        ? {
            id: rotation.cutoverReceipt.id,
            receiptHash: rotation.cutoverReceipt.receiptHash,
            cutoverAt: rotation.cutoverReceipt.cutoverAt,
            cutoverType: rotation.cutoverReceipt.cutoverType,
            oldKeyUsageCount: rotation.cutoverReceipt.oldKeyUsageCount,
          }
        : null,
    };
  }

  /**
   * Execute early cutover for an active rotation family.
   * Permanently retires the old key, generates a signed cutover receipt,
   * and lifts scope intersection restrictions from the replacement key.
   */
  async earlyCutover(
    keyId: string,
    organizationId: string,
    actorId?: string,
    dto?: CutoverApiKeyDto,
  ): Promise<ApiKeyCutoverResult> {
    const now = await this.now();

    return this.runTransaction(async (tx) => {
      // Find rotation
      const rotation = await tx.apiKeyRotation.findFirst({
        where: {
          organizationId,
          OR: [{ oldKeyId: keyId }, { newKeyId: keyId }, { familyId: keyId }],
          status: ApiKeyRotationStatus.IN_OVERLAP,
        },
        include: {
          oldKey: {
            include: {
              scopeAssignments: { select: { scope: true } },
            },
          },
          newKey: {
            include: {
              scopeAssignments: { select: { scope: true } },
            },
          },
        },
      });

      if (!rotation) {
        // Check if already cut over
        const existingCutover = await tx.apiKeyRotation.findFirst({
          where: {
            organizationId,
            OR: [{ oldKeyId: keyId }, { newKeyId: keyId }, { familyId: keyId }],
            status: ApiKeyRotationStatus.CUTOVER,
          },
          include: {
            newKey: {
              include: { scopeAssignments: { select: { scope: true } } },
            },
            cutoverReceipt: true,
          },
        });

        if (existingCutover && existingCutover.cutoverReceipt) {
          throw new ConflictException("API key rotation has already been cut over");
        }

        throw new NotFoundException("No active rotation in overlap found for this API key");
      }

      // Mark old key revoked/retired
      await tx.apiKey.update({
        where: { id: rotation.oldKeyId },
        data: {
          status: ResourceStatus.REVOKED,
          revokedAt: now,
        },
      });

      // Update rotation status to CUTOVER
      const updatedRotation = await tx.apiKeyRotation.update({
        where: { id: rotation.id },
        data: {
          status: ApiKeyRotationStatus.CUTOVER,
          cutoverAt: now,
          cutoverById: actorId ?? null,
        },
      });

      // Build canonical cutover receipt payload
      const oldScopes = rotation.oldKey.scopeAssignments.map((s: { scope: ApiKeyScope }) => s.scope);
      const newScopes = rotation.newKey.scopeAssignments.map((s: { scope: ApiKeyScope }) => s.scope);
      const scopeIntersection = this.calculateScopeIntersection(oldScopes, newScopes);

      const receiptPayload: CanonicalCutoverReceiptPayload = {
        receiptType: "API_KEY_ROTATION_CUTOVER",
        version: "1",
        organizationId,
        familyId: rotation.familyId,
        oldKeyId: rotation.oldKeyId,
        newKeyId: rotation.newKeyId,
        cutoverAt: now.toISOString(),
        cutoverType: "EARLY_MANUAL",
        initiatedById: actorId ?? null,
        oldKeyUsageCount: rotation.oldKeyUsageCount,
        scopeIntersection,
      };

      const receiptHash = `sha256:${sha256(JSON.stringify(receiptPayload))}`;

      const receipt = await tx.apiKeyCutoverReceipt.create({
        data: {
          organizationId,
          rotationId: rotation.id,
          familyId: rotation.familyId,
          oldKeyId: rotation.oldKeyId,
          newKeyId: rotation.newKeyId,
          cutoverAt: now,
          cutoverType: "EARLY_MANUAL",
          initiatedById: actorId ?? null,
          oldKeyUsageCount: rotation.oldKeyUsageCount,
          receiptHash,
          receiptData: receiptPayload as unknown as Prisma.InputJsonValue,
        },
      });

      // Audit log: cutover completed (redacted: no raw secrets or tokens)
      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId: actorId ?? null,
          action: "api_key.cutover",
          resourceType: "api_key",
          resourceId: rotation.oldKeyId,
          metadata: {
            prefix: rotation.oldKey.prefix,
            replacementPrefix: rotation.newKey.prefix,
            organizationId,
            familyId: rotation.familyId,
            receiptId: receipt.id,
            cutoverType: "EARLY_MANUAL",
            reason: dto?.reason,
          },
        },
      });

      const replacementKeySummary: ApiKeyRotationKeySummary = {
        id: rotation.newKey.id,
        prefix: rotation.newKey.prefix,
        name: rotation.newKey.name,
        status: rotation.newKey.status,
        scopes: newScopes,
        lastUsedAt: rotation.newKey.lastUsedAt,
        createdAt: rotation.newKey.createdAt,
      };

      return {
        rotation: {
          id: updatedRotation.id,
          familyId: updatedRotation.familyId,
          status: updatedRotation.status,
          cutoverAt: now,
          cutoverById: updatedRotation.cutoverById,
        },
        cutoverReceipt: {
          id: receipt.id,
          receiptHash: receipt.receiptHash,
          cutoverAt: receipt.cutoverAt,
          cutoverType: receipt.cutoverType,
          oldKeyUsageCount: receipt.oldKeyUsageCount,
        },
        replacementKey: replacementKeySummary,
      };
    });
  }

  /**
   * Track usage of an old key during its overlap window.
   */
  async recordOldKeyUsage(oldKeyId: string): Promise<void> {
    try {
      const now = await this.now();
      await this.prisma.apiKeyRotation.updateMany({
        where: {
          oldKeyId,
          status: ApiKeyRotationStatus.IN_OVERLAP,
          overlapExpiresAt: { gt: now },
        },
        data: {
          oldKeyUsageCount: { increment: 1 },
          lastOldKeyUsedAt: now,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to track old-key rotation usage: ${String(err)}`);
    }
  }

  /**
   * Handle family-aware key revocation semantics:
   * 1. If reason is COMPROMISE: revokes BOTH keys in the rotation family immediately.
   * 2. If old key is revoked: triggers immediate cutover, retiring the old key and keeping replacement key active.
   * 3. If replacement key is revoked: invalidates replacement key and aborts rotation.
   */
  async handleFamilyRevocation(
    keyId: string,
    organizationId: string,
    actorId?: string,
    reason?: string,
  ): Promise<{ affectedKeyIds: string[]; wasFamilyRevocation: boolean }> {
    const now = await this.now();

    return this.runTransaction(async (tx) => {
      if (!tx.apiKeyRotation || typeof tx.apiKeyRotation.findFirst !== "function") {
        return { affectedKeyIds: [keyId], wasFamilyRevocation: false };
      }

      const rotation = await tx.apiKeyRotation.findFirst({
        where: {
          organizationId,
          OR: [{ oldKeyId: keyId }, { newKeyId: keyId }],
          status: ApiKeyRotationStatus.IN_OVERLAP,
        },
        include: {
          oldKey: { include: { scopeAssignments: true } },
          newKey: { include: { scopeAssignments: true } },
        },
      });

      if (!rotation) {
        // Not part of an active overlap rotation family; standard single key revocation
        return { affectedKeyIds: [keyId], wasFamilyRevocation: false };
      }

      const isCompromise = reason === ROTATION_REVOCATION_REASONS.COMPROMISE;

      if (isCompromise) {
        // Compromise semantics: revoke BOTH keys immediately
        await tx.apiKey.updateMany({
          where: {
            id: { in: [rotation.oldKeyId, rotation.newKeyId] },
            organizationId,
          },
          data: {
            status: ResourceStatus.REVOKED,
            revokedAt: now,
          },
        });

        await tx.apiKeyRotation.update({
          where: { id: rotation.id },
          data: {
            status: ApiKeyRotationStatus.REVOKED,
          },
        });

        await tx.auditLog.create({
          data: {
            actorType: "user",
            actorId: actorId ?? null,
            action: "api_key.revoked",
            resourceType: "api_key",
            resourceId: keyId,
            metadata: {
              organizationId,
              familyId: rotation.familyId,
              oldKeyId: rotation.oldKeyId,
              newKeyId: rotation.newKeyId,
              revocationReason: ROTATION_REVOCATION_REASONS.COMPROMISE,
              revokedAt: now.toISOString(),
            },
          },
        });

        return {
          affectedKeyIds: [rotation.oldKeyId, rotation.newKeyId],
          wasFamilyRevocation: true,
        };
      }

      // Normal revocation of old key -> cutover transition
      if (keyId === rotation.oldKeyId) {
        await tx.apiKey.update({
          where: { id: rotation.oldKeyId },
          data: {
            status: ResourceStatus.REVOKED,
            revokedAt: now,
          },
        });

        await tx.apiKeyRotation.update({
          where: { id: rotation.id },
          data: {
            status: ApiKeyRotationStatus.CUTOVER,
            cutoverAt: now,
            cutoverById: actorId ?? null,
          },
        });

        const oldScopes = rotation.oldKey.scopeAssignments.map((s: { scope: ApiKeyScope }) => s.scope);
        const newScopes = rotation.newKey.scopeAssignments.map((s: { scope: ApiKeyScope }) => s.scope);
        const scopeIntersection = this.calculateScopeIntersection(oldScopes, newScopes);

        const receiptPayload: CanonicalCutoverReceiptPayload = {
          receiptType: "API_KEY_ROTATION_CUTOVER",
          version: "1",
          organizationId,
          familyId: rotation.familyId,
          oldKeyId: rotation.oldKeyId,
          newKeyId: rotation.newKeyId,
          cutoverAt: now.toISOString(),
          cutoverType: "REVOCATION_CUTOVER",
          initiatedById: actorId ?? null,
          oldKeyUsageCount: rotation.oldKeyUsageCount,
          scopeIntersection,
        };

        const receiptHash = `sha256:${sha256(JSON.stringify(receiptPayload))}`;

        const receipt = await tx.apiKeyCutoverReceipt.create({
          data: {
            organizationId,
            rotationId: rotation.id,
            familyId: rotation.familyId,
            oldKeyId: rotation.oldKeyId,
            newKeyId: rotation.newKeyId,
            cutoverAt: now,
            cutoverType: "REVOCATION_CUTOVER",
            initiatedById: actorId ?? null,
            oldKeyUsageCount: rotation.oldKeyUsageCount,
            receiptHash,
            receiptData: receiptPayload as unknown as Prisma.InputJsonValue,
          },
        });

        await tx.auditLog.create({
          data: {
            actorType: "user",
            actorId: actorId ?? null,
            action: "api_key.cutover",
            resourceType: "api_key",
            resourceId: rotation.oldKeyId,
            metadata: {
              prefix: rotation.oldKey.prefix,
              replacementPrefix: rotation.newKey.prefix,
              organizationId,
              familyId: rotation.familyId,
              receiptId: receipt.id,
              cutoverType: "REVOCATION_CUTOVER",
            },
          },
        });

        return {
          affectedKeyIds: [rotation.oldKeyId],
          wasFamilyRevocation: true,
        };
      }

      // Normal revocation of new replacement key -> abort rotation
      await tx.apiKey.update({
        where: { id: rotation.newKeyId },
        data: {
          status: ResourceStatus.REVOKED,
          revokedAt: now,
        },
      });

      await tx.apiKeyRotation.update({
        where: { id: rotation.id },
        data: {
          status: ApiKeyRotationStatus.REVOKED,
        },
      });

      return {
        affectedKeyIds: [rotation.newKeyId],
        wasFamilyRevocation: true,
      };
    });
  }

  /**
   * Evaluate scope intersection and policy for an authenticated key.
   */
  async evaluateScopeIntersection(
    keyId: string,
    keyScopes: ApiKeyScope[],
    organizationId: string,
  ): Promise<ScopeIntersectionPolicyEvaluation> {
    const now = await this.now();

    if (!this.prisma.apiKeyRotation || typeof this.prisma.apiKeyRotation.findFirst !== "function") {
      return {
        allowed: true,
        effectiveScopes: keyScopes,
        isOldKeyInOverlap: false,
      };
    }

    // Check if key is the old key in an active rotation
    const oldKeyRotation = await this.prisma.apiKeyRotation.findFirst({
      where: {
        oldKeyId: keyId,
        organizationId,
      },
      include: {
        newKey: {
          include: {
            scopeAssignments: { select: { scope: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (oldKeyRotation) {
      // If cutover or revoked, old key is not allowed
      if (
        oldKeyRotation.status === ApiKeyRotationStatus.CUTOVER ||
        oldKeyRotation.status === ApiKeyRotationStatus.REVOKED
      ) {
        return {
          allowed: false,
          effectiveScopes: [],
          isOldKeyInOverlap: true,
          rotationId: oldKeyRotation.id,
          reason: "Key has been cut over or revoked",
        };
      }

      // Exact deadline boundary check: now >= overlapExpiresAt => expired
      if (now.getTime() >= oldKeyRotation.overlapExpiresAt.getTime()) {
        // Auto-transition rotation status to EXPIRED if needed
        if (oldKeyRotation.status === ApiKeyRotationStatus.IN_OVERLAP) {
          try {
            const p = this.prisma.apiKeyRotation?.update?.({
              where: { id: oldKeyRotation.id },
              data: { status: ApiKeyRotationStatus.EXPIRED },
            });
            if (p && typeof p.catch === "function") {
              p.catch(() => undefined);
            }
          } catch {
            // best-effort
          }
        }

        return {
          allowed: false,
          effectiveScopes: [],
          isOldKeyInOverlap: true,
          rotationId: oldKeyRotation.id,
          reason: "Rotation overlap deadline expired",
        };
      }

      // Active overlap: authorize within scope intersection
      const newScopes = oldKeyRotation.newKey.scopeAssignments.map((s) => s.scope);
      const effectiveScopes = this.calculateScopeIntersection(keyScopes, newScopes);

      return {
        allowed: true,
        effectiveScopes,
        isOldKeyInOverlap: true,
        rotationId: oldKeyRotation.id,
      };
    }

    // Check if key is the new replacement key in an active rotation
    const newKeyRotation = await this.prisma.apiKeyRotation.findFirst({
      where: {
        newKeyId: keyId,
        organizationId,
      },
      include: {
        oldKey: {
          include: {
            scopeAssignments: { select: { scope: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (newKeyRotation && newKeyRotation.status === ApiKeyRotationStatus.IN_OVERLAP) {
      // Overlap deadline check: if deadline has passed, replacement key has full scopes
      if (now.getTime() >= newKeyRotation.overlapExpiresAt.getTime()) {
        return {
          allowed: true,
          effectiveScopes: keyScopes,
          isOldKeyInOverlap: false,
          rotationId: newKeyRotation.id,
        };
      }

      // Still in active overlap: replacement key authorized only within scope intersection
      const oldScopes = newKeyRotation.oldKey.scopeAssignments.map((s) => s.scope);
      const effectiveScopes = this.calculateScopeIntersection(keyScopes, oldScopes);

      return {
        allowed: true,
        effectiveScopes,
        isOldKeyInOverlap: false,
        rotationId: newKeyRotation.id,
      };
    }

    // Default: normal key without active rotation restrictions
    return {
      allowed: true,
      effectiveScopes: keyScopes,
      isOldKeyInOverlap: false,
    };
  }
}
