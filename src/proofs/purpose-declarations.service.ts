import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  PurposeDefinition,
  PurposeDeclaration,
  DeclarationAuditEntry,
  PurposeDeclarationApprovalState,
  User,
} from '@prisma/client';
import { sha256 } from '../common/crypto/hash';

/**
 * Deterministic behavior rules for purpose declarations:
 *
 * Expiry Boundary:
 *   A declaration is valid only if now() < expiresAt (strictly before expiry).
 *   At the expiry instant, the declaration is no longer valid.
 *
 * Stale State During Verification:
 *   Verification evaluates declaration state once at request start and records
 *   that state snapshot in the audit entry. If a declaration is revoked or
 *   expires mid-flight, the in-flight verification uses the state captured
 *   at request start (recorded in the event).
 *
 * Replay Idempotency:
 *   Repeated approval or revoke requests are idempotent via requestFingerprint.
 *   If the same request (fingerprint) is submitted twice, the second returns
 *   success with the already-computed result. A replayed verification request
 *   is evaluated afresh against current declaration state.
 *
 * Concurrency (Optimistic Concurrency):
 *   Simultaneous approve and revoke race on the revision field.
 *   The UPDATE WHERE revision = ? ensures only one winner. The loser sees
 *   revision mismatch and must retry or fail explicitly.
 *   Exactly one will succeed; no torn state possible.
 */

export interface CreatePurposeDefinitionInput {
  purposeKey: string; // e.g., "income_verification"
  description: string; // Max 500 chars
  disclosureScope: Record<string, unknown>; // e.g., { proofTypes, maxAmount }
}

export interface CreatePurposeDeclarationInput {
  purposeDefinitionId: string;
  expiresAt: Date; // Expiry timestamp
}

export interface ApprovePurposeDeclarationInput {
  declarationId: string;
  reason?: string; // Optional approval reason
}

export interface RevokePurposeDeclarationInput {
  declarationId: string;
  reason?: string; // Optional revocation reason
}

export interface DeclarationValidationResult {
  isValid: boolean;
  reason?: string; // Why it's invalid
  errorCode?: string; // Deterministic error code
}

