import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { PolicyType, PolicyStatus } from "@prisma/client";
import { AuthGuard } from "../guards/auth.guard";
import { CurrentUser } from "../decorators/current-user.decorator";
import { AuthenticatedRoute } from "../decorators/authorization-policy.decorator";
import { AuthenticatedUser } from "../../auth/auth.types";
import { ApiErrorDto } from "../dto/api-error.dto";
import { SESSION_AUTH_SCHEME } from "../swagger/security-schemes";
import { PrismaService } from "../../database/prisma.service";
import { ConsentService } from "./consent.service";
import {
  CreatePolicyVersionDto,
  PublishPolicyVersionDto,
  ConsentRequestDto,
  PolicyVersionResponseDto,
  ConsentStatusDto,
  ConsentRecordDto,
  ConsentResponseDto,
  RequiredConsentsCheckDto,
} from "./dto/consent.dto";

/**
 * Consent Management Controller
 * 
 * Handles policy version management and user consent tracking.
 * Provides both administrative policy management and user consent endpoints.
 * 
 * Access control:
 * - Policy management requires ADMIN role
 * - Consent actions require authentication
 * - All operations are tenant-isolated
 */
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@ApiTags("consent")
@Controller("consent")
export class ConsentController {
  constructor(
    private readonly consentService: ConsentService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Get current published policy versions.
   * Public endpoint for retrieving current policy requirements.
   */
  @ApiOperation({
    summary: "Get current published policy versions",
    description: "Returns the currently published versions of privacy policy and terms of service.",
  })
  @ApiQuery({
    name: "policyType",
    enum: PolicyType,
    required: false,
    description: "Filter by policy type",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Current policy versions",
    type: [PolicyVersionResponseDto],
  })
  @Get("policies/current")
  async getCurrentPolicies(
    @Query("policyType") policyType?: PolicyType,
  ): Promise<PolicyVersionResponseDto[]> {
    const policyTypes = policyType 
      ? [policyType] 
      : [PolicyType.PRIVACY_POLICY, PolicyType.TERMS_OF_SERVICE];

    const policies = [];
    for (const type of policyTypes) {
      const current = await this.consentService.getCurrentPolicyVersion(type);
      if (current) {
        policies.push({
          id: current.id,
          policyType: type,
          version: current.version,
          contentHash: current.contentHash,
          status: PolicyStatus.PUBLISHED,
          publishedAt: current.publishedAt,
          createdAt: current.publishedAt, // Simplified for this response
        });
      }
    }

    return policies;
  }

  /**
   * Create or update a policy version (admin only).
   */
  @ApiOperation({
    summary: "Create or update a policy version",
    description: "Create a new policy version or update a draft version. Only admins can manage policies.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Policy version created/updated",
    type: PolicyVersionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Invalid policy data or attempting to modify published version",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Authentication required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Admin access required",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Post("policies")
  @AuthenticatedRoute({ roles: ["ADMIN"] })
  async createPolicyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreatePolicyVersionDto,
  ): Promise<PolicyVersionResponseDto> {
    if (body.content.trim().length < 50) {
      throw new BadRequestException("Policy content must be at least 50 characters");
    }

    const result = await this.consentService.createPolicyVersion(
      body.policyType,
      body.version,
      body.content,
      body.status || PolicyStatus.DRAFT,
    );

    return {
      id: result.id,
      policyType: result.policyType,
      version: result.version,
      contentHash: result.contentHash,
      status: result.status,
      publishedAt: result.publishedAt,
      createdAt: new Date(), // Would be from database in real implementation
    };
  }

  /**
   * Publish a policy version (admin only).
   */
  @ApiOperation({
    summary: "Publish a policy version",
    description: "Publish a draft policy version, making it the current version and immutable.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Policy version published successfully",
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Policy version not found or not in draft status",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Authentication required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Admin access required",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Put("policies/publish")
  @AuthenticatedRoute({ roles: ["ADMIN"] })
  async publishPolicyVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PublishPolicyVersionDto,
  ): Promise<{ success: boolean }> {
    await this.consentService.publishPolicyVersion(body.policyType, body.version);
    return { success: true };
  }

  /**
   * List policy versions (admin only).
   */
  @ApiOperation({
    summary: "List policy versions",
    description: "List all policy versions with their status. Admin only.",
  })
  @ApiQuery({
    name: "policyType",
    enum: PolicyType,
    required: false,
    description: "Filter by policy type",
  })
  @ApiQuery({
    name: "status",
    enum: PolicyStatus,
    required: false,
    description: "Filter by status",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Policy versions list",
    type: [PolicyVersionResponseDto],
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Authentication required",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Admin access required",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get("policies")
  @AuthenticatedRoute({ roles: ["ADMIN"] })
  async listPolicyVersions(
    @CurrentUser() user: AuthenticatedUser,
    @Query("policyType") policyType?: PolicyType,
    @Query("status") status?: PolicyStatus,
  ): Promise<PolicyVersionResponseDto[]> {
    const versions = await this.consentService.listPolicyVersions(policyType, status);
    
    return versions.map(version => ({
      id: version.id,
      policyType: version.policyType,
      version: version.version,
      contentHash: "", // Not exposed in list view
      status: version.status,
      publishedAt: version.publishedAt,
      createdAt: version.createdAt,
    }));
  }

  /**
   * Record user consent.
   */
  @ApiOperation({
    summary: "Record consent for a policy",
    description: "Accept or withdraw consent for a specific policy version. Creates immutable audit record.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Consent recorded successfully",
    type: ConsentResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Policy version not found or not published",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Authentication required",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Post("record")
  @AuthenticatedRoute({ ownership: "user" })
  async recordConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConsentRequestDto,
  ): Promise<ConsentResponseDto> {
    // Get user's organization context
    const orgMember = await this.getUserPrimaryOrganization(user.id);
    if (!orgMember) {
      throw new ForbiddenException("User must belong to an organization");
    }

    const result = await this.consentService.recordConsent(
      user.id,
      orgMember.organizationId,
      body.policyType,
      body.version,
      body.action,
    );

    return result;
  }

  /**
   * Get user's consent status.
   */
  @ApiOperation({
    summary: "Get consent status for a policy type",
    description: "Returns user's current consent status and whether updates are required.",
  })
  @ApiParam({
    name: "policyType",
    enum: PolicyType,
    description: "Policy type to check",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Consent status",
    type: ConsentStatusDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Authentication required",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get("status/:policyType")
  @AuthenticatedRoute({ ownership: "user" })
  async getConsentStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("policyType") policyType: PolicyType,
  ): Promise<ConsentStatusDto> {
    const orgMember = await this.getUserPrimaryOrganization(user.id);
    if (!orgMember) {
      throw new ForbiddenException("User must belong to an organization");
    }

    const status = await this.consentService.getUserConsentStatus(
      user.id,
      orgMember.organizationId,
      policyType,
    );

    return status;
  }

  /**
   * Get user's consent history.
   */
  @ApiOperation({
    summary: "Get consent history for a policy type",
    description: "Returns user's complete consent history for auditing purposes.",
  })
  @ApiParam({
    name: "policyType",
    enum: PolicyType,
    description: "Policy type to get history for",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Consent history",
    type: [ConsentRecordDto],
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Authentication required",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get("history/:policyType")
  @AuthenticatedRoute({ ownership: "user" })
  async getConsentHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param("policyType") policyType: PolicyType,
  ): Promise<ConsentRecordDto[]> {
    const orgMember = await this.getUserPrimaryOrganization(user.id);
    if (!orgMember) {
      throw new ForbiddenException("User must belong to an organization");
    }

    const history = await this.consentService.getUserConsentHistory(
      user.id,
      orgMember.organizationId,
      policyType,
    );

    return history;
  }

  /**
   * Check all required consents.
   */
  @ApiOperation({
    summary: "Check all required consent status",
    description: "Verify user has accepted all required policy versions.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Required consents check result",
    type: RequiredConsentsCheckDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Authentication required",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get("check-required")
  @AuthenticatedRoute({ ownership: "user" })
  async checkRequiredConsents(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RequiredConsentsCheckDto> {
    const orgMember = await this.getUserPrimaryOrganization(user.id);
    if (!orgMember) {
      throw new ForbiddenException("User must belong to an organization");
    }

    // Check both privacy policy and terms of service
    const requiredPolicyTypes = [PolicyType.PRIVACY_POLICY, PolicyType.TERMS_OF_SERVICE];
    
    const result = await this.consentService.checkRequiredConsents(
      user.id,
      orgMember.organizationId,
      requiredPolicyTypes,
    );

    return result;
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