import { Injectable, Logger } from "@nestjs/common";
import { createHmac } from "crypto";
import { sha256 } from "../common/crypto/hash";
import { PrismaService } from "../database/prisma.service";
import {
  CreateSecretRetrievalReceiptInput,
  SecretRetrievalReceiptDto,
  DeliveryChannel,
  ReceiptStatus,
} from "./types/secret-retrieval-receipt.types";

/**
 * Service for managing secret retrieval receipts.
 *
 * A receipt is immutable evidence that a one-time secret (API key, webhook signing secret,
 * or export token) was revealed to a user/client at a specific time.
 *
 * Design principles:
 * 1. Receipts are created atomically in the same transaction as secret creation.
 * 2. The acknowledgement hash is deterministic: SHA-256(resourceId | secretType | revealedAt | orgSalt).
 *    - This hash cannot be reversed to recover the secret.
 *    - The org salt is derived from organizationId using HMAC, never stored.
 * 3. Receipts are immutable once created (no updates except status/metadata).
 * 4. Replay prevention: unique constraint on (organizationId, resourceId, secretType, revealedAt).
 * 5. Expiry enforcement: receipts become EXPIRED when expiresAt <= now.
 */
@Injectable()
export class SecretRetrievalReceiptService {
  private readonly logger = new Logger(SecretRetrievalReceiptService.name);

  /** Label for deriving the org-specific salt. */
  private readonly SALT_LABEL = "secret-retrieval-receipt-salt-v1";

  /** Default receipt TTL: 1 year (in milliseconds). */
  private readonly DEFAULT_RECEIPT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Derive the organization-specific salt for acknowledgement hash computation.
   *
   * Salt = HMAC-SHA256(organizationId, SALT_LABEL)
   *
   * This ensures:
   * - The salt is deterministic (same org always produces same salt).
   * - The salt is non-reversible (cannot derive organizationId from salt).
   * - The salt makes the acknowledgement hash meaningless outside this system.
   *
   * @param organizationId - The organization ID
   * @returns The hex-encoded salt (32 bytes = 64 hex chars)
   */
  private deriveOrgSalt(organizationId: string): string {
    return createHmac("sha256", this.SALT_LABEL)
      .update(organizationId, "utf8")
      .digest("hex");
  }

  /**
   * Compute the acknowledgement hash for a receipt.
   *
   * Hash = SHA-256(resourceId | "|" | secretType | "|" | revealedAt.toISOString() | "|" | orgSalt)
   *
   * The hash is deterministic and serves as evidence of revelation without leaking secret material.
   * It includes the resource identifier, secret type, and exact timestamp to prevent:
   * - Confusion between different secrets revealed at different times.
   * - Post-hoc creation of false receipt entries (timestamp is immutable).
   *
   * @param organizationId - Organization ID (for deriving salt)
   * @param resourceId - Resource identifier
   * @param secretType - Type of secret
   * @param revealedAt - Timestamp when secret was revealed
   * @returns The hex-encoded acknowledgement hash (64 hex chars)
   */
  computeAcknowledgementHash(
    organizationId: string,
    resourceId: string,
    secretType: string,
    revealedAt: Date,
  ): string {
    const salt = this.deriveOrgSalt(organizationId);
    const input = `${resourceId}|${secretType}|${revealedAt.toISOString()}|${salt}`;
    return sha256(input);
  }

  /**
   * Check if a receipt has expired.
   *
   * A receipt is expired if:
   * - status is EXPIRED, or
   * - expiresAt is set and <= now (expired by time)
   *
   * @param receipt - The receipt to check
   * @returns true if expired, false otherwise
   */
  isExpired(receipt: {
    status?: string;
    expiresAt?: Date | null;
  }): boolean {
    if (receipt.status === ReceiptStatus.EXPIRED) {
      return true;
    }
    if (receipt.expiresAt && new Date() >= receipt.expiresAt) {
      return true;
    }
    return false;
  }

