import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, ResourceStatus } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { CreateAttestationDto } from "./dto/create-attestation.dto";
import { RevokeAttestationDto } from "./dto/revoke-attestation.dto";
import {
  AttestationResponseDto,
  ListAttestationsResponseDto,
} from "./dto/attestation-response.dto";
import { ListAttestationsDto } from "./dto/list-attestations.dto";

@Injectable()
export class AttestationsService {
  private readonly logger = new Logger(AttestationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new attestation issued by an active issuer for a subject.
   *
   * Requirements:
   * - Issuer must be ACTIVE
   * - Issuer must belong to the authenticated user's organization (if applicable)
   * - Subject wallet hash must be provided
   * - Attestation created with ACTIVE status by default
   *
   * @param user Authenticated user (ADMIN only for now)
   * @param issuerId ID of the issuer creating the attestation
   * @param input Attestation creation payload
   * @returns Created attestation DTO
   */
  async createAttestation(
    user: AuthenticatedUser,
    issuerId: string,
    input: CreateAttestationDto,
  ): Promise<AttestationResponseDto> {
    // Only admins can create attestations
    if (user.role !== "ADMIN") {
      throw new ForbiddenException("Only admins can create attestations");
    }

    // Verify issuer exists and is ACTIVE
    const issuer = await this.prisma.issuer.findUnique({
      where: { id: issuerId },
      select: {
        id: true,
        status: true,
        organizationId: true,
        organization: { select: { archivedAt: true } },
      },
    });

    if (!issuer) {
      throw new NotFoundException(`Issuer with ID "${issuerId}" not found`);
    }

    if (issuer.organization?.archivedAt) {
      throw new ConflictException(
        "Issuer's organization is archived; attestations cannot be issued",
      );
    }

    if (issuer.status !== ResourceStatus.ACTIVE) {
      throw new BadRequestException(
        `Issuer must be ACTIVE to issue attestations. Current status: ${issuer.status}`,
      );
    }

    // Parse expiry date if provided
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : undefined;

    // Validate expiry date is in the future
    if (expiresAt && expiresAt <= new Date()) {
      throw new BadRequestException(
        "expiresAt must be in the future",
      );
    }

    // Create attestation with audit log
    const attestation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.attestation.create({
        data: {
          issuerId,
          subjectWalletHash: input.subjectWalletHash,
          paymentReferenceHash: input.paymentReferenceHash,
          type: input.type,
          schemaVersion: input.schemaVersion ?? "1.0",
          signingKeyVersionId: input.signingKeyVersionId ?? "1",
          status: ResourceStatus.ACTIVE,
          signedPayload: input.signedPayload,
          expiresAt,
        },
      });

      // Log audit event
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorType: "User",
          action: "CREATE_ATTESTATION",
          resourceType: "Attestation",
          resourceId: created.id,
          metadata: {
            issuerId,
            type: input.type,
            subjectWalletHash: input.subjectWalletHash,
            schemaVersion: input.schemaVersion ?? "1.0",
            expiresAt: expiresAt?.toISOString(),
          },
        },
      });

      return created;
    });

    this.logger.log(
      `Attestation created: id=${attestation.id}, issuerId=${issuerId}, type=${attestation.type}`,
    );

    return this.toResponseDto(attestation);
  }

  /**
   * Retrieve a single attestation by ID.
   *
   * @param issuerId ID of the issuer (for authorization)
   * @param attestationId ID of the attestation to retrieve
   * @returns Attestation DTO with lifecycle metadata
   */
  async getAttestation(
    issuerId: string,
    attestationId: string,
  ): Promise<AttestationResponseDto> {
    const attestation = await this.prisma.attestation.findFirst({
      where: {
        id: attestationId,
        issuerId,
      },
    });

    if (!attestation) {
      throw new NotFoundException(
        `Attestation with ID "${attestationId}" not found for issuer "${issuerId}"`,
      );
    }

    return this.toResponseDto(attestation);
  }

  /**
   * List attestations for an issuer with filtering and pagination.
   *
   * Supports filtering by:
   * - Status (ACTIVE, PENDING, SUSPENDED, REVOKED, DELETED)
   * - Type (PAYMENT, EMPLOYMENT, INVOICE)
   * - Subject wallet hash
   * - Expiration date range
   *
   * @param issuerId ID of the issuer
   * @param query Filter and pagination parameters
   * @returns Paginated list of attestations
   */
  async listAttestations(
    issuerId: string,
    query: ListAttestationsDto,
  ): Promise<ListAttestationsResponseDto> {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    // Build where clause from query
    const where: Prisma.AttestationWhereInput = {
      issuerId,
    };

    if (query.status) {
      where.status = query.status;
    }

    if (query.type) {
      where.type = query.type;
    }

    if (query.subjectWalletHash) {
      where.subjectWalletHash = query.subjectWalletHash;
    }

    // Expiration date range filtering
    if (query.expiresAfter || query.expiresBefore) {
      where.expiresAt = {};
      if (query.expiresAfter) {
        (where.expiresAt as any).gte = new Date(query.expiresAfter);
      }
      if (query.expiresBefore) {
        (where.expiresAt as any).lte = new Date(query.expiresBefore);
      }
    }

    const [items, total] = await Promise.all([
      this.prisma.attestation.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: limit,
      }),
      this.prisma.attestation.count({ where }),
    ]);

    return {
      items: items.map((att) => this.toResponseDto(att)),
      total,
      page,
      limit,
    };
  }

  /**
   * Revoke an attestation.
   *
   * - Marks attestation as REVOKED
   * - Records revocation timestamp and reason
   * - Maintains immutable audit trail
   * - Does NOT delete the attestation
   *
   * Requirements:
   * - Attestation must exist and belong to the issuer
   * - Issuer user must be ADMIN
   * - Attestation should not already be REVOKED
   *
   * @param user Authenticated user (ADMIN)
   * @param issuerId Issuer ID (for authorization)
   * @param attestationId Attestation to revoke
   * @param input Revocation details (reason)
   * @returns Updated attestation DTO
   */
  async revokeAttestation(
    user: AuthenticatedUser,
    issuerId: string,
    attestationId: string,
    input: RevokeAttestationDto,
  ): Promise<AttestationResponseDto> {
    if (user.role !== "ADMIN") {
      throw new ForbiddenException("Only admins can revoke attestations");
    }

    const attestation = await this.prisma.attestation.findFirst({
      where: {
        id: attestationId,
        issuerId,
      },
    });

    if (!attestation) {
      throw new NotFoundException(
        `Attestation with ID "${attestationId}" not found for issuer "${issuerId}"`,
      );
    }

    if (attestation.status === ResourceStatus.REVOKED) {
      throw new BadRequestException(
        "Attestation is already revoked",
      );
    }

    // Revoke with audit trail
    const revoked = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.attestation.update({
        where: { id: attestationId },
        data: {
          status: ResourceStatus.REVOKED,
          revokedAt: new Date(),
          revokedBy: user.id,
          revocationReason: input.revocationReason,
        },
      });

      // Log audit event
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorType: "User",
          action: "REVOKE_ATTESTATION",
          resourceType: "Attestation",
          resourceId: attestationId,
          metadata: {
            issuerId,
            previousStatus: attestation.status,
            reason: input.revocationReason,
          },
        },
      });

      return updated;
    });

    this.logger.log(
      `Attestation revoked: id=${attestationId}, issuerId=${issuerId}, reason="${input.revocationReason || "none"}"`,
    );

    return this.toResponseDto(revoked);
  }

  /**
   * Check if an attestation is valid for use in proof issuance.
   *
   * An attestation is valid if:
   * - Status is ACTIVE
   * - Not expired (expiresAt is null or in the future)
   * - Not revoked (revokedAt is null)
   *
   * @param attestationId Attestation ID to check
   * @returns true if valid, false otherwise
   */
  async isAttestationValid(attestationId: string): Promise<boolean> {
    const attestation = await this.prisma.attestation.findUnique({
      where: { id: attestationId },
      select: {
        status: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    if (!attestation) {
      return false;
    }

    // Must be ACTIVE
    if (attestation.status !== ResourceStatus.ACTIVE) {
      return false;
    }

    // Must not be revoked
    if (attestation.revokedAt !== null) {
      return false;
    }

    // Must not be expired
    if (attestation.expiresAt !== null && attestation.expiresAt <= new Date()) {
      return false;
    }

    return true;
  }

  /**
   * Get lifecycle state of an attestation.
   *
   * Returns one of: "active", "expired", "revoked"
   *
   * @param attestationId Attestation ID
   * @returns Lifecycle state or null if not found
   */
  async getAttestationLifecycleState(
    attestationId: string,
  ): Promise<"active" | "expired" | "revoked" | null> {
    const attestation = await this.prisma.attestation.findUnique({
      where: { id: attestationId },
      select: {
        status: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    if (!attestation) {
      return null;
    }

    if (attestation.revokedAt !== null) {
      return "revoked";
    }

    if (
      attestation.expiresAt !== null &&
      attestation.expiresAt <= new Date()
    ) {
      return "expired";
    }

    return "active";
  }

  /**
   * Get all active (non-expired, non-revoked) attestations for a subject.
   *
   * Used by proof issuance logic to check attestation eligibility.
   *
   * @param subjectWalletHash Subject wallet hash
   * @param issuerId Optional issuer filter
   * @returns Array of valid attestations
   */
  async getValidAttestationsForSubject(
    subjectWalletHash: string,
    issuerId?: string,
  ): Promise<
    Array<{
      id: string;
      issuerId: string;
      type: string;
      expiresAt: Date | null;
    }>
  > {
    const now = new Date();

    return this.prisma.attestation.findMany({
      where: {
        AND: [
          {
            subjectWalletHash,
            status: ResourceStatus.ACTIVE,
            revokedAt: null,
          },
          {
            OR: [
              { expiresAt: { gt: now } }, // Expires in the future
              { expiresAt: null }, // Or no expiration
            ],
          },
          ...(issuerId ? [{ issuerId }] : []),
        ],
      },
      select: {
        id: true,
        issuerId: true,
        type: true,
        expiresAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Convert Prisma attestation to response DTO.
   *
   * Private method that computes derived fields (isValid, lifecycleState)
   * and excludes sensitive data.
   */
  private toResponseDto(attestation: any): AttestationResponseDto {
    const now = new Date();
    const isRevoked = attestation.revokedAt !== null;
    const isExpired =
      attestation.expiresAt !== null && attestation.expiresAt <= now;
    const isActive =
      attestation.status === ResourceStatus.ACTIVE && !isRevoked && !isExpired;

    let lifecycleState: "active" | "expired" | "revoked";
    if (isRevoked) {
      lifecycleState = "revoked";
    } else if (isExpired) {
      lifecycleState = "expired";
    } else {
      lifecycleState = "active";
    }

    return {
      id: attestation.id,
      issuerId: attestation.issuerId,
      subjectWalletHash: attestation.subjectWalletHash,
      paymentReferenceHash: attestation.paymentReferenceHash,
      type: attestation.type,
      schemaVersion: attestation.schemaVersion,
      signingKeyVersionId: attestation.signingKeyVersionId,
      status: attestation.status,
      createdAt: attestation.createdAt,
      expiresAt: attestation.expiresAt,
      revokedAt: attestation.revokedAt,
      revokedBy: attestation.revokedBy,
      revocationReason: attestation.revocationReason,
      updatedAt: attestation.updatedAt,
      isValid: isActive,
      lifecycleState,
    };
  }
}
