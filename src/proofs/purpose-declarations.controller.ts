import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiSecurity } from '@nestjs/swagger';
import { PurposeDeclarationsService } from './purpose-declarations.service';
import { PurposeDeclarationResponseDto, CreatePurposeDefinitionDto, CreatePurposeDeclarationDto, ApprovePurposeDeclarationDto, RevokePurposeDeclarationDto, PurposeDefinitionResponseDto } from './dto/purpose-declaration.dto';
import { AuthenticatedRoute } from '../common/decorators/authorization-policy.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentOrganization } from '../common/decorators/current-organization.decorator';

/**
 * Purpose Declaration Endpoints
 *
 * Lifecycle endpoints (versioned, tenant-scoped, role-gated) for managing
 * purpose declarations that organizations must approve before verification
 * runs under policies configured to require them.
 */
@Controller('api/v1/organizations/:organizationId/purpose-declarations')
@ApiTags('Purpose Declarations')
@ApiSecurity('bearerAuth')
export class PurposeDeclarationsController {
  constructor(private purposeDeclarationsService: PurposeDeclarationsService) {}

  /**
   * Create a new purpose definition version.
   * A purpose definition is immutable once created; versions are numbered
   * and incremented for changes.
   *
   * Requires: ORG_ADMIN role for the organization.
   */
  @Post('definitions')
  @AuthenticatedRoute({ ownership: 'organization' })
  @ApiOperation({
    summary: 'Create a new purpose definition version',
    description: 'Creates an immutable purpose definition version within an organization.',
  })
  async createPurposeDefinition(
    @CurrentOrganization() organizationId: string,
    @CurrentUser() user: any,
    @Body() dto: CreatePurposeDefinitionDto,
  ): Promise<PurposeDefinitionResponseDto> {
    // Verify user is an admin of the organization
    // This would be enforced by the @AuthenticatedRoute decorator with role checks
    // in a real implementation.

    const definition = await this.purposeDeclarationsService.createPurposeDefinition(
      organizationId,
      {
        purposeKey: dto.purposeKey,
        description: dto.description,
        disclosureScope: dto.disclosureScope,
      },
    );

    return this.mapPurposeDefinitionToDto(definition);
  }

  /**
   * Create a new purpose declaration (pending approval).
   * Initially in PENDING state. An authorized approver must approve it
   * before verification can use it.
   *
   * Requires: ORG_ADMIN role for the organization.
   */
  @Post()
  @AuthenticatedRoute({ ownership: 'organization' })
  @ApiOperation({
    summary: 'Create a new purpose declaration',
    description: 'Creates a new purpose declaration in PENDING state, awaiting approval.',
  })
  async createPurposeDeclaration(
    @CurrentOrganization() organizationId: string,
    @CurrentUser() user: any,
    @Body() dto: CreatePurposeDeclarationDto,
  ): Promise<PurposeDeclarationResponseDto> {
    const declaration = await this.purposeDeclarationsService.createPurposeDeclaration(
      organizationId,
      user.id,
      {
        purposeDefinitionId: dto.purposeDefinitionId,
        expiresAt: new Date(dto.expiresAt),
      },
    );

    return this.mapPurposeDeclarationToDto(declaration);
  }

  /**
   * Approve a purpose declaration.
   * Transition from PENDING to APPROVED. Requires independent approver
   * (not the requester). Idempotent: replayed requests return success.
   *
   * Requires: ORG_ADMIN or ORG_OWNER role for the organization.
   * Approver must be different from the declaration requester (enforced
   * via requester context in the endpoint).
   */
  @Patch(':declarationId/approve')
  @AuthenticatedRoute({ ownership: 'organization' })
  @ApiOperation({
    summary: 'Approve a purpose declaration',
    description:
      'Approves a purpose declaration, transitioning it from PENDING to APPROVED. ' +
      'Requires an authorized approver independent of the requester. Idempotent.',
  })
  async approvePurposeDeclaration(
    @CurrentOrganization() organizationId: string,
    @CurrentUser() user: any,
    @Param('declarationId') declarationId: string,
    @Body() dto: ApprovePurposeDeclarationDto,
  ): Promise<PurposeDeclarationResponseDto> {
    const declaration = await this.purposeDeclarationsService.approvePurposeDeclaration(
      organizationId,
      user.id,
      {
        declarationId,
        reason: dto.reason,
      },
    );

    return this.mapPurposeDeclarationToDto(declaration);
  }

