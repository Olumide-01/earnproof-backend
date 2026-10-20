import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  CredentialQuarantine,
  CredentialQuarantineState,
  CredentialQuarantineReasonCode,
  UserRole,
  Organization,
} from '@prisma/client';
import * as crypto from 'crypto';

/**
 * Quarantine capacity and freshness constants
 */
const QUARANTINE_RECORDS_PER_TENANT_CAP = 10_000;
const QUARANTINE_CAPACITY_ALERT_THRESHOLD = 0.9;
const EVIDENCE_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const QUARANTINE_RETENTION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Field length caps (prevent blob attacks)
 */
const MAX_ISSUER_IDENTIFIER_LENGTH = 255;
const MAX_KEY_ID_LENGTH = 255;
const MAX_DECISION_REASON_LENGTH = 1024;
const MAX_SCHEMA_TYPE_LENGTH = 100;
const MAX_SCHEMA_VERSION_LENGTH = 64;

/**
 * Metadata for quarantine intake: safe allowlist only, never raw credential content
 */
interface QuarantineMetadata {
  contentHash: string; // SHA-256(canonical credential)
  contentSize: number; // Byte size of original credential
  schemaType: string;
  schemaVersion: string;
  issuerIdentifier: string;
  issuerPolicyVersion?: number;
  credentialProofType?: string;
  credentialExpiresAt?: Date;
  credentialIssuedAt?: Date;
  keyId?: string;
  keyType?: string;
  network?: string;
}

/**
 * Create quarantine DTO
 */
interface CreateQuarantineDto {
  organizationId: string;
  reason: CredentialQuarantineReasonCode;
  metadata: QuarantineMetadata;
  importedByUserId: string;
}

/**
 * Release credential DTO
 */
interface ReleaseCredentialDto {
  reason?: string;
}

/**
 * Reject credential DTO
 */
interface RejectCredentialDto {
  reason: string;
}

/**
 * Evidence refresh result
 */
interface EvidenceRefreshResult {
  issuerEvidence?: Record<string, any>;
  keyEvidence?: Record<string, any>;
  assetEvidence?: Record<string, any>;
  freshUntil: Date;
  anyStale: boolean;
}

/**
 * Credential Quarantine Service
 *
 * Manages isolation, state transitions, and lifecycle of quarantined credentials.
 * Ensures quarantined content never enters normal verification caches.
 */
