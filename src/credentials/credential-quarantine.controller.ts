import {
  Controller,
  Get,
  Post,
  UseGuards,
  Param,
  Body,
  Query,
  HttpCode,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { RequiredRole } from '../common/decorators/required-role.decorator';
import { AuthenticatedUser } from '../common/decorators/authenticated-user.decorator';
import { AuthenticatedSession } from '../common/types/authenticated-session';
import { CredentialQuarantineService } from './credential-quarantine.service';
import { CredentialQuarantine, CredentialQuarantineState } from '@prisma/client';

interface ReleaseCredentialRequest {
  reason?: string;
}

interface RejectCredentialRequest {
  reason: string;
}

interface RefreshEvidenceResponse {
  quarantineId: string;
  freshUntil: string;
  anyStale: boolean;
}

interface ReleaseCredentialResponse {
  quarantineId: string;
  state: CredentialQuarantineState;
}

interface RejectCredentialResponse {
  quarantineId: string;
  state: CredentialQuarantineState;
}

interface ListQuarantinesResponse {
  items: CredentialQuarantine[];
  count: number;
}

/**
 * Credential Quarantine Controller (v1)
 *
 * Versioned endpoints for managing credential quarantine, evidence refresh,
 * release, and rejection. Implements tenant scoping and role-based access control.
 *
 * All endpoints require authentication and ADMIN role for state-changing operations.
 * Tenant scoping is enforced at the service layer (404 for cross-tenant access).
 */
@ApiTags('Credential Quarantine (v1)')
@ApiBearerAuth()
@Controller('api/v1/credential-quarantine')
export class CredentialQuarantineController {
  private readonly logger = new Logger(CredentialQuarantineController.name);

  constructor(private readonly quarantineService: CredentialQuarantineService) {}

  /**
   * List quarantine records for the authenticated user's organization.
   *
   * GET /api/v1/credential-quarantine
   *
   * Query parameters:
   * - state: Optional state filter (QUARANTINED, RELEASED, REJECTED, EXPIRED)
   * - limit: Maximum results (default 100, max 1000)
   * - offset: Pagination offset (default 0)
   *
   * @returns Array of quarantine records visible to the user's organization
   */
  @Get()
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole(['ADMIN', 'WORKER'])
  @ApiOperation({
    summary: 'List quarantine records for organization',
    description: 'Returns paginated list of quarantine records with optional state filter.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of quarantine records',
  })
  async listQuarantines(
    @AuthenticatedUser() session: AuthenticatedSession,
    @Query('state') state?: CredentialQuarantineState,
    @Query('limit') limit: string = '100',
    @Query('offset') offset: string = '0',
  ): Promise<ListQuarantinesResponse> {
    const safeLimit = Math.min(parseInt(limit, 10) || 100, 1000);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const items = await this.quarantineService.listQuarantines(
      session.organizationId,
      state,
      safeLimit,
      safeOffset,
    );

    return {
      items,
      count: items.length,
    };
  }

  /**
   * Get a single quarantine record by ID.
   *
   * GET /api/v1/credential-quarantine/:quarantineId
   *
   * @param quarantineId Quarantine record ID
   * @returns Quarantine record detail
   */
  @Get(':quarantineId')
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole(['ADMIN', 'WORKER'])
  @ApiOperation({
    summary: 'Get quarantine record by ID',
    description: 'Returns detailed quarantine record including metadata and audit trail.',
  })
  @ApiResponse({
    status: 200,
    description: 'Quarantine record detail',
  })
  @ApiResponse({
    status: 404,
    description: 'Quarantine record not found or cross-tenant access attempt',
  })
  async getQuarantine(
    @AuthenticatedUser() session: AuthenticatedSession,
    @Param('quarantineId') quarantineId: string,
  ): Promise<CredentialQuarantine> {
    return await this.quarantineService.getQuarantine(quarantineId, session.organizationId);
  }

  /**
   * Refresh trust evidence for a quarantine record.
   *
   * POST /api/v1/credential-quarantine/:quarantineId/refresh
   *
   * Fetches current issuer keys, trust pins, and asset policies and records
   * the freshness timestamp. Evidence must be fresh (refreshed within 24 hours)
   * to support release.
   *
   * @param quarantineId Quarantine record ID
   * @returns Evidence freshness result
   */
  @Post(':quarantineId/refresh')
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole(['ADMIN'])
  @HttpCode(200)
  @ApiOperation({
    summary: 'Refresh trust evidence for quarantine record',
    description:
      'Fetches current issuer keys, trust pins, and policies. Evidence must be fresh (within 24 hours) to support release.',
  })
  @ApiResponse({
    status: 200,
    description: 'Evidence refreshed',
  })
  @ApiResponse({
    status: 400,
    description: 'Record not in QUARANTINED state',
  })
  async refreshEvidence(
    @AuthenticatedUser() session: AuthenticatedSession,
    @Param('quarantineId') quarantineId: string,
  ): Promise<RefreshEvidenceResponse> {
    const result = await this.quarantineService.refreshEvidence(
      quarantineId,
      session.organizationId,
      session.userId,
    );

    return {
      quarantineId,
      freshUntil: result.freshUntil.toISOString(),
      anyStale: result.anyStale,
    };
  }

  /**
   * Release a quarantine record to normal credential store.
   *
   * POST /api/v1/credential-quarantine/:quarantineId/release
   *
   * Enforces:
   * - State is QUARANTINED
   * - Evidence is fresh (refreshed within 24 hours)
   * - Releasing actor is not the importer (four-eyes)
   * - Full re-validation passes
   * - ADMIN role required
   *
   * @param quarantineId Quarantine record ID
   * @param dto Release parameters (optional reason)
   * @returns Updated quarantine in RELEASED state
   */
  @Post(':quarantineId/release')
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole(['ADMIN'])
  @HttpCode(200)
  @ApiOperation({
    summary: 'Release quarantine record to normal store',
    description:
      'Moves record to RELEASED state and imports credential to normal Proof table. Requires four-eyes (independent actor) and fresh evidence.',
  })
  @ApiResponse({
    status: 200,
    description: 'Credential released',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid state, stale evidence, or re-validation failed',
  })
  @ApiResponse({
    status: 403,
    description: 'Importer cannot self-approve; four-eyes required',
  })
  @ApiResponse({
    status: 409,
    description: 'Concurrent modification (optimistic lock failed)',
  })
  async releaseCredential(
    @AuthenticatedUser() session: AuthenticatedSession,
    @Param('quarantineId') quarantineId: string,
    @Body() dto: ReleaseCredentialRequest,
  ): Promise<ReleaseCredentialResponse> {
    const released = await this.quarantineService.releaseCredential(
      quarantineId,
      session.organizationId,
      session.userId,
      dto,
    );

    return {
      quarantineId: released.id,
      state: released.state,
    };
  }

  /**
   * Reject a quarantine record permanently.
   *
   * POST /api/v1/credential-quarantine/:quarantineId/reject
   *
   * Moves record to REJECTED terminal state with a reason.
   * Rejecter does not need to be independent of importer.
   *
   * @param quarantineId Quarantine record ID
   * @param dto Rejection parameters (required reason)
   * @returns Updated quarantine in REJECTED state
   */
  @Post(':quarantineId/reject')
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole(['ADMIN'])
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reject quarantine record permanently',
    description: 'Moves record to REJECTED terminal state. Credential will never be usable.',
  })
  @ApiResponse({
    status: 200,
    description: 'Credential rejected',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid state, reason missing, or reason too long',
  })
  @ApiResponse({
    status: 409,
    description: 'Concurrent modification (optimistic lock failed)',
  })
  async rejectCredential(
    @AuthenticatedUser() session: AuthenticatedSession,
    @Param('quarantineId') quarantineId: string,
    @Body() dto: RejectCredentialRequest,
  ): Promise<RejectCredentialResponse> {
    if (!dto.reason || typeof dto.reason !== 'string' || dto.reason.trim().length === 0) {
      throw new BadRequestException('reason is required and must be a non-empty string');
    }

    const rejected = await this.quarantineService.rejectCredential(
      quarantineId,
      session.organizationId,
      session.userId,
      dto,
    );

    return {
      quarantineId: rejected.id,
      state: rejected.state,
    };
  }
}
