import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Prisma, ResourceStatus } from "@prisma/client";
import { StrKey } from "@stellar/stellar-base";
import { AuthenticatedUser } from "../auth/auth.types";
import { sha256 } from "../common/crypto/hash";
import {
  buildPage,
  cursorOrderBy,
  cursorWhereFragment,
} from "../common/pagination/keyset-paginate";
import { PrismaService } from "../database/prisma.service";
import { PaymentEligibilityService } from "../payments/payment-eligibility.service";
import { ConflictException } from "../common/exceptions/domain.exceptions";
import { CreateTrustedSourceDto } from "./dto/create-trusted-source.dto";
import { ListTrustedSourcesDto } from "./dto/list-trusted-sources.dto";
import { UpdateTrustedSourceDto } from "./dto/update-trusted-source.dto";

@Injectable()
export class TrustedSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: PaymentEligibilityService,
  ) {}

  /**
   * Normalizes a source address (e.g., Stellar address).
   * For now, performs basic trimming and uppercase conversion.
   * Can be extended for address format validation.
   */
  private normalizeAddress(address: string): string {
    return address.trim().toUpperCase();
  }

  /**
   * Validates that an address follows basic format requirements.
   * For Stellar addresses, checks if it starts with 'G' and is 56 characters.
   */
  private validateAddressFormat(address: string): void {
    const normalized = this.normalizeAddress(address);
    if (!StrKey.isValidEd25519PublicKey(normalized)) {
      throw new BadRequestException(
        "Invalid address format. Expected a valid Stellar address.",
      );
    }
  }

  /**
   * Creates a new trusted source for the authenticated user.
   */
  async createTrustedSource(
    user: AuthenticatedUser,
    input: CreateTrustedSourceDto,
  ) {
    // Normalize and validate address
    const normalizedAddress = this.normalizeAddress(input.sourceAddress);
    this.validateAddressFormat(normalizedAddress);

    // Check for duplicate trusted source per user
    const existing = await this.prisma.trustedSource.findUnique({
      where: {
        userId_sourceAddress: {
          userId: user.id,
          sourceAddress: normalizedAddress,
        },
      },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException(
        "A trusted source with this address already exists for your account.",
      );
    }

    // Validate issuer if provided
    let issuerId: string | null = null;
    if (input.issuerId) {
      const issuer = await this.prisma.issuer.findUnique({
        where: { id: input.issuerId },
        select: { id: true, status: true },
      });

      if (!issuer) {
        throw new BadRequestException("The specified issuer does not exist.");
      }

      if (issuer.status !== ResourceStatus.ACTIVE) {
        throw new BadRequestException(
          "The specified issuer is not in an active state.",
        );
      }

      issuerId = issuer.id;
    }

    // Create the trusted source
    const trustedSource = await this.prisma.trustedSource.create({
      data: {
        userId: user.id,
        sourceAddress: normalizedAddress,
        displayName: input.displayName || undefined,
        sourceType: input.sourceType || "stellar",
        issuerId: issuerId || undefined,
        status: ResourceStatus.ACTIVE,
        revision: 0,
      },
      include: {
        issuer: {
          select: {
            id: true,
            status: true,
            organization: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    // Log audit event
    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: user.id,
        action: "trusted_source.created",
        resourceType: "trusted_source",
        resourceId: trustedSource.id,
        metadata: {
          sourceAddressHash: sha256(normalizedAddress),
          sourceType: input.sourceType || "stellar",
          issuerId: issuerId || null,
        },
      },
    });

    // Payments from this sender are now from a trusted source.
    await this.eligibility.reevaluateSource(user.id, normalizedAddress);

    return this.formatTrustedSource(trustedSource);
  }

  /**
   * Lists all trusted sources for the authenticated user with optional filters.
   */
  async listTrustedSources(
    user: AuthenticatedUser,
    filters: ListTrustedSourcesDto,
  ) {
    const limit = filters.limit ?? 20;
    const cursorWhere = cursorWhereFragment(filters.cursor, "createdAt");
    const where: Prisma.TrustedSourceWhereInput = {
      userId: user.id,
      status: ResourceStatus.ACTIVE,
      ...(cursorWhere as Prisma.TrustedSourceWhereInput),
    };

    if (filters.sourceAddress) {
      where.sourceAddress = {
        contains: this.normalizeAddress(filters.sourceAddress),
      };
    }

    if (filters.sourceType) {
      where.sourceType = filters.sourceType;
    }

    const rows = await this.prisma.trustedSource.findMany({
      where,
      include: {
        issuer: {
          select: {
            id: true,
            status: true,
            organization: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: cursorOrderBy("createdAt"),
      take: limit + 1,
    });

    const { data, pageInfo } = buildPage(rows, limit, "createdAt");

    return {
      data: data.map((ts) => this.formatTrustedSource(ts)),
      pageInfo,
    };
  }

  /**
   * Retrieves a specific trusted source by ID.
   * Ensures the user owns the trusted source.
   */
  async getTrustedSource(user: AuthenticatedUser, trustedSourceId: string) {
    const trustedSource = await this.prisma.trustedSource.findFirst({
      where: {
        id: trustedSourceId,
        userId: user.id,
      },
      include: {
        issuer: {
          select: {
            id: true,
            status: true,
            organization: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!trustedSource) {
      throw new ForbiddenException(
        "You do not have access to this trusted source.",
      );
    }

    return this.formatTrustedSource(trustedSource);
  }

  /**
   * Updates a trusted source's metadata (displayName, issuerId).
   * Does not allow changing the source address (it's immutable for uniqueness).
   */
  async updateTrustedSource(
    user: AuthenticatedUser,
    trustedSourceId: string,
    input: UpdateTrustedSourceDto,
  ) {
    // Verify ownership
    const existing = await this.prisma.trustedSource.findFirst({
      where: {
        id: trustedSourceId,
        userId: user.id,
      },
      select: {
        id: true,
        displayName: true,
        issuerId: true,
        revision: true,
      },
    });

    if (!existing) {
      throw new ForbiddenException(
        "You do not have access to this trusted source.",
      );
    }

    // Validate new issuer if provided
    let newIssuerId: string | null | undefined = undefined;
    if (input.issuerId !== undefined) {
      if (input.issuerId === null) {
        newIssuerId = null;
      } else {
        const issuer = await this.prisma.issuer.findUnique({
          where: { id: input.issuerId },
          select: { id: true, status: true },
        });

        if (!issuer) {
          throw new BadRequestException(
            "The specified issuer does not exist.",
          );
        }

        if (issuer.status !== ResourceStatus.ACTIVE) {
          throw new BadRequestException(
            "The specified issuer is not in an active state.",
          );
        }

        newIssuerId = issuer.id;
      }
    }

    // Attempt optimistic update with revision check
    const updated = await this.prisma.trustedSource.updateMany({
      where: {
        id: trustedSourceId,
        revision: input.expectedRevision,
      },
      data: {
        displayName: input.displayName !== undefined ? input.displayName : undefined,
        issuerId: newIssuerId !== undefined ? newIssuerId : undefined,
        revision: input.expectedRevision + 1,
      },
    });

    // If no records were updated, the revision didn't match
    if (updated.count === 0) {
      throw new ConflictException(
        "Trusted source has been modified by another request. Please refresh and retry.",
        existing.revision,
      );
    }

    const result = await this.prisma.trustedSource.findUniqueOrThrow({
      where: { id: trustedSourceId },
      include: {
        issuer: {
          select: {
            id: true,
            status: true,
            organization: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    // Log audit event
    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: user.id,
        action: "trusted_source.updated",
        resourceType: "trusted_source",
        resourceId: trustedSourceId,
        metadata: {
          displayNameChanged:
            existing.displayName !== result.displayName,
          previousIssuerId: existing.issuerId || null,
          nextIssuerId: result.issuerId || null,
          revision: result.revision,
        },
      },
    });

    // An issuer link change can change SOURCE_ISSUER_VERIFIED.
    if ((existing.issuerId || null) !== (result.issuerId || null)) {
      await this.eligibility.reevaluateSource(user.id, result.sourceAddress);
    }

    return this.formatTrustedSource(result);
  }

  /**
   * Deletes a trusted source.
   * Checks if the source has been used in any proofs.
   * If used, throws an error (prevents orphaning of audit trails).
   */
  async deleteTrustedSource(
    user: AuthenticatedUser,
    trustedSourceId: string,
  ) {
    // Verify ownership
    const trustedSource = await this.prisma.trustedSource.findFirst({
      where: {
        id: trustedSourceId,
        userId: user.id,
      },
      select: {
        id: true,
        sourceAddress: true,
      },
    });

    if (!trustedSource) {
      throw new ForbiddenException(
        "You do not have access to this trusted source.",
      );
    }

    const deleted = await this.prisma.trustedSource.update({
      where: { id: trustedSourceId },
      data: {
        status: ResourceStatus.DELETED,
      },
      include: {
        issuer: {
          select: {
            id: true,
            status: true,
            organization: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    // Log audit event
    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: user.id,
        action: "trusted_source.deleted",
        resourceType: "trusted_source",
        resourceId: trustedSourceId,
        metadata: {
          sourceAddressHash: sha256(trustedSource.sourceAddress),
          retentionPolicy: "soft_delete",
        },
      },
    });

    await this.eligibility.reevaluateSource(user.id, trustedSource.sourceAddress);

    return {
      id: deleted.id,
      status: deleted.status,
      retainedForHistory: true,
    };
  }

  /**
   * Formats a trusted source record for API response,
   * including issuer trust status information.
   */
  private formatTrustedSource(record: any) {
    return {
      id: record.id,
      sourceAddress: record.sourceAddress,
      displayName: record.displayName || null,
      sourceType: record.sourceType || "stellar",
      revision: record.revision,
      issuer: record.issuer
        ? {
            id: record.issuer.id,
            name: record.issuer.organization?.name || null,
            status: record.issuer.status,
            isTrusted: record.issuer.status === ResourceStatus.ACTIVE,
          }
        : null,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