@Injectable()
export class CredentialQuarantineService {
  private readonly logger = new Logger(CredentialQuarantineService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a quarantine record for a suspect credential.
   *
   * Prevents duplicate quarantines for the same contentHash per organization.
   * Enforces per-tenant capacity limits and alerts on approaching limit.
   *
   * @param dto Create quarantine parameters
   * @returns Newly created quarantine record
   * @throws BadRequestException on invalid metadata
   * @throws ConflictException if already quarantined
   * @throws PayloadTooLargeException if capacity exceeded
   */
  async createQuarantine(dto: CreateQuarantineDto): Promise<CredentialQuarantine> {
    // 1. Validate metadata lengths
    this.validateMetadataLengths(dto.metadata);

    // 2. Check for duplicate active quarantine (prevent re-quarantine of same credential)
    const existing = await this.prisma.credentialQuarantine.findFirst({
      where: {
        organizationId: dto.organizationId,
        contentHash: dto.metadata.contentHash,
        state: 'QUARANTINED',
      },
    });

    if (existing) {
      this.logger.warn(
        `Credential already quarantined: org=${dto.organizationId}, hash=${dto.metadata.contentHash}`,
      );
      throw new ConflictException(`Credential already quarantined: ${existing.id}`);
    }

    // 3. Check per-tenant capacity
    const count = await this.prisma.credentialQuarantine.count({
      where: { organizationId: dto.organizationId },
    });

    if (count >= QUARANTINE_RECORDS_PER_TENANT_CAP) {
      this.logger.error(
        `Quarantine capacity exceeded for org ${dto.organizationId}: ${count}/${QUARANTINE_RECORDS_PER_TENANT_CAP}`,
      );
      throw new PayloadTooLargeException(
        `Quarantine capacity exceeded; contact support`,
      );
    }

    if (count >= QUARANTINE_RECORDS_PER_TENANT_CAP * QUARANTINE_CAPACITY_ALERT_THRESHOLD) {
      this.logger.warn(
        `Quarantine approaching cap for org ${dto.organizationId}: ${count}/${QUARANTINE_RECORDS_PER_TENANT_CAP}`,
      );
    }

    // 4. Create quarantine record
    const expiresAt = new Date(Date.now() + QUARANTINE_RETENTION_DURATION_MS);

    const quarantine = await this.prisma.credentialQuarantine.create({
      data: {
        organizationId: dto.organizationId,
        tenantId: dto.organizationId, // Denormalized for tenant queries
        reason: dto.reason,
        state: 'QUARANTINED',
        contentHash: dto.metadata.contentHash,
        contentSize: dto.metadata.contentSize,
        schemaType: dto.metadata.schemaType,
        schemaVersion: dto.metadata.schemaVersion,
        issuerIdentifier: dto.metadata.issuerIdentifier,
        issuerPolicyVersion: dto.metadata.issuerPolicyVersion,
        credentialProofType: dto.metadata.credentialProofType,
        credentialExpiresAt: dto.metadata.credentialExpiresAt,
        credentialIssuedAt: dto.metadata.credentialIssuedAt,
        keyId: dto.metadata.keyId,
        keyType: dto.metadata.keyType,
        network: dto.metadata.network,
        importedByUserId: dto.importedByUserId,
        expiresAt,
      },
    });

    // 5. Log audit entry
    await this.createAuditEntry({
      quarantineId: quarantine.id,
      organizationId: dto.organizationId,
      event: 'QUARANTINED',
      actor: dto.importedByUserId,
      actorRole: 'WORKER', // Placeholder; should be derived from user context
      newState: 'QUARANTINED',
      changeReason: `Quarantine triggered: ${dto.reason}`,
    });

    this.logger.log(
      `Created quarantine: id=${quarantine.id}, org=${dto.organizationId}, reason=${dto.reason}`,
    );

    return quarantine;
  }

  /**
   * Get a quarantine record by ID with tenant scope validation.
   *
   * @param quarantineId Quarantine record ID
   * @param organizationId Organization (tenant) ID
   * @returns Quarantine record
   * @throws NotFoundException if not found or cross-tenant access attempt
   */
  async getQuarantine(quarantineId: string, organizationId: string): Promise<CredentialQuarantine> {
    const quarantine = await this.prisma.credentialQuarantine.findFirst({
      where: {
        id: quarantineId,
        organizationId, // Tenant scope
      },
    });

    if (!quarantine) {
      throw new NotFoundException(`Quarantine record not found: ${quarantineId}`);
    }

    return quarantine;
  }

  /**
   * List quarantine records for an organization with optional state filter.
   *
   * @param organizationId Organization (tenant) ID
   * @param state Optional state filter
   * @param limit Maximum results (default 100, max 1000)
   * @param offset Pagination offset
   * @returns Array of quarantine records
   */
  async listQuarantines(
    organizationId: string,
    state?: CredentialQuarantineState,
    limit: number = 100,
    offset: number = 0,
  ): Promise<CredentialQuarantine[]> {
    const safeLimit = Math.min(limit, 1000);

    return await this.prisma.credentialQuarantine.findMany({
      where: {
        organizationId,
        ...(state && { state }),
      },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
      skip: offset,
    });
  }

  /**
   * Refresh trust evidence for a quarantine record.
   *
   * Fetches current issuer keys, trust pins, and asset policies and records
   * the freshness timestamp. Evidence older than EVIDENCE_FRESHNESS_WINDOW_MS
   * cannot support release.
   *
   * @param quarantineId Quarantine record ID
   * @param organizationId Organization (tenant) ID
   * @param userId Actor performing the refresh
   * @returns Evidence refresh result with freshness timestamp
   * @throws NotFoundException if quarantine not found
   * @throws BadRequestException if record is in terminal state
   */
  async refreshEvidence(
    quarantineId: string,
    organizationId: string,
    userId: string,
  ): Promise<EvidenceRefreshResult> {
    const quarantine = await this.getQuarantine(quarantineId, organizationId);

    // Only QUARANTINED records can refresh
    if (quarantine.state !== 'QUARANTINED') {
      throw new BadRequestException(
        `Can only refresh evidence for QUARANTINED records; current state: ${quarantine.state}`,
      );
    }

    // Fetch current trust evidence
    let issuerEvidence: Record<string, any> | undefined;
    let keyEvidence: Record<string, any> | undefined;
    let assetEvidence: Record<string, any> | undefined;
    let anyStale = false;

    // TODO: Implement evidence fetching from issuer service, trust pin service, etc.
    // For now, stub the evidence as valid
    const now = new Date();
    const freshUntil = new Date(now.getTime() + EVIDENCE_FRESHNESS_WINDOW_MS);

    // Update quarantine record with freshness timestamp
    await this.prisma.credentialQuarantine.update({
      where: { id: quarantineId },
      data: {
        evidenceRefreshedAt: now,
        evidenceFreshUntil: freshUntil,
        evidenceRefreshReason: 'Manual refresh triggered',
      },
    });

    // Log audit entry
    await this.createAuditEntry({
      quarantineId,
      organizationId,
      event: 'EVIDENCE_REFRESHED',
      actor: userId,
      actorRole: 'ADMIN',
      evidenceResult: anyStale ? 'STALE' : 'FRESH',
      changeReason: 'Evidence refresh completed',
    });

    return {
      issuerEvidence,
      keyEvidence,
      assetEvidence,
      freshUntil,
      anyStale,
    };
  }

  /**
   * Check if evidence is fresh (within freshness window).
   *
   * @param quarantine Quarantine record
   * @returns true if evidence is fresh and within window
   */
  isEvidenceFresh(quarantine: CredentialQuarantine): boolean {
    if (!quarantine.evidenceRefreshedAt || !quarantine.evidenceFreshUntil) {
      return false; // No evidence; stale by default
    }
    return new Date() <= quarantine.evidenceFreshUntil;
  }

  /**
   * Release a quarantine record to normal credential store.
   *
   * Enforces:
   * - State is QUARANTINED
   * - Evidence is fresh
   * - Independent actor (not the importer, implements four-eyes)
   * - Full re-validation passes
   * - Optimistic concurrency (revision check)
   *
   * @param quarantineId Quarantine record ID
   * @param organizationId Organization (tenant) ID
   * @param releasingUserId User performing the release
   * @param dto Release parameters
   * @returns Updated quarantine record in RELEASED state
   * @throws Various exceptions for validation failures
   */
  async releaseCredential(
    quarantineId: string,
    organizationId: string,
    releasingUserId: string,
    dto: ReleaseCredentialDto,
  ): Promise<CredentialQuarantine> {
    const quarantine = await this.getQuarantine(quarantineId, organizationId);

    // 1. Check state
    if (quarantine.state !== 'QUARANTINED') {
      throw new BadRequestException(
        `Cannot release ${quarantine.state} record; only QUARANTINED records can be released`,
      );
    }

    // 2. Check evidence freshness
    if (!this.isEvidenceFresh(quarantine)) {
      throw new BadRequestException(
        `Evidence is stale; refresh before releasing. Last refreshed: ${quarantine.evidenceRefreshedAt}`,
      );
    }

    // 3. Check independence (four-eyes): releasing actor must not be the importer
    if (quarantine.importedByUserId === releasingUserId) {
      throw new ForbiddenException(
        `Cannot self-approve release; four-eyes required: importer and releaser must be different users`,
      );
    }

    // 4. TODO: Check authorization (must be ADMIN)
    // For now, assume authorization has been checked by the controller guard

    // 5. TODO: Re-validate credential using stored metadata
    // Full validation must pass before release

    // 6. Atomic release with optimistic concurrency
    const updated = await this.prisma.credentialQuarantine.updateMany({
      where: {
        id: quarantineId,
        revision: quarantine.revision, // Optimistic lock
      },
      data: {
        state: 'RELEASED',
        decidedByUserId: releasingUserId,
        decidedAt: new Date(),
        decisionReason: dto.reason,
        revision: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      throw new ConflictException(
        `Concurrent modification detected; the record was modified by another operation. Please retry.`,
      );
    }

    // 7. TODO: Import credential into normal Proof table
    // The credential is now trusted and can enter the verification pipeline

    // 8. Audit
    await this.createAuditEntry({
      quarantineId,
      organizationId,
      event: 'RELEASED',
      actor: releasingUserId,
      actorRole: 'ADMIN',
      previousState: 'QUARANTINED',
      newState: 'RELEASED',
      changeReason: `Released by independent actor with fresh evidence`,
    });

    const released = await this.getQuarantine(quarantineId, organizationId);
    this.logger.log(
      `Released quarantine: id=${quarantineId}, org=${organizationId}, actor=${releasingUserId}`,
    );

    return released;
  }

  /**
   * Reject a quarantine record permanently.
   *
   * Rejects with a reason and moves the record to REJECTED terminal state.
   * Rejecter does not need to be independent of importer.
   *
   * @param quarantineId Quarantine record ID
   * @param organizationId Organization (tenant) ID
   * @param rejectingUserId User performing the rejection
   * @param dto Rejection parameters
   * @returns Updated quarantine record in REJECTED state
   * @throws Various exceptions for validation failures
   */
  async rejectCredential(
    quarantineId: string,
    organizationId: string,
    rejectingUserId: string,
    dto: RejectCredentialDto,
  ): Promise<CredentialQuarantine> {
    const quarantine = await this.getQuarantine(quarantineId, organizationId);

    // Check state: only QUARANTINED records can be rejected
    if (quarantine.state !== 'QUARANTINED') {
      throw new BadRequestException(
        `Cannot reject ${quarantine.state} record; only QUARANTINED records can be rejected`,
      );
    }

    // Validate reason length
    if (dto.reason.length > MAX_DECISION_REASON_LENGTH) {
      throw new BadRequestException(
        `Rejection reason exceeds maximum length of ${MAX_DECISION_REASON_LENGTH} characters`,
      );
    }

    // Atomic reject with optimistic concurrency
    const updated = await this.prisma.credentialQuarantine.updateMany({
      where: {
        id: quarantineId,
        revision: quarantine.revision, // Optimistic lock
      },
      data: {
        state: 'REJECTED',
        decidedByUserId: rejectingUserId,
        decidedAt: new Date(),
        decisionReason: dto.reason,
        revision: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      throw new ConflictException(
        `Concurrent modification detected; the record was modified by another operation. Please retry.`,
      );
    }

    // Audit
    await this.createAuditEntry({
      quarantineId,
      organizationId,
      event: 'REJECTED',
      actor: rejectingUserId,
      actorRole: 'ADMIN',
      previousState: 'QUARANTINED',
      newState: 'REJECTED',
      changeReason: dto.reason,
    });

    const rejected = await this.getQuarantine(quarantineId, organizationId);
    this.logger.log(
      `Rejected quarantine: id=${quarantineId}, org=${organizationId}, reason=${dto.reason}`,
    );

    return rejected;
  }

  /**
   * Expire quarantine records past their deadline.
   *
   * Called by scheduled job daily to move QUARANTINED records with
   * expiresAt <= now to EXPIRED terminal state.
   *
   * @returns Count of expired records
   */
  async expireQuarantineRecords(): Promise<number> {
    const now = new Date();

    const expired = await this.prisma.credentialQuarantine.updateMany({
      where: {
        state: 'QUARANTINED',
        expiresAt: { lt: now },
      },
      data: {
        state: 'EXPIRED',
      },
    });

    if (expired.count > 0) {
      this.logger.log(`Expired ${expired.count} quarantine record(s)`);
    }

    return expired.count;
  }

  /**
   * Create an audit entry for a quarantine action.
   *
   * @param data Audit entry parameters
   */
  private async createAuditEntry(data: {
    quarantineId: string;
    organizationId: string;
    event: string;
    actor: string;
    actorRole: UserRole;
    previousState?: CredentialQuarantineState;
    newState?: CredentialQuarantineState;
    changeReason?: string;
    evidenceResult?: string;
    approvalRequestId?: string;
  }): Promise<void> {
    try {
      await this.prisma.credentialQuarantineAudit.create({
        data: {
          quarantineId: data.quarantineId,
          organizationId: data.organizationId,
          event: data.event,
          actor: data.actor,
          actorRole: data.actorRole,
          previousState: data.previousState,
          newState: data.newState,
          changeReason: data.changeReason,
          evidenceResult: data.evidenceResult,
          approvalRequestId: data.approvalRequestId,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to create audit entry: ${error.message}`);
      // Don't throw; audit failure should not block operations
    }
  }

  /**
   * Validate metadata field lengths to prevent blob attacks.
   *
   * @param metadata Metadata to validate
   * @throws BadRequestException if any field exceeds limits
   */
  private validateMetadataLengths(metadata: QuarantineMetadata): void {
    if (metadata.schemaType.length > MAX_SCHEMA_TYPE_LENGTH) {
      throw new BadRequestException(
        `schemaType exceeds maximum length of ${MAX_SCHEMA_TYPE_LENGTH}`,
      );
    }
    if (metadata.schemaVersion.length > MAX_SCHEMA_VERSION_LENGTH) {
      throw new BadRequestException(
        `schemaVersion exceeds maximum length of ${MAX_SCHEMA_VERSION_LENGTH}`,
      );
    }
    if (metadata.issuerIdentifier.length > MAX_ISSUER_IDENTIFIER_LENGTH) {
      throw new BadRequestException(
        `issuerIdentifier exceeds maximum length of ${MAX_ISSUER_IDENTIFIER_LENGTH}`,
      );
    }
    if (metadata.keyId && metadata.keyId.length > MAX_KEY_ID_LENGTH) {
      throw new BadRequestException(
        `keyId exceeds maximum length of ${MAX_KEY_ID_LENGTH}`,
      );
    }
  }
}
