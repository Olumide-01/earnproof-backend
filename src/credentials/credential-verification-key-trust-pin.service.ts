import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { CredentialVerificationKeyTrustPin, Prisma } from "@prisma/client";
import {
  CreateCredentialVerificationKeyTrustPinDto,
  UpdateCredentialVerificationKeyTrustPinStatusDto,
  CredentialVerificationKeyTrustPinResponseDto,
  TrustedKeySnapshot,
  TrustDecisionMetadata,
} from "./dto/credential-verification-key-trust-pin.dto";

/**
 * CredentialVerificationKeyTrustPinService
 *
 * Manages persistent trust pins for credential verification keys.
 * Enforces requirements:
 * - Private keys are never accepted; only public key material is pinned
 * - A pin cannot cross issuers or networks (scoped constraints)
 * - Compromised keys fail closed (marked REVOKED immediately, deterministic)
 * - Only one ACTIVE pin per issuer/network/key combination per organization
 * - Trust decisions are immutable snapshots; live key state never mutates them
 *
 * All operations are deterministic and logged for auditability.
 */
@Injectable()
export class CredentialVerificationKeyTrustPinService {
  private readonly logger = new Logger(CredentialVerificationKeyTrustPinService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new trust pin for an issuer verification key.
   *
   * Enforces:
   * - The issuer must exist and belong to the organization
   * - Only public key material is accepted (no private key markers)
   * - No active pin already exists for this issuer/network/key combination
   * - Network and issuer are properly scoped
   */
  async createTrustPin(
    dto: CreateCredentialVerificationKeyTrustPinDto,
  ): Promise<CredentialVerificationKeyTrustPinResponseDto> {
    // Validate issuer exists and belongs to organization
    const issuer = await this.prisma.issuer.findUnique({
      where: { id: dto.issuerId },
    });

    if (!issuer) {
      throw new NotFoundException(`Issuer ${dto.issuerId} not found`);
    }

    if (issuer.organizationId !== dto.organizationId) {
      throw new ForbiddenException(
        `Issuer ${dto.issuerId} does not belong to organization ${dto.organizationId}`,
      );
    }

    // Validate trusted key snapshot doesn't contain private key material
    this.validateKeySnapshot(dto.trustedKeySnapshot);

    // Check for existing active pin
    const existingPin = await this.prisma.credentialVerificationKeyTrustPin.findFirst({
      where: {
        organizationId: dto.organizationId,
        issuerId: dto.issuerId,
        network: dto.network,
        keyId: dto.keyId,
        status: "ACTIVE",
      },
    });

    if (existingPin) {
      throw new ConflictException(
        `An active trust pin already exists for this issuer/network/key combination`,
      );
    }

    // Create the trust pin
    const pin = await this.prisma.credentialVerificationKeyTrustPin.create({
      data: {
        organizationId: dto.organizationId,
        issuerId: dto.issuerId,
        network: dto.network,
        keyId: dto.keyId,
        trustedKeySnapshot: dto.trustedKeySnapshot as Prisma.InputJsonValue,
        effectiveAt: new Date(dto.effectiveAt),
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        status: "ACTIVE",
        decisionMetadata: dto.decisionMetadata as Prisma.InputJsonValue | null,
        revision: 0,
      },
    });

    this.logger.log(`Created trust pin ${pin.id} for issuer ${dto.issuerId}`);
    return this.mapToResponseDto(pin);
  }

  /**
   * Get a trust pin by ID.
   */
  async getTrustPin(id: string): Promise<CredentialVerificationKeyTrustPinResponseDto> {
    const pin = await this.prisma.credentialVerificationKeyTrustPin.findUnique({
      where: { id },
    });

    if (!pin) {
      throw new NotFoundException(`Trust pin ${id} not found`);
    }

    return this.mapToResponseDto(pin);
  }

  /**
   * Get the active trust pin for an issuer/network/key combination.
   * Returns null if no active pin exists.
   */
  async getActiveTrustPin(
    organizationId: string,
    issuerId: string,
    network: string,
    keyId: string,
  ): Promise<CredentialVerificationKeyTrustPinResponseDto | null> {
    const pin = await this.prisma.credentialVerificationKeyTrustPin.findFirst({
      where: {
        organizationId,
        issuerId,
        network,
        keyId,
        status: "ACTIVE",
      },
    });

    return pin ? this.mapToResponseDto(pin) : null;
  }

  /**
   * List trust pins for an issuer, optionally filtered by status.
   */
  async listTrustPins(
    organizationId: string,
    issuerId: string,
    options?: {
      status?: "ACTIVE" | "RETIRED" | "REVOKED";
      page?: number;
      pageSize?: number;
    },
  ): Promise<{
    pins: CredentialVerificationKeyTrustPinResponseDto[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = options?.page || 1;
    const pageSize = options?.pageSize || 10;
    const skip = (page - 1) * pageSize;

    const where: Prisma.CredentialVerificationKeyTrustPinWhereInput = {
      organizationId,
      issuerId,
    };

    if (options?.status) {
      where.status = options.status;
    }

    const [pins, total] = await Promise.all([
      this.prisma.credentialVerificationKeyTrustPin.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.credentialVerificationKeyTrustPin.count({ where }),
    ]);

    return {
      pins: pins.map((p) => this.mapToResponseDto(p)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Retire a trust pin (mark as RETIRED).
   * Retirement is a planned supersession; a new pin should typically be created first.
   * Uses optimistic concurrency control via revision.
   */
  async retireTrustPin(
    id: string,
    expectedRevision: number,
  ): Promise<CredentialVerificationKeyTrustPinResponseDto> {
    const pin = await this.prisma.credentialVerificationKeyTrustPin.findUnique({
      where: { id },
    });

    if (!pin) {
      throw new NotFoundException(`Trust pin ${id} not found`);
    }

    if (pin.revision !== expectedRevision) {
      throw new ConflictException(
        `Trust pin revision mismatch. Expected ${expectedRevision}, got ${pin.revision}`,
      );
    }

    if (pin.status === "RETIRED" || pin.status === "REVOKED") {
      throw new BadRequestException(
        `Cannot retire a pin that is already ${pin.status}`,
      );
    }

    const updated = await this.prisma.credentialVerificationKeyTrustPin.update({
      where: { id },
      data: {
        status: "RETIRED",
        revision: { increment: 1 },
        updatedAt: new Date(),
      },
    });

    this.logger.log(`Retired trust pin ${id}`);
    return this.mapToResponseDto(updated);
  }

  /**
   * Revoke a trust pin due to compromise.
   * Revocation is permanent and deterministic; the pin fails closed.
   * Uses optimistic concurrency control via revision.
   * Captures revocation reason and actor for audit trail.
   */
  async revokeTrustPin(
    id: string,
    dto: UpdateCredentialVerificationKeyTrustPinStatusDto,
  ): Promise<CredentialVerificationKeyTrustPinResponseDto> {
    const pin = await this.prisma.credentialVerificationKeyTrustPin.findUnique({
      where: { id },
    });

    if (!pin) {
      throw new NotFoundException(`Trust pin ${id} not found`);
    }

    if (dto.expectedRevision !== undefined && pin.revision !== dto.expectedRevision) {
      throw new ConflictException(
        `Trust pin revision mismatch. Expected ${dto.expectedRevision}, got ${pin.revision}`,
      );
    }

    if (pin.status === "REVOKED") {
      throw new BadRequestException(`Trust pin is already revoked`);
    }

    if (!dto.revocationReason) {
      throw new BadRequestException(`Revocation reason is required`);
    }

    if (!dto.revokedBy) {
      throw new BadRequestException(`revokedBy actor ID is required`);
    }

    const updated = await this.prisma.credentialVerificationKeyTrustPin.update({
      where: { id },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        revokedBy: dto.revokedBy,
        revocationReason: dto.revocationReason,
        revision: { increment: 1 },
        updatedAt: new Date(),
      },
    });

    this.logger.warn(
      `Revoked trust pin ${id} for issuer ${pin.issuerId}: ${dto.revocationReason}`,
    );
    return this.mapToResponseDto(updated);
  }

  /**
   * Check if a key is trusted for verification.
   *
   * Returns true if:
   * - An ACTIVE trust pin exists for the issuer/network/key
   * - The pin is within its effective window (now >= effectiveAt)
   * - The pin has not expired (expiresAt is null or in the future)
   *
   * Returns false otherwise (fails closed).
   */
  async isKeyTrusted(
    organizationId: string,
    issuerId: string,
    network: string,
    keyId: string,
  ): Promise<boolean> {
    const now = new Date();

    const pin = await this.prisma.credentialVerificationKeyTrustPin.findFirst({
      where: {
        organizationId,
        issuerId,
        network,
        keyId,
        status: "ACTIVE",
        effectiveAt: { lte: now },
        OR: [
          { expiresAt: null },
          { expiresAt: { gte: now } },
        ],
      },
    });

    return !!pin;
  }

  /**
   * Get all trust pins that have expired and should be marked stale or cleaned up.
   * Used by reconciliation/maintenance workers.
   */
  async getExpiredPins(): Promise<CredentialVerificationKeyTrustPin[]> {
    const now = new Date();
    return this.prisma.credentialVerificationKeyTrustPin.findMany({
      where: {
        status: "ACTIVE",
        expiresAt: { lt: now },
      },
      orderBy: { expiresAt: "asc" },
    });
  }

  /**
   * Delete a trust pin (used in testing; not exposed via API in production).
   */
  async deleteTrustPin(id: string): Promise<void> {
    const pin = await this.prisma.credentialVerificationKeyTrustPin.findUnique({
      where: { id },
    });

    if (!pin) {
      throw new NotFoundException(`Trust pin ${id} not found`);
    }

    await this.prisma.credentialVerificationKeyTrustPin.delete({
      where: { id },
    });

    this.logger.log(`Deleted trust pin ${id}`);
  }

  /**
   * Validate that the trusted key snapshot contains only public key material.
   * Rejects if it contains private key markers or suspicious fields.
   */
  private validateKeySnapshot(snapshot: TrustedKeySnapshot): void {
    // Check required fields
    if (!snapshot.alg || !snapshot.crv || !snapshot.kid || !snapshot.kty || !snapshot.x) {
      throw new BadRequestException("Trust pin snapshot is missing required key fields");
    }

    // Enforce EdDSA/Ed25519
    if (snapshot.alg !== "EdDSA" || snapshot.crv !== "Ed25519") {
      throw new BadRequestException("Only EdDSA/Ed25519 keys are supported");
    }

    if (snapshot.kty !== "OKP") {
      throw new BadRequestException("Only OKP (Octet Key Pair) keys are supported");
    }

    if (snapshot.use !== "sig") {
      throw new BadRequestException("Key use must be 'sig' (signature)");
    }

    if (snapshot.status !== "active" && snapshot.status !== "retired") {
      throw new BadRequestException("Key status must be 'active' or 'retired'");
    }

    // Reject if private key material is present (common mistake markers)
    const snapshotStr = JSON.stringify(snapshot);
    const dangerousMarkers = ["d", "secret", "private", "p", "q", "dp", "dq", "qi"];
    for (const marker of dangerousMarkers) {
      if (snapshotStr.includes(`"${marker}"`)) {
        throw new BadRequestException(
          "Trust pin snapshot must not contain private key material",
        );
      }
    }

    // Validate x is base64url-encoded (rough check)
    if (!/^[A-Za-z0-9_-]+$/.test(snapshot.x)) {
      throw new BadRequestException(
        "Key material (x) must be base64url-encoded without padding",
      );
    }
  }

  /**
   * Map Prisma model to response DTO.
   */
  private mapToResponseDto(
    pin: CredentialVerificationKeyTrustPin,
  ): CredentialVerificationKeyTrustPinResponseDto {
    return {
      id: pin.id,
      organizationId: pin.organizationId,
      issuerId: pin.issuerId,
      network: pin.network,
      keyId: pin.keyId,
      trustedKeySnapshot: pin.trustedKeySnapshot as TrustedKeySnapshot,
      effectiveAt: pin.effectiveAt.toISOString(),
      expiresAt: pin.expiresAt?.toISOString() ?? null,
      status: pin.status,
      decisionMetadata: pin.decisionMetadata as TrustDecisionMetadata | undefined,
      revision: pin.revision,
      revokedAt: pin.revokedAt?.toISOString() ?? null,
      revokedBy: pin.revokedBy ?? null,
      revocationReason: pin.revocationReason ?? null,
      createdAt: pin.createdAt.toISOString(),
      updatedAt: pin.updatedAt.toISOString(),
    };
  }
}
