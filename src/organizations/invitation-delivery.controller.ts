import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { AuthenticatedRoute } from '../auth/authentication.decorator';
import { RequiredOrganizationRole } from './decorators/required-organization-role.decorator';
import { OrganizationMemberRole } from '@prisma/client';
import { InvitationDeliverySuppressionService } from './invitation-delivery-suppression.service';
import { InvitationDeliveryLimitService } from './invitation-delivery-limit.service';
import { InvitationDeliveryOutcomeService } from './invitation-delivery-outcome.service';
import { InvitationDeliveryOverrideService } from './invitation-delivery-override.service';
import { InvitationDeliveryAuditService } from './invitation-delivery-audit.service';
import {
  AddSuppressionDto,
  RemoveSuppressionDto,
  CheckSuppressionResponseDto,
  SuppressionStatsDto,
} from './dto/invitation-delivery-suppression.dto';
import {
  CheckDeliveryLimitsDto,
  DeliveryLimitCheckResponseDto,
  OrganizationLimitStatsDto,
  ResetRecipientLimitsDto,
} from './dto/invitation-delivery-limit.dto';
import {
  RecordDeliveryOutcomeDto,
  OutcomeStatsDto,
  AbusePatternDto,
} from './dto/invitation-delivery-outcome.dto';
import {
  CreateOverrideDto,
  OverrideResponseDto,
  RevokeOverrideDto,
  ActiveOverridesResponseDto,
  OverrideStatsDto,
} from './dto/invitation-delivery-override.dto';

/**
 * InvitationDeliveryController manages invitation delivery abuse controls.
 *
 * Endpoints are organized by functional area:
 * 1. Suppression management (ADD, REMOVE, CHECK, LIST)
 * 2. Limit enforcement (CHECK, STATS, RESET)
 * 3. Outcome tracking (RECORD, STATS, DETECT_ABUSE)
 * 4. Override management (CREATE, REVOKE, LIST, STATS)
 *
 * All operations are ADMIN+ protected (role-based authorization).
 * All recipient identifiers are hashed (tenant-scoped, unhashable).
 * All changes are audit-logged via InvitationDeliveryAuditService.
 */
@Controller('organizations/:organizationId/invitation-delivery')
export class InvitationDeliveryController {
  private readonly logger = new Logger(InvitationDeliveryController.name);

  constructor(
    private readonly suppressionService: InvitationDeliverySuppressionService,
    private readonly limitService: InvitationDeliveryLimitService,
    private readonly outcomeService: InvitationDeliveryOutcomeService,
    private readonly overrideService: InvitationDeliveryOverrideService,
    private readonly auditService: InvitationDeliveryAuditService,
  ) {}

  // ============================================================================
  // SUPPRESSION MANAGEMENT
  // ============================================================================

  /**
   * Add a recipient to the suppression list.
   * ADMIN+ only.
   */
  @Post('suppressions')
  @AuthenticatedRoute('invitation:suppression:write')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async addSuppression(
    @Param('organizationId') organizationId: string,
    @Body() dto: AddSuppressionDto,
  ): Promise<any> {
    this.logger.debug(
      `Adding suppression: org=${organizationId}, email=${dto.email}`,
    );

    const suppression = await this.suppressionService.addSuppression(
      organizationId,
      dto.email,
      dto.reason,
      dto.sourceOutcome,
      dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      dto.note,
    );

    await this.auditService.logSuppressionChange(
      organizationId,
      'ADD_SUPPRESSION',
      dto.email,
      { reason: dto.reason, expiresAt: dto.expiresAt },
    );

    return {
      id: suppression.id,
      reason: suppression.reason,
      suppressedAt: suppression.suppressedAt,
      expiresAt: suppression.expiresAt,
      message: 'Recipient added to suppression list',
    };
  }

  /**
   * Remove a recipient from the suppression list.
   * ADMIN+ only.
   */
  @Delete('suppressions')
  @AuthenticatedRoute('invitation:suppression:write')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async removeSuppression(
    @Param('organizationId') organizationId: string,
    @Body() dto: RemoveSuppressionDto,
  ): Promise<any> {
    this.logger.debug(
      `Removing suppression: org=${organizationId}, email=${dto.email}`,
    );

    const removed = await this.suppressionService.removeSuppression(
      organizationId,
      dto.email,
    );

    if (!removed) {
      return {
        message: 'Recipient was not suppressed',
      };
    }

    await this.auditService.logSuppressionChange(
      organizationId,
      'REMOVE_SUPPRESSION',
      dto.email,
      { reason: removed.reason },
    );

    return {
      id: removed.id,
      reason: removed.reason,
      message: 'Recipient removed from suppression list',
    };
  }