  /**
   * Create a secret retrieval receipt.
   *
   * Receipt creation is typically called within the same transaction as the secret creation,
   * ensuring atomic success/failure. If the secret creation fails, the receipt is never created.
   *
   * @param input - Receipt creation input
   * @param tx - Optional Prisma transaction context (for atomic operations)
   * @returns The created receipt DTO
   * @throws PrismaClientKnownRequestError if unique constraint violated (duplicate receipt)
   */
  async create(
    input: CreateSecretRetrievalReceiptInput,
    tx?: any,
  ): Promise<SecretRetrievalReceiptDto> {
    const prismaClient = tx || this.prisma;

    const acknowledgementHash = this.computeAcknowledgementHash(
      input.organizationId,
      input.resourceId,
      input.secretType,
      input.revealedAt,
    );

    // Default expiry: 1 year from now
    const expiresAt = input.expiresAt ?? new Date(Date.now() + this.DEFAULT_RECEIPT_TTL_MS);

    // Compute hash of receipt state (for audit chain compatibility)
    const receiptStateHash = this.computeReceiptHash({
      organizationId: input.organizationId,
      secretType: input.secretType,
      resourceId: input.resourceId,
      resourceReference: input.resourceReference,
      recipientId: input.recipientId,
      deliveryChannel: input.deliveryChannel ?? DeliveryChannel.HTTP_RESPONSE,
      revealedAt: input.revealedAt,
      acknowledgementHash,
      status: ReceiptStatus.ACTIVE,
      expiresAt,
      metadata: input.metadata ?? {},
    });

    const receipt = await prismaClient.secretRetrievalReceipt.create({
      data: {
        organizationId: input.organizationId,
        secretType: input.secretType,
        resourceId: input.resourceId,
        resourceReference: input.resourceReference ?? null,
        recipientId: input.recipientId ?? null,
        deliveryChannel: input.deliveryChannel ?? DeliveryChannel.HTTP_RESPONSE,
        revealedAt: input.revealedAt,
        acknowledgementHash,
        status: ReceiptStatus.ACTIVE,
        expiresAt,
        metadata: input.metadata ?? {},
        hash: receiptStateHash,
        hashVersion: 1,
        prevHash: null,
      },
    });

    return this.toDto(receipt);
  }

  /**
   * Mark a receipt as expired.
   *
   * Used when the underlying secret is consumed (e.g., export token redeemed)
   * or explicitly revoked. Receipts are otherwise immutable.
   *
   * @param receiptId - The receipt ID to expire
   * @throws NotFoundException if receipt not found
   */
  async expire(receiptId: string): Promise<SecretRetrievalReceiptDto> {
    const receipt = await this.prisma.secretRetrievalReceipt.update({
      where: { id: receiptId },
      data: {
        status: ReceiptStatus.EXPIRED,
        updatedAt: new Date(),
      },
    });
    return this.toDto(receipt);
  }

  /**
   * Find receipts for an organization matching the given criteria.
   *
   * @param organizationId - Organization to query
   * @param options - Filter options
   * @returns List of matching receipts
   */
  async findByOrganization(
    organizationId: string,
    options?: {
      secretType?: string;
      resourceId?: string;
      status?: string;
      limit?: number;
    },
  ): Promise<SecretRetrievalReceiptDto[]> {
    const receipts = await this.prisma.secretRetrievalReceipt.findMany({
      where: {
        organizationId,
        secretType: options?.secretType,
        resourceId: options?.resourceId,
        status: options?.status,
      },
      orderBy: { revealedAt: "desc" },
      take: options?.limit ?? 100,
    });

    return receipts.map((r) => this.toDto(r));
  }

  /**
   * Find a single receipt by ID.
   *
   * @param receiptId - Receipt ID to find
   * @returns The receipt DTO, or null if not found
   */
  async findById(receiptId: string): Promise<SecretRetrievalReceiptDto | null> {
    const receipt = await this.prisma.secretRetrievalReceipt.findUnique({
      where: { id: receiptId },
    });
    return receipt ? this.toDto(receipt) : null;
  }

  /**
   * Compute the hash of a receipt state (for audit chain).
   *
   * Hash = SHA-256(JSON stringified state)
   *
   * @param state - Receipt state object
   * @returns The hex-encoded hash
   */
  private computeReceiptHash(state: Record<string, unknown>): string {
    const stateString = JSON.stringify(state, Object.keys(state).sort());
    return sha256(stateString);
  }

  /**
   * Convert a Prisma model to a DTO.
   */
  private toDto(receipt: any): SecretRetrievalReceiptDto {
    return {
      id: receipt.id,
      organizationId: receipt.organizationId,
      secretType: receipt.secretType,
      resourceId: receipt.resourceId,
      resourceReference: receipt.resourceReference,
      recipientId: receipt.recipientId,
      deliveryChannel: receipt.deliveryChannel,
      revealedAt: receipt.revealedAt,
      acknowledgementHash: receipt.acknowledgementHash,
      status: receipt.status,
      expiresAt: receipt.expiresAt,
      metadata: receipt.metadata,
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
    };
  }
}