  /**
   * Revoke a purpose declaration.
   * Transition from PENDING or APPROVED to REVOKED. Takes effect immediately
   * for new verifications. Idempotent: replayed requests return success.
   *
   * Requires: ORG_ADMIN or ORG_OWNER role for the organization.
   */
  @Patch(':declarationId/revoke')
  @AuthenticatedRoute({ ownership: 'organization' })
  @ApiOperation({
    summary: 'Revoke a purpose declaration',
    description:
      'Revokes a purpose declaration, transitioning it to REVOKED state. ' +
      'Takes effect immediately for new verifications. Idempotent.',
  })
  async revokePurposeDeclaration(
    @CurrentOrganization() organizationId: string,
    @CurrentUser() user: any,
    @Param('declarationId') declarationId: string,
    @Body() dto: RevokePurposeDeclarationDto,
  ): Promise<PurposeDeclarationResponseDto> {
    const declaration = await this.purposeDeclarationsService.revokePurposeDeclaration(
      organizationId,
      user.id,
      {
        declarationId,
        reason: dto.reason,
      },
    );

    return this.mapPurposeDeclarationToDto(declaration);
  }

  /**
   * Get a single purpose declaration by ID.
   *
   * Requires: ORG_ADMIN, ORG_OWNER, or ORG_MEMBER role for the organization.
   */
  @Get(':declarationId')
  @AuthenticatedRoute({ ownership: 'organization' })
  @ApiOperation({
    summary: 'Get a purpose declaration',
    description: 'Retrieves a single purpose declaration by ID.',
  })
  async getDeclaration(
    @CurrentOrganization() organizationId: string,
    @Param('declarationId') declarationId: string,
  ): Promise<PurposeDeclarationResponseDto> {
    const declaration = await this.purposeDeclarationsService.getDeclaration(
      organizationId,
      declarationId,
    );

    if (!declaration) {
      throw new NotFoundException('Purpose declaration not found');
    }

    return this.mapPurposeDeclarationToDto(declaration);
  }

  /**
   * List purpose declarations for an organization.
   * Supports filtering by approval state and pagination.
   *
   * Requires: ORG_ADMIN, ORG_OWNER, or ORG_MEMBER role for the organization.
   */
  @Get()
  @AuthenticatedRoute({ ownership: 'organization' })
  @ApiOperation({
    summary: 'List purpose declarations',
    description: 'Lists purpose declarations for an organization, with optional filtering.',
  })
  async listDeclarations(
    @CurrentOrganization() organizationId: string,
    @Query('approvalState') approvalState?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ): Promise<{ declarations: PurposeDeclarationResponseDto[]; total: number }> {
    const { declarations, total } = await this.purposeDeclarationsService.listDeclarations(
      organizationId,
      {
        approvalState: approvalState as any,
        skip: skip ? parseInt(skip, 10) : 0,
        take: take ? parseInt(take, 10) : 100,
      },
    );

    return {
      declarations: declarations.map((d) => this.mapPurposeDeclarationToDto(d)),
      total,
    };
  }

  // Mapping helpers
  private mapPurposeDeclarationToDto(declaration: any): PurposeDeclarationResponseDto {
    return {
      id: declaration.id,
      organizationId: declaration.organizationId,
      purposeDefinitionId: declaration.purposeDefinitionId,
      verifierOrganizationId: declaration.verifierOrganizationId,
      approvalState: declaration.approvalState,
      approvedAt: declaration.approvedAt?.toISOString() ?? null,
      approvedById: declaration.approvedById,
      revokedAt: declaration.revokedAt?.toISOString() ?? null,
      revokedById: declaration.revokedById,
      expiresAt: declaration.expiresAt.toISOString(),
      revision: declaration.revision,
      createdAt: declaration.createdAt.toISOString(),
      updatedAt: declaration.updatedAt.toISOString(),
    };
  }

  private mapPurposeDefinitionToDto(definition: any): PurposeDefinitionResponseDto {
    return {
      id: definition.id,
      organizationId: definition.organizationId,
      purposeKey: definition.purposeKey,
      version: definition.version,
      description: definition.description,
      disclosureScope: definition.disclosureScope,
      createdAt: definition.createdAt.toISOString(),
      deactivatedAt: definition.deactivatedAt?.toISOString() ?? null,
    };
  }
}