  /**
   * Check if a recipient is suppressed.
   * ADMIN+ only (suppression list cannot be enumerated by non-admins).
   */
  @Post('suppressions/check')
  @AuthenticatedRoute('invitation:suppression:read')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async checkSuppression(
    @Param('organizationId') organizationId: string,
    @Body() dto: { email: string },
  ): Promise<CheckSuppressionResponseDto> {
    const suppression = await this.suppressionService.isSuppressed(
      organizationId,
      dto.email,
    );

    return {
      email: dto.email,
      isSuppressed: !!suppression,
      suppression: suppression || undefined,
      message: suppression ? 'Recipient is suppressed' : 'Recipient is not suppressed',
    };
  }

  /**
   * List suppressions for the organization (paginated).
   * ADMIN+ only.
   */
  @Get('suppressions')
  @AuthenticatedRoute('invitation:suppression:read')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  async listSuppressions(
    @Param('organizationId') organizationId: string,
    @Query('skip') skip: string = '0',
    @Query('take') take: string = '100',
  ): Promise<any> {
    const suppressions = await this.suppressionService.listSuppressions(
      organizationId,
      parseInt(skip, 10),
      parseInt(take, 10),
    );

    return {
      suppressions,
      count: suppressions.length,
    };
  }

  /**
   * Get suppression statistics.
   * ADMIN+ only.
   */
  @Get('suppressions/stats')
  @AuthenticatedRoute('invitation:suppression:read')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  async getSuppressionStats(
    @Param('organizationId') organizationId: string,
  ): Promise<SuppressionStatsDto> {
    return this.suppressionService.getSuppressionStats(organizationId);
  }

  // ============================================================================
  // LIMIT ENFORCEMENT
  // ============================================================================

  /**
   * Check if a recipient can receive an invitation (all limits).
   * ADMIN+ only.
   */
  @Post('limits/check')
  @AuthenticatedRoute('invitation:limits:read')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async checkLimits(
    @Param('organizationId') organizationId: string,
    @Body() dto: CheckDeliveryLimitsDto,
  ): Promise<DeliveryLimitCheckResponseDto> {
    const checks = await this.limitService.checkLimits(organizationId, dto.email);

    const canDeliver =
      checks.resendCooldownOk && checks.hourlyLimitOk && checks.dailyQuotaOk;
    const blockedReason =
      !checks.resendCooldownOk && checks.resendCooldownReason
        ? checks.resendCooldownReason
        : !checks.hourlyLimitOk && checks.hourlyLimitReason
          ? checks.hourlyLimitReason
          : !checks.dailyQuotaOk && checks.dailyQuotaReason
            ? checks.dailyQuotaReason
            : undefined;

    return {
      email: dto.email,
      organizationId,
      ...checks,
      canDeliver,
      blockedReason,
    };
  }

  /**
   * Get organization limit statistics.
   * ADMIN+ only.
   */
  @Get('limits/stats')
  @AuthenticatedRoute('invitation:limits:read')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  async getLimitStats(
    @Param('organizationId') organizationId: string,
  ): Promise<OrganizationLimitStatsDto> {
    return this.limitService.getOrganizationLimitStats(organizationId);
  }

  /**
   * Reset per-recipient limits (cooldown and hourly window).
   * ADMIN+ only (allows bypass for exceptional cases).
   */
  @Post('limits/reset')
  @AuthenticatedRoute('invitation:limits:write')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async resetLimits(
    @Param('organizationId') organizationId: string,
    @Body() dto: ResetRecipientLimitsDto,
  ): Promise<any> {
    await this.limitService.resetRecipientLimits(organizationId, dto.email);

    await this.auditService.logLimitChange(organizationId, 'RESET_LIMITS', dto.email);

    return {
      email: dto.email,
      message: 'Recipient limits reset',
    };
  }

  // ============================================================================
  // OUTCOME TRACKING
  // ============================================================================

  /**
   * Record a delivery outcome (success, bounce, complaint, etc.).
   * ADMIN+ only.
   */
  @Post('outcomes/record')
  @AuthenticatedRoute('invitation:outcomes:write')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async recordOutcome(
    @Param('organizationId') organizationId: string,
    @Body() dto: RecordDeliveryOutcomeDto,
  ): Promise<any> {
    const outcome = await this.outcomeService.recordOutcome(
      organizationId,
      dto.email,
      dto.outcome,
      dto.statusCode,
      dto.failureReason,
      dto.attemptCount,
    );

    await this.auditService.logOutcomeChange(
      organizationId,
      'RECORD_OUTCOME',
      dto.email,
      { outcome: dto.outcome },
    );

    return {
      id: outcome.id,
      outcome: outcome.outcome,
      attemptedAt: outcome.attemptedAt,
      message: `Outcome recorded: ${outcome.outcome}`,
    };
  }

