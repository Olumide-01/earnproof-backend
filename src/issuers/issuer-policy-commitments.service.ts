import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Issuer, IssuerPolicyCommitment, ResourceStatus } from "@prisma/client";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { PrismaService } from "../database/prisma.service";

/**
 * Policy commitment snapshot: immutable record of issuer state at a point in time.
 * Used for deterministic proof verification even after issuer policies change.
 */
export interface IssuerPolicySnapshotInput {
  signingKeyVersionId: string;
  stellarAddress: string;
  publicMetadata?: Record<string, unknown> | null;
  status: ResourceStatus;
}

/**
 * Response DTO for issuer policy commitments.
 */
export interface IssuerPolicyCommitmentDto {
  id: string;
  issuerId: string;
  version: number;
  commitment: string;
  policyInputsHash: string;
  policySnapshot: unknown;
  effectiveAt: Date;
  supersededAt: Date | null;
  correlationId: string | null;
  createdAt: Date;
}

/**
 * Service for managing issuer policy commitment history (#307).
 *
 * Responsibilities:
 * - Track versioned issuer policies with deterministic commitment hashes
 * - Ensure monotonic version numbering (prevents regression attacks)
 * - Enable bounded historical queries for proof verification
 * - Maintain immutable audit trail of policy changes
 *
 * Pattern: Similar to SupportedAsset → assetPolicySnapshot.
 * Each policy change creates a new IssuerPolicyCommitment row.
 * Proofs reference commitments by ID, enabling offline verification.
 */