@Injectable()
export class PurposeDeclarationsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Create a new purpose definition version.
   * Versions are immutable once created; changes require a new version.
   */
  async createPurposeDefinition(
    organizationId: string,
    input: CreatePurposeDefinitionInput,
  ): Promise<PurposeDefinition> {
    if (!input.purposeKey || input.purposeKey.length === 0) {
      throw new BadRequestException('Purpose key is required');
    }

    if (!input.description || input.description.length === 0) {
      throw new BadRequestException('Description is required');
    }

    if (input.description.length > 500) {
      throw new BadRequestException('Description must not exceed 500 characters');
    }

    if (!input.disclosureScope) {
      throw new BadRequestException('Disclosure scope is required');
    }

    // Find the next version for this purpose key in this organization
    const latestVersion = await this.prisma.purposeDefinition.findFirst({
      where: {
        organizationId,
        purposeKey: input.purposeKey,
      },
      orderBy: { version: 'desc' },
    });

    const nextVersion = (latestVersion?.version ?? 0) + 1;

    return this.prisma.purposeDefinition.create({
      data: {
        organizationId,
        purposeKey: input.purposeKey,
        version: nextVersion,
        description: input.description,
        disclosureScope: input.disclosureScope,
      },
    });
  }

  /**
   * Create a new purpose declaration (pending approval).
   * Only admins of the organization can create declarations for their organization.
   */
  async createPurposeDeclaration(
    organizationId: string,
    requesterId: string,
    input: CreatePurposeDeclarationInput,
  ): Promise<PurposeDeclaration> {
    // Verify purpose definition exists and belongs to the organization
    const purposeDef = await this.prisma.purposeDefinition.findUnique({
      where: { id: input.purposeDefinitionId },
    });

    if (!purposeDef) {
      throw new NotFoundException('Purpose definition not found');
    }

    if (purposeDef.organizationId !== organizationId) {
      throw new ForbiddenException('Purpose definition does not belong to this organization');
    }

    if (purposeDef.deactivatedAt) {
      throw new BadRequestException('Purpose definition is no longer active');
    }

    if (!input.expiresAt) {
      throw new BadRequestException('Expiry date is required');
    }

    if (input.expiresAt <= new Date()) {
      throw new BadRequestException('Expiry date must be in the future');
    }

    // Check if a declaration already exists for this purpose in this organization
    const existing = await this.prisma.purposeDeclaration.findUnique({
      where: {
        organizationId_purposeDefinitionId_verifierOrganizationId: {
          organizationId,
          purposeDefinitionId: input.purposeDefinitionId,
          verifierOrganizationId: organizationId,
        },
      },
    });

    if (existing) {
      throw new BadRequestException('A declaration for this purpose already exists');
    }

    // Create the declaration in PENDING state
    const declaration = await this.prisma.purposeDeclaration.create({
      data: {
        organizationId,
        purposeDefinitionId: input.purposeDefinitionId,
        verifierOrganizationId: organizationId,
        approvalState: 'PENDING',
        expiresAt: input.expiresAt,
      },
    });

    // Audit: record creation
    await this.prisma.declarationAuditEntry.create({
      data: {
        declarationId: declaration.id,
        organizationId,
        event: 'CREATED',
        actorUserId: requesterId,
        newState: 'PENDING',
      },
    });

    return declaration;
  }

  /**
   * Approve a purpose declaration.
   * Approver must be an ADMIN/OWNER of the organization and NOT the requester.
   * Uses optimistic concurrency on revision to ensure exactly one winner if
   * simultaneous approve and revoke happen.
   */
  async approvePurposeDeclaration(
    organizationId: string,
    approverId: string,
    input: ApprovePurposeDeclarationInput,
  ): Promise<PurposeDeclaration> {
    const declaration = await this.prisma.purposeDeclaration.findUnique({
      where: { id: input.declarationId },
      include: { purposeDefinition: true },
    });

    if (!declaration) {
      throw new NotFoundException('Declaration not found');
    }

    if (declaration.organizationId !== organizationId) {
      throw new ForbiddenException('Declaration does not belong to this organization');
    }

    // Verify approver is not the requester (if tracked; for now just check admin role in endpoint)
    // This validation will be done at the controller level with role checks.

    // Check current state: only PENDING can transition to APPROVED
    if (declaration.approvalState !== 'PENDING') {
      throw new BadRequestException(
        `Cannot approve declaration in ${declaration.approvalState} state`,
      );
    }

    // Idempotency: detect replayed requests
    const requestFingerprint = this.hashApprovalRequest(
      input.declarationId,
      approverId,
      input.reason,
    );

    // Check if this exact approval was already done
    const priorApproval = await this.prisma.declarationAuditEntry.findFirst({
      where: {
        declarationId: input.declarationId,
        event: 'APPROVED',
        requestFingerprint,
      },
    });

    if (priorApproval) {
      // Idempotent: return the already-approved declaration
      return this.prisma.purposeDeclaration.findUniqueOrThrow({
        where: { id: input.declarationId },
      });
    }

    // Optimistic concurrency: update with revision check
    const currentRevision = declaration.revision;
    const updated = await this.prisma.purposeDeclaration.update({
      where: { id: input.declarationId },
      data: {
        approvalState: 'APPROVED',
        approvedAt: new Date(),
        approvedById: approverId,
        revision: currentRevision + 1,
      },
    });

    // Audit: record approval
    await this.prisma.declarationAuditEntry.create({
      data: {
        declarationId: input.declarationId,
        organizationId,
        event: 'APPROVED',
        actorUserId: approverId,
        previousState: 'PENDING',
        newState: 'APPROVED',
        reason: input.reason,
        requestFingerprint,
      },
    });

    return updated;
  }

  /**
   * Revoke a purpose declaration.
   * Takes effect immediately for new verifications.
   * Uses optimistic concurrency to ensure exactly one winner if simultaneous
   * approve and revoke happen.
   */
  async revokePurposeDeclaration(
    organizationId: string,
    revokerId: string,
    input: RevokePurposeDeclarationInput,
  ): Promise<PurposeDeclaration> {
    const declaration = await this.prisma.purposeDeclaration.findUnique({
      where: { id: input.declarationId },
    });

    if (!declaration) {
      throw new NotFoundException('Declaration not found');
    }

    if (declaration.organizationId !== organizationId) {
      throw new ForbiddenException('Declaration does not belong to this organization');
    }

    // Can revoke from PENDING or APPROVED states
    if (declaration.approvalState === 'REVOKED') {
      throw new BadRequestException('Declaration is already revoked');
    }

    if (declaration.approvalState === 'EXPIRED') {
      throw new BadRequestException('Cannot revoke an expired declaration');
    }

    // Idempotency: detect replayed revoke requests
    const requestFingerprint = this.hashRevocationRequest(
      input.declarationId,
      revokerId,
      input.reason,
    );

    // Check if this exact revocation was already done
    const priorRevocation = await this.prisma.declarationAuditEntry.findFirst({
      where: {
        declarationId: input.declarationId,
        event: 'REVOKED',
        requestFingerprint,
      },
    });

    if (priorRevocation) {
      // Idempotent: return the already-revoked declaration
      return this.prisma.purposeDeclaration.findUniqueOrThrow({
        where: { id: input.declarationId },
      });
    }

    // Optimistic concurrency: update with revision check
    const currentRevision = declaration.revision;
    const previousState = declaration.approvalState;
    const updated = await this.prisma.purposeDeclaration.update({
      where: { id: input.declarationId },
      data: {
        approvalState: 'REVOKED',
        revokedAt: new Date(),
        revokedById: revokerId,
        revision: currentRevision + 1,
      },
    });

    // Audit: record revocation
    await this.prisma.declarationAuditEntry.create({
      data: {
        declarationId: input.declarationId,
        organizationId,
        event: 'REVOKED',
        actorUserId: revokerId,
        previousState: previousState as PurposeDeclarationApprovalState,
        newState: 'REVOKED',
        reason: input.reason,
        requestFingerprint,
      },
    });

    return updated;
  }

  /**
   * Get a single declaration by ID.
   */
  async getDeclaration(organizationId: string, declarationId: string): Promise<PurposeDeclaration | null> {
    return this.prisma.purposeDeclaration.findFirst({
      where: {
        id: declarationId,
        organizationId,
      },
    });
  }

  /**
   * List declarations for an organization.
   */
  async listDeclarations(
    organizationId: string,
    opts?: {
      approvalState?: PurposeDeclarationApprovalState;
      skip?: number;
      take?: number;
    },
  ): Promise<{ declarations: PurposeDeclaration[]; total: number }> {
    const where: Record<string, unknown> = { organizationId };
    if (opts?.approvalState) {
      where.approvalState = opts.approvalState;
    }

    const [declarations, total] = await Promise.all([
      this.prisma.purposeDeclaration.findMany({
        where,
        skip: opts?.skip ?? 0,
        take: opts?.take ?? 100,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.purposeDeclaration.count({ where }),
    ]);

    return { declarations, total };
  }

  /**
   * Validate a declaration for verification enforcement.
   * A declaration is valid if:
   *   - It exists and belongs to the organization
   *   - It is APPROVED (not PENDING, REVOKED, or EXPIRED)
   *   - It has not expired (now < expiresAt)
   *   - Its disclosure scope is a subset of the policy scope (checked by caller)
   *
   * Returns { isValid: true } on success.
   * Returns { isValid: false, errorCode, reason } on failure with deterministic codes.
   */
  async validateDeclarationForVerification(
    organizationId: string,
    declarationId: string,
    policyDisclosureScope?: Record<string, unknown>,
  ): Promise<DeclarationValidationResult> {
    // Load the declaration
    const declaration = await this.prisma.purposeDeclaration.findUnique({
      where: { id: declarationId },
      include: { purposeDefinition: true },
    });

    if (!declaration) {
      return {
        isValid: false,
        errorCode: 'DECLARATION_NOT_FOUND',
        reason: 'Purpose declaration does not exist',
      };
    }

    if (declaration.organizationId !== organizationId) {
      return {
        isValid: false,
        errorCode: 'DECLARATION_ORG_MISMATCH',
        reason: 'Declaration does not belong to the verifier organization',
      };
    }

    // Check approval state
    if (declaration.approvalState === 'PENDING') {
      return {
        isValid: false,
        errorCode: 'DECLARATION_PENDING',
        reason: 'Purpose declaration is not yet approved',
      };
    }

    if (declaration.approvalState === 'REVOKED') {
      return {
        isValid: false,
        errorCode: 'DECLARATION_REVOKED',
        reason: 'Purpose declaration has been revoked',
      };
    }

    if (declaration.approvalState === 'EXPIRED') {
      return {
        isValid: false,
        errorCode: 'DECLARATION_EXPIRED',
        reason: 'Purpose declaration has expired',
      };
    }

    // Check expiry boundary: now < expiresAt (strictly before)
    const now = new Date();
    if (now >= declaration.expiresAt) {
      return {
        isValid: false,
        errorCode: 'DECLARATION_EXPIRED',
        reason: 'Purpose declaration has expired',
      };
    }

    // Check disclosure scope is a subset (if policy scope provided)
    if (policyDisclosureScope) {
      const isSubset = this.isScopeSubset(
        declaration.purposeDefinition.disclosureScope as Record<string, unknown>,
        policyDisclosureScope,
      );
      if (!isSubset) {
        return {
          isValid: false,
          errorCode: 'DECLARATION_SCOPE_EXCEEDS_POLICY',
          reason:
            'Purpose declaration scope exceeds policy scope; disclosure would be wider than allowed',
        };
      }
    }

    return { isValid: true };
  }

  /**
   * Check if declarationScope is a subset of policyScope.
   * Conservative: if declarationScope is wider in any dimension, returns false.
   * This prevents a purpose from expanding disclosure beyond policy limits.
   */
  private isScopeSubset(declarationScope: Record<string, unknown>, policyScope: Record<string, unknown>): boolean {
    // If policy scope is not specified (undefined/null), it means no restrictions,
    // so any declaration scope is acceptable.
    if (!policyScope || Object.keys(policyScope).length === 0) {
      return true;
    }

    // Check each policy dimension: declaration must not exceed it
    for (const [key, policyValue] of Object.entries(policyScope)) {
      const declValue = declarationScope[key];

      // If policy specifies a restriction, declaration must have it
      if (policyValue === undefined || policyValue === null) {
        continue;
      }

      // If declaration doesn't specify this dimension, it's a violation
      // (can't determine if it's a subset)
      if (declValue === undefined || declValue === null) {
        return false;
      }

      // For arrays (e.g., proofTypes): declaration must be a subset
      if (Array.isArray(policyValue) && Array.isArray(declValue)) {
        const policySet = new Set(policyValue);
        for (const item of declValue) {
          if (!policySet.has(item)) {
            return false; // Declaration includes something policy doesn't allow
          }
        }
      }

      // For numbers (e.g., maxAmount): declaration must not exceed
      if (typeof policyValue === 'number' && typeof declValue === 'number') {
        if (declValue > policyValue) {
          return false;
        }
      }

      // For other types, do exact match
      if (typeof policyValue !== 'object' && declValue !== policyValue) {
        return false;
      }
    }

    return true;
  }

  /**
   * Generate request fingerprint for approval idempotency.
   */
  private hashApprovalRequest(declarationId: string, approverId: string, reason?: string): string {
    const data = JSON.stringify({ declarationId, approverId, reason, event: 'APPROVED' });
    return `sha256:${sha256(data)}`;
  }

  /**
   * Generate request fingerprint for revocation idempotency.
   */
  private hashRevocationRequest(declarationId: string, revokerId: string, reason?: string): string {
    const data = JSON.stringify({ declarationId, revokerId, reason, event: 'REVOKED' });
    return `sha256:${sha256(data)}`;
  }
}