  /**
   * Get delivery outcome statistics.
   * ADMIN+ only.
   */
  @Get('outcomes/stats')
  @AuthenticatedRoute('invitation:outcomes:read')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  async getOutcomeStats(
    @Param('organizationId') organizationId: string,
    @Query('hoursBack') hoursBack: string = '24',
  ): Promise<OutcomeStatsDto> {
    return this.outcomeService.getOutcomeStats(organizationId, parseInt(hoursBack, 10));
  }

  /**
   * Detect potential abuse patterns based on outcomes.
   * ADMIN+ only.
   */
  @Get('outcomes/abuse-patterns')
  @AuthenticatedRoute('invitation:outcomes:read')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  async detectAbusePatterns(
    @Param('organizationId') organizationId: string,
  ): Promise<AbusePatternDto> {
    return this.outcomeService.detectAbusePatterns(organizationId);
  }

  // ============================================================================
  // OVERRIDE MANAGEMENT
  // ============================================================================

  /**
   * Create an authorized override (requires recent auth).
   * ADMIN+ only.
   */
  @Post('overrides')
  @AuthenticatedRoute('invitation:overrides:write')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async createOverride(
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateOverrideDto,
  ): Promise<OverrideResponseDto> {
    const override = await this.overrideService.createOverride(
      organizationId,
      dto.email,
      dto.overrideType,
      dto.reason,
      dto.authorizedById,
      new Date(dto.authorizedAt),
      dto.assertionTokenHash,
      dto.description,
      dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    );

    await this.auditService.logOverrideChange(
      organizationId,
      'CREATE_OVERRIDE',
      dto.email,
      { overrideType: dto.overrideType, reason: dto.reason },
    );

    return override as any;
  }

  /**
   * Revoke an override.
   * ADMIN+ only.
   */
  @Post('overrides/:overrideId/revoke')
  @AuthenticatedRoute('invitation:overrides:write')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async revokeOverride(
    @Param('organizationId') organizationId: string,
    @Param('overrideId') overrideId: string,
    @Body() dto: { revokedById: string },
  ): Promise<any> {
    const override = await this.overrideService.revokeOverride(
      organizationId,
      overrideId,
      dto.revokedById,
    );

    await this.auditService.logOverrideChange(
      organizationId,
      'REVOKE_OVERRIDE',
      '',
      { overrideId },
    );

    return {
      id: override.id,
      revokedAt: override.revokedAt,
      message: 'Override revoked',
    };
  }

  /**
   * Get active overrides for a recipient.
   * ADMIN+ only.
   */
  @Post('overrides/active')
  @AuthenticatedRoute('invitation:overrides:read')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async getActiveOverrides(
    @Param('organizationId') organizationId: string,
    @Body() dto: { email: string },
  ): Promise<ActiveOverridesResponseDto> {
    const overrides = await this.overrideService.getActiveOverrides(
      organizationId,
      dto.email,
    );

    return {
      email: dto.email,
      organizationId,
      overrides: overrides as any,
    };
  }

  /**
   * List all overrides for the organization (paginated).
   * ADMIN+ only.
   */
  @Get('overrides')
  @AuthenticatedRoute('invitation:overrides:read')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  async listOverrides(
    @Param('organizationId') organizationId: string,
    @Query('skip') skip: string = '0',
    @Query('take') take: string = '100',
    @Query('includeRevoked') includeRevoked: string = 'false',
  ): Promise<any> {
    const overrides = await this.overrideService.listOverrides(
      organizationId,
      parseInt(skip, 10),
      parseInt(take, 10),
      includeRevoked === 'true',
    );

    return {
      overrides,
      count: overrides.length,
    };
  }

  /**
   * Get override statistics.
   * ADMIN+ only.
   */
  @Get('overrides/stats')
  @AuthenticatedRoute('invitation:overrides:read')
  @RequiredOrganizationRole(OrganizationMemberRole.ADMIN)
  async getOverrideStats(
    @Param('organizationId') organizationId: string,
  ): Promise<OverrideStatsDto> {
    return this.overrideService.getOverrideStats(organizationId);
  }
}