@Injectable()
export class IssuerPolicyCommitmentsService {
  private readonly logger = new Logger(IssuerPolicyCommitmentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Capture or reuse an issuer policy commitment.
   *
   * If the policy inputs match the current commitment, returns the existing one.
   * Otherwise, creates a new version with a higher version number.
   *
   * Guarantees:
   * - Version numbers are monotonically increasing per issuer
   * - Identical policies produce identical commitment hashes (deterministic)
   * - No version gaps (unique(issuerId, version) constraint)
   * - Commitment hashes are globally unique
   *
   * @param issuerId Issuer to capture policy for
   * @param policySnapshot Current issuer state
   * @param correlationId Optional audit trail linkage
   * @returns Newly created or existing commitment
   * @throws On concurrent version conflicts (rare; retry is safe)
   */
  async captureOrReuse(
    issuerId: string,
    policySnapshot: IssuerPolicySnapshotInput,
    correlationId?: string,
  ): Promise<IssuerPolicyCommitment> {
    // Compute deterministic commitment hash
    const canonical = canonicalize(policySnapshot);
    const policyInputsHash = `sha256:${sha256(canonical)}`;
    const commitment = `sha256:${sha256(policyInputsHash)}`;

    // Try to return existing commitment if hash matches
    const existing = await this.prisma.issuerPolicyCommitment.findFirst({
      where: {
        issuerId,
        commitment,
        supersededAt: null,  // Only consider active commitments
      },
    });

    if (existing) {
      this.logger.debug(
        `Reusing issuer policy commitment ${existing.id} for issuer ${issuerId}`,
      );
      return existing;
    }

    // No matching commitment found; create a new version
    // Must atomically fetch current version and increment it
    return this.createNewCommitment(
      issuerId,
      policySnapshot,
      commitment,
      policyInputsHash,
      correlationId,
    );
  }

  /**
   * Create a new issuer policy commitment with the next version number.
   *
   * Atomically:
   * 1. Fetch current max version for issuer
   * 2. Increment version
   * 3. Create new commitment
   *
   * Prevents version gaps and concurrent overwrites via database constraints.
   */
  private async createNewCommitment(
    issuerId: string,
    policySnapshot: IssuerPolicySnapshotInput,
    commitment: string,
    policyInputsHash: string,
    correlationId?: string,
  ): Promise<IssuerPolicyCommitment> {
    return this.prisma.$transaction(async (tx) => {
      // Get the current max version for this issuer (fetch-and-increment pattern)
      const currentMax = await tx.issuerPolicyCommitment.findFirst({
        where: { issuerId },
        orderBy: { version: "desc" },
        select: { version: true },
      });

      const nextVersion = (currentMax?.version ?? 0) + 1;

      // Supersede the previous commitment if it exists
      if (currentMax) {
        await tx.issuerPolicyCommitment.updateMany({
          where: {
            issuerId,
            version: currentMax.version,
            supersededAt: null,
          },
          data: {
            supersededAt: new Date(),
          },
        });
      }

      // Create the new commitment
      const created = await tx.issuerPolicyCommitment.create({
        data: {
          issuerId,
          version: nextVersion,
          commitment,
          policyInputsHash,
          policySnapshot,
          effectiveAt: new Date(),
          supersededAt: null,
          correlationId,
        },
      });

      this.logger.debug(
        `Created issuer policy commitment ${created.id} (v${nextVersion}) for issuer ${issuerId}`,
      );

      return created;
    });
  }

  /**
   * Get the current active policy commitment for an issuer.
   *
   * Returns the commitment with the highest version number where supersededAt is null.
   *
   * @param issuerId Issuer to fetch commitment for
   * @returns Current commitment, or throws if none exists
   */
  async getCurrentCommitment(issuerId: string): Promise<IssuerPolicyCommitment> {
    const commitment = await this.prisma.issuerPolicyCommitment.findFirst({
      where: {
        issuerId,
        supersededAt: null,
      },
      orderBy: { version: "desc" },
    });

    if (!commitment) {
      throw new NotFoundException(
        `No active policy commitment found for issuer ${issuerId}`,
      );
    }

    return commitment;
  }

  /**
   * Get a specific commitment by ID.
   *
   * Used for offline proof verification: fetch the exact policy state
   * the proof was issued under.
   *
   * @param commitmentId Commitment ID
   * @returns Commitment details
   */
  async getCommitmentById(commitmentId: string): Promise<IssuerPolicyCommitment> {
    const commitment = await this.prisma.issuerPolicyCommitment.findUnique({
      where: { id: commitmentId },
    });

    if (!commitment) {
      throw new NotFoundException(`Commitment ${commitmentId} not found`);
    }

    return commitment;
  }

  /**
   * Get the commitment that was active at a specific point in time.
   *
   * Useful for historical verification: "What was the policy when this proof was issued?"
   *
   * @param issuerId Issuer to query
   * @param timestamp Point-in-time query
   * @returns Commitment effective at that time, or throws if none
   */
  async getCommitmentAt(
    issuerId: string,
    timestamp: Date,
  ): Promise<IssuerPolicyCommitment> {
    const commitment = await this.prisma.issuerPolicyCommitment.findFirst({
      where: {
        issuerId,
        effectiveAt: { lte: timestamp },
        OR: [
          { supersededAt: null },
          { supersededAt: { gt: timestamp } },
        ],
      },
      orderBy: { version: "desc" },
    });

    if (!commitment) {
      throw new NotFoundException(
        `No policy commitment found for issuer ${issuerId} at ${timestamp.toISOString()}`,
      );
    }

    return commitment;
  }

  /**
   * List all policy commitment versions for an issuer.
   *
   * Returns all versions in reverse chronological order (newest first).
   * Useful for audit and administrative dashboards.
   *
   * @param issuerId Issuer to list commitments for
   * @param limit Number of results (default: 50, max: 1000)
   * @param offset Pagination offset (default: 0)
   * @returns Paginated list of commitments
   */
  async listCommitments(
    issuerId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<{
    items: IssuerPolicyCommitmentDto[];
    total: number;
    hasMore: boolean;
  }> {
    // Clamp limit to reasonable bounds
    const clampedLimit = Math.min(Math.max(limit, 1), 1000);

    // Verify issuer exists
    const issuer = await this.prisma.issuer.findUnique({
      where: { id: issuerId },
      select: { id: true },
    });

    if (!issuer) {
      throw new NotFoundException(`Issuer ${issuerId} not found`);
    }

    const [items, total] = await Promise.all([
      this.prisma.issuerPolicyCommitment.findMany({
        where: { issuerId },
        orderBy: { version: "desc" },
        skip: offset,
        take: clampedLimit + 1,  // Fetch one extra to detect hasMore
      }),
      this.prisma.issuerPolicyCommitment.count({
        where: { issuerId },
      }),
    ]);

    const hasMore = items.length > clampedLimit;
    const displayItems = items.slice(0, clampedLimit);

    return {
      items: displayItems.map((c) => this.toDto(c)),
      total,
      hasMore,
    };
  }

  /**
   * Verify authorization to read an issuer's policy commitments.
   *
   * Currently: organization members can read their organization's issuers.
   * Can be extended for API keys, public read (with redaction), etc.
   *
   * @param issuerId Issuer to check
   * @param organizationId Organization context
   * @throws ForbiddenException if not authorized
   */
  async assertCanReadCommitments(issuerId: string, organizationId: string): Promise<void> {
    const issuer = await this.prisma.issuer.findUnique({
      where: { id: issuerId },
      select: { organizationId: true },
    });

    if (!issuer) {
      throw new NotFoundException(`Issuer ${issuerId} not found`);
    }

    if (issuer.organizationId !== organizationId) {
      throw new ForbiddenException(
        `You do not have access to issuer ${issuerId}`,
      );
    }
  }

  /**
   * Convert commitment row to DTO for API responses.
   */
  private toDto(commitment: IssuerPolicyCommitment): IssuerPolicyCommitmentDto {
    return {
      id: commitment.id,
      issuerId: commitment.issuerId,
      version: commitment.version,
      commitment: commitment.commitment,
      policyInputsHash: commitment.policyInputsHash,
      policySnapshot: commitment.policySnapshot,
      effectiveAt: commitment.effectiveAt,
      supersededAt: commitment.supersededAt,
      correlationId: commitment.correlationId,
      createdAt: commitment.createdAt,
    };
  }
}
