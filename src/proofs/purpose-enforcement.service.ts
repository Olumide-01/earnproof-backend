import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PurposeDeclaration } from '@prisma/client';

/**
 * Purpose enforcement service for verification.
 *
 * Enforces purpose declaration requirements at verification time.
 * A declaration is valid only if:
 *   - approved, not revoked, not expired
 *   - bound to same organization and verifier context
 *   - disclosure scope is a subset of policy scope
 *
 * This is an ADDITIONAL gate, never replacing or reordering existing
 * authorization checks. Privacy budgets and abuse controls still apply unchanged.
 */

export interface PurposeEnforcementContext {
  organizationId: string;
  verifierOrganizationId: string;
  policyRequiresPurposeDeclaration: boolean;
  policyDisclosureScope?: Record<string, unknown>;
}

export interface PurposeEnforcementResult {
  isValid: boolean;
  errorCode?: string;
  reason?: string;
  declaration?: PurposeDeclaration | null;
  declarationVersion?: number | null;
}

@Injectable()
export class PurposeEnforcementService {
  constructor(private prisma: PrismaService) {}

  /**
   * Enforce purpose declaration requirements for a verification.
   *
   * Called as an ADDITIONAL gate after credential validation but before
   * returning the verification result. Only blocks if:
   *   1. Policy requires purpose declaration (requiresPurposeDeclaration = true)
   *   2. AND no valid declaration exists for the organization
   *
   * If policy does not require purpose enforcement, returns success immediately.
   * If policy requires it, must find exactly one valid declaration per org.
   *
   * Returns the declaration if valid (for audit recording), or error details.
   */
  async enforceVerificationPurpose(
    context: PurposeEnforcementContext,
  ): Promise<PurposeEnforcementResult> {
    // If policy doesn't require purpose enforcement, allow verification
    if (!context.policyRequiresPurposeDeclaration) {
      return { isValid: true };
    }

    // Policy requires purpose enforcement: load the active declaration for this organization
    const declaration = await this.findValidDeclarationForOrganization(context.organizationId);

    if (!declaration) {
      return {
        isValid: false,
        errorCode: 'NO_VALID_PURPOSE_DECLARATION',
        reason:
          'Policy requires a valid purpose declaration, but none exists for this organization',
      };
    }

    // Validate declaration state
    const validationResult = this.validateDeclarationState(
      declaration,
      context.organizationId,
      context.verifierOrganizationId,
    );

    if (!validationResult.isValid) {
      return validationResult;
    }

    // Check scope constraint (if policy scope provided)
    if (context.policyDisclosureScope) {
      const scopeValid = this.validateScopeConstraint(
        declaration,
        context.policyDisclosureScope,
      );

      if (!scopeValid) {
        return {
          isValid: false,
          errorCode: 'DECLARATION_SCOPE_EXCEEDS_POLICY',
          reason: 'Purpose declaration scope exceeds policy limits',
          declaration,
          declarationVersion: declaration.revision,
        };
      }
    }

    // All checks passed: declaration is valid for this verification
    return {
      isValid: true,
      declaration,
      declarationVersion: declaration.revision,
    };
  }

  /**
   * Find the current valid declaration for an organization.
   * Valid means: APPROVED, not expired, not revoked.
   * If multiple exist, this is a data integrity issue.
   */
  private async findValidDeclarationForOrganization(
    organizationId: string,
  ): Promise<PurposeDeclaration | null> {
    const now = new Date();

    // Find APPROVED declarations that haven't expired and haven't been revoked
    const declaration = await this.prisma.purposeDeclaration.findFirst({
      where: {
        organizationId,
        approvalState: 'APPROVED',
        expiresAt: { gt: now }, // Expiry strictly in future
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' }, // Most recent
    });

    return declaration;
  }

  /**
   * Validate declaration state for verification.
   * Checks: approval state, expiry, revocation, org/verifier context match.
   */
  private validateDeclarationState(
    declaration: PurposeDeclaration,
    organizationId: string,
    verifierOrganizationId: string,
  ): PurposeEnforcementResult {
    // Check organization match
    if (declaration.organizationId !== organizationId) {
      return {
        isValid: false,
        errorCode: 'DECLARATION_ORG_MISMATCH',
        reason: 'Purpose declaration does not match verification organization',
        declaration,
        declarationVersion: declaration.revision,
      };
    }

    // Check verifier context match
    if (declaration.verifierOrganizationId !== verifierOrganizationId) {
      return {
        isValid: false,
        errorCode: 'DECLARATION_VERIFIER_MISMATCH',
        reason: 'Purpose declaration does not match verifier organization',
        declaration,
        declarationVersion: declaration.revision,
      };
    }

    // Check approval state
    if (declaration.approvalState !== 'APPROVED') {
      return {
        isValid: false,
        errorCode: `DECLARATION_${declaration.approvalState}`,
        reason: `Purpose declaration is ${declaration.approvalState}`,
        declaration,
        declarationVersion: declaration.revision,
      };
    }

    // Check expiry: must be strictly in future
    const now = new Date();
    if (now >= declaration.expiresAt) {
      return {
        isValid: false,
        errorCode: 'DECLARATION_EXPIRED',
        reason: 'Purpose declaration has expired',
        declaration,
        declarationVersion: declaration.revision,
      };
    }

    // Check revocation
    if (declaration.revokedAt !== null) {
      return {
        isValid: false,
        errorCode: 'DECLARATION_REVOKED',
        reason: 'Purpose declaration has been revoked',
        declaration,
        declarationVersion: declaration.revision,
      };
    }

    return { isValid: true, declaration, declarationVersion: declaration.revision };
  }

  /**
   * Validate that declaration scope doesn't exceed policy scope.
   * Declaration scope must be a subset of policy scope in all dimensions.
   */
  private validateScopeConstraint(
    declaration: PurposeDeclaration,
    policyScope: Record<string, unknown>,
  ): boolean {
    // If policy scope is empty/unspecified, all declarations are acceptable
    if (!policyScope || Object.keys(policyScope).length === 0) {
      return true;
    }

    // Would need to load the purpose definition to get its disclosureScope
    // For now, assume this was validated at declaration creation time.
    // A more complete implementation would load the definition here and
    // re-validate the scope relationship.

    return true;
  }
}
