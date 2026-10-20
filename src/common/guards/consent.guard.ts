import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PolicyType } from "@prisma/client";
import { Request } from "express";
import { AuthenticatedUser } from "../../auth/auth.types";
import { ConsentService } from "../consent/consent.service";
import { PrismaService } from "../../database/prisma.service";

/**
 * Metadata key for required consent policies.
 * Set by @RequireConsent() decorator.
 */
const REQUIRE_CONSENT_KEY = "requireConsent";

/**
 * Decorator to specify required consent for an endpoint.
 * 
 * @param policyTypes Required policy types that user must have consented to
 */
export const RequireConsent = (...policyTypes: PolicyType[]) =>
  SetMetadata(REQUIRE_CONSENT_KEY, policyTypes);

/**
 * Consent Guard
 * 
 * Enforces that authenticated users have provided required consents
 * before accessing protected endpoints.
 * 
 * Flow:
 * 1. Check if request has authenticated user
 * 2. Get required consents from route metadata
 * 3. Verify user has accepted current versions of all required policies
 * 4. Reject with clear error message if consents are missing/outdated
 * 
 * This guard should run AFTER AuthGuard in the guard chain.
 */
@Injectable()
export class ConsentGuard implements CanActivate {
  constructor(
    private readonly consentService: ConsentService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Get required consents from route metadata
    const requiredPolicyTypes = this.reflector.getAllAndOverride<PolicyType[]>(
      REQUIRE_CONSENT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPolicyTypes || requiredPolicyTypes.length === 0) {
      // No consent requirements - allow
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    
    // Get authenticated user from request context
    const user = (request as any).user as AuthenticatedUser;
    
    if (!user) {
      // No authenticated user - this should be handled by AuthGuard first
      throw new ForbiddenException("Authentication required for consent verification");
    }

    try {
      // Get user's organization context
      const orgMember = await this.getUserPrimaryOrganization(user.id);
      if (!orgMember) {
        throw new ForbiddenException("User must belong to an organization");
      }

      // Check if user has all required consents
      const consentCheck = await this.consentService.checkRequiredConsents(
        user.id,
        orgMember.organizationId,
        requiredPolicyTypes,
      );

      if (!consentCheck.allConsentsValid) {
        // Build detailed error message
        const missingDetails = consentCheck.missingConsents
          .map(missing => {
            const reasonText = {
              never_consented: "never accepted",
              outdated_version: "outdated version",
              withdrawn: "consent withdrawn",
            }[missing.reason];
            
            return `${missing.policyType} v${missing.currentVersion} (${reasonText})`;
          })
          .join(", ");

        throw new ForbiddenException(
          `Missing required consents: ${missingDetails}. ` +
          `Please review and accept the current policy versions before proceeding.`,
        );
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      
      // Log unexpected errors but don't expose details to client
      console.error("Consent verification failed:", error);
      throw new ForbiddenException("Unable to verify consent status");
    }
  }

  /**
   * Helper: Get user's primary organization membership.
   */
  private async getUserPrimaryOrganization(userId: string) {
    return this.prisma.organizationMember.findFirst({
      where: {
        userId,
        status: "ACTIVE",
      },
      select: {
        organizationId: true,
        role: true,
      },
      orderBy: {
        createdAt: "asc", // Get first/primary membership
      },
    });
  }
}