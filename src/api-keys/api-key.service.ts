import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ApiKeyScope, ResourceStatus } from "@prisma/client";
import { randomBytes, timingSafeEqual } from "crypto";
import { sha256 } from "../common/crypto/hash";
import {
  buildPage,
  cursorOrderBy,
  cursorWhereFragment,
} from "../common/pagination/keyset-paginate";
import { PrismaService } from "../database/prisma.service";
import { OrganizationQuotaService } from "../quotas/organization-quota.service";
import { ApiKeyUsageService } from "./api-key-usage.service";
import { SecretRetrievalReceiptService } from "../audit/secret-retrieval-receipt.service";
import { SecretType, DeliveryChannel } from "../audit/types/secret-retrieval-receipt.types";

/**
 * API Key Service - Secure credential management for machine-to-machine integrations.
 *
 * See original file for full design rationale. Changes in this version:
 * - Injects ApiKeyUsageService to call freezeOnRevocation() during revokeKey().
 * - recordKeyUsage() is kept for backward compatibility; new code should use
 *   ApiKeyUsageService.recordUsage() directly (via the guard).
 * SECURITY POSTURE: This service implements constant-time verification to prevent timing attacks
 * on secret authentication. See verifySecret() for detailed constant-time design.
 *
 * Design decisions:
 *
 * 1. Hashing algorithm: SHA-256 (fast cryptographic hash, not bcrypt)
 *    - API keys are high-entropy random secrets (32 bytes), not weak human passwords
 *    - SHA-256 is the standard for API key hashing in industry (e.g., GitHub, Stripe)
 *    - bcrypt's slow-hash design is for defending against brute-force on weak passwords
 *    - Against brute-force on high-entropy random secrets, SHA-256 + salt is sufficient
 *    - This codebase already uses SHA-256 for other credentials (proof hashes, wallet hashes)
 *    - Reasoning: consistent with existing patterns, appropriate for threat model
 *
 * 2. Key format: 32 bytes (256 bits) of randomness, base64url-encoded
 *    - Yields ~43 characters when encoded
 *    - Prefix: first 8 characters (32 bits of entropy for human recognition)
 *    - Sufficient entropy for cryptographic security
 *
 * 3. Secret display: returned ONCE on creation/rotation, never stored/retrievable
 *    - API key lifecycle: generate → hash → store hash+prefix → display secret once → never again
 *    - No code path can reconstruct or re-display the raw secret
 *
 * 4. Organization isolation: enforced at query level, not surface-level checks
 *    - Every lookup includes organizationId filter
 *    - Cannot list/rotate/revoke another org's keys even with valid token
 *
 * 5. Audit logging: records administrative actions (create, rotate, revoke, use)
 *    - Never logs raw secrets or hashes
 *    - Logs only non-sensitive identifiers: keyId, prefix, organizationId, actor
 *    - Timestamps and action types for complete audit trail
 *
 * 6. Constant-time verification: prevents timing side-channel attacks
 *    - All verification attempts follow identical code paths regardless of input format
 *    - Format validation does not short-circuit before cryptographic comparison
 *    - See verifySecret() for implementation details
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);
  private readonly KEY_BYTES = 32;

  constructor(
    private readonly prisma: PrismaService,
    private readonly quotas: OrganizationQuotaService,
    private readonly apiKeyUsageService: ApiKeyUsageService,
    private readonly secretRetrievalReceiptService: SecretRetrievalReceiptService,
  ) {}

  generateSecret(): { secret: string; prefix: string } {
    const randomBytes32 = randomBytes(this.KEY_BYTES);
    const secret = randomBytes32.toString("base64url");
    const prefix = secret.substring(0, 8);
    return { secret, prefix };
  }

  hashSecret(secret: string): string {
    return sha256(secret);
  }

  /**
   * Verify a presented secret against a stored hash.
   * Returns true if they match (constant-time comparison).
   *
   * SECURITY: This method is designed to execute in constant time regardless of:
   *   - Whether storedHash is correctly formatted
   *   - Whether storedHash matches the computed hash
   *   - Input lengths or validity
   *
   * Timing attacks exploit variable execution time to infer information about
   * secrets or hash formats. This implementation prevents timing leakage by:
   *   1. Computing the hash of the presented secret (unavoidable baseline work)
   *   2. Performing format validation in constant time (not regex, which short-circuits)
   *   3. Always attempting decoding and comparison regardless of format validity
   *   4. Using a dummy buffer if decoding fails (ensures same execution path)
   *   5. Using timingSafeEqual for the final comparison (Node.js crypto primitive)
   *
   * Malformed inputs (invalid hex, wrong length, etc.) follow the same codepath
   * as valid-format inputs, ensuring no timing distinction.
   *
   * @param secret - Presented secret from client
   * @param storedHash - Stored hash from database (expected: 64 hex chars)
   * @returns true if secret hashes to storedHash, false otherwise
   */
  verifySecret(secret: string, storedHash: string): boolean {
    const computedHash = this.hashSecret(secret);
    const computedBuffer = Buffer.from(computedHash, "hex");

    // Constant-time format validation: check length and character validity
    // without short-circuiting. SHA-256 hashes are exactly 64 hex characters.
    const EXPECTED_HEX_LENGTH = 64;
    let isValidFormat = true;

    // Check length in constant time
    if (storedHash.length !== EXPECTED_HEX_LENGTH) {
      isValidFormat = false;
    }

    // Check each character is valid hex [a-fA-F0-9] in constant time
    // Do NOT use early returns or short-circuit logic
    for (let i = 0; i < EXPECTED_HEX_LENGTH; i++) {
      const char = storedHash.charCodeAt(i);
      // Check if char is 0-9 (48-57), a-f (97-102), or A-F (65-70)
      const isDigit = char >= 48 && char <= 57;
      const isLowerHex = char >= 97 && char <= 102;
      const isUpperHex = char >= 65 && char <= 70;
      if (!(isDigit || isLowerHex || isUpperHex)) {
        isValidFormat = false;
      }
    }

    // Decode hex to buffer, using dummy if format is invalid
    // This ensures all inputs follow the same comparison path
    let storedBuffer: Buffer;
    try {
      // Buffer.from() with 'hex' encoding will throw if the string contains
      // invalid hex characters or has odd length. We catch and use dummy.
      storedBuffer = Buffer.from(storedHash, "hex");
      // Additional safety: verify the decoded buffer is the correct length
      if (storedBuffer.length !== 32) {
        // Not 32 bytes (256 bits), which SHA-256 always produces
        storedBuffer = Buffer.alloc(32);
      }
    } catch {
      // Decoding failed: use dummy buffer of correct length (32 bytes)
      // This ensures timing is identical whether parsing succeeds or fails
      storedBuffer = Buffer.alloc(32);
    }

    // Compare in constant time using Node.js crypto primitive
    try {
      return timingSafeEqual(computedBuffer, storedBuffer);
    } catch {
      // timingSafeEqual only throws if buffer lengths differ.
      // This should not occur given our allocation strategy, but guard anyway.
      return false;
    }
  }

  async lookupAndVerifyKey(prefix: string, secret: string, organizationId: string) {
    const apiKey = await this.prisma.apiKey.findFirst({
      where: {
        prefix,
        organizationId,
        status: ResourceStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        // An archived or deleted organization's keys stop authenticating the
        // moment it is archived; they start again only if it is restored.
        organization: { archivedAt: null },
      },
      include: {
        scopeAssignments: { select: { scope: true } },
        organization: { select: { id: true, slug: true } },
      },
    });

    if (!apiKey) return null;
    const isValid = this.verifySecret(secret, apiKey.keyHash);
    if (!isValid) return null;
    return apiKey;
  }

  async createKey(input: {
    organizationId: string;
    createdBy: string;
    name: string;
    scopes?: ApiKeyScope[];
    expiresAt?: Date;
  }) {
    const { secret, prefix } = this.generateSecret();
    const keyHash = this.hashSecret(secret);

    // Quota check, creation, receipt, and audit commit together atomically
    const apiKey = await this.prisma.$transaction(async (tx) => {
      await this.quotas.assertCapacity(tx, input.organizationId, "api_keys");

      const created = await tx.apiKey.create({
        data: {
          organizationId: input.organizationId,
          createdById: input.createdBy,
          name: input.name,
          prefix,
          keyHash,
          expiresAt: input.expiresAt,
          scopeAssignments: input.scopes
            ? {
                createMany: {
                  data: input.scopes.map((scope) => ({ scope })),
                },
              }
            : undefined,
        },
        include: {
          scopeAssignments: {
            select: {
              scope: true,
            },
          },
        },
      });

      // Create receipt: immutable evidence that secret was revealed
      const receipt = await this.secretRetrievalReceiptService.create(
        {
          organizationId: input.organizationId,
          secretType: SecretType.API_KEY,
          resourceId: created.id,
          resourceReference: created.prefix,
          recipientId: input.createdBy,
          deliveryChannel: DeliveryChannel.HTTP_RESPONSE,
          revealedAt: new Date(),
          expiresAt: created.expiresAt, // receipt expires when key expires
        },
        tx,
      );

      // Audit log: API key created (never log secret or hash)
      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId: input.createdBy,
          action: "api_key.created",
          resourceType: "api_key",
          resourceId: created.id,
          metadata: {
            prefix: created.prefix,
            name: created.name,
            organizationId: created.organizationId,
            scopes: created.scopeAssignments.map((sa) => sa.scope),
          },
        },
      });

      return created;
    });

    return {
      secret,
      apiKey: {
        id: apiKey.id,
        prefix: apiKey.prefix,
        name: apiKey.name,
        status: apiKey.status,
        scopes: apiKey.scopeAssignments.map((sa) => sa.scope),
        createdAt: apiKey.createdAt,
        expiresAt: apiKey.expiresAt,
      },
    };
  }

  async rotateKey(keyId: string, organizationId: string, actorId?: string) {
    const { secret, prefix } = this.generateSecret();
    const keyHash = this.hashSecret(secret);

    // Transaction for atomic key rotation and receipt creation
    const apiKey = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.apiKey.update({
        where: { id: keyId, organizationId },
        data: { prefix, keyHash, rotatedAt: new Date() },
        include: { scopeAssignments: { select: { scope: true } } },
      });

      if (updated.organizationId !== organizationId) {
        throw new ForbiddenException("Key does not belong to this organization");
      }

      // Create receipt: immutable evidence that new secret was revealed
      const receipt = await this.secretRetrievalReceiptService.create(
        {
          organizationId: updated.organizationId,
          secretType: SecretType.API_KEY,
          resourceId: updated.id,
          resourceReference: updated.prefix,
          recipientId: actorId ?? undefined,
          deliveryChannel: DeliveryChannel.HTTP_RESPONSE,
          revealedAt: new Date(),
          expiresAt: updated.expiresAt, // receipt expires when key expires
        },
        tx,
      );

      // Audit log: API key rotated (never log secret or hash)
      await tx.auditLog.create({
        data: {
          actorType: "user",
          actorId: actorId ?? null,
          action: "api_key.rotated",
          resourceType: "api_key",
          resourceId: updated.id,
          metadata: {
            prefix: updated.prefix,
            organizationId: updated.organizationId,
            rotatedAt: updated.rotatedAt?.toISOString(),
            receiptId: receipt.id,
          },
        },
      });

      return updated;
    });

    return {
      secret,
      apiKey: {
        id: apiKey.id,
        prefix: apiKey.prefix,
        name: apiKey.name,
        status: apiKey.status,
        scopes: apiKey.scopeAssignments.map((sa) => sa.scope),
        rotatedAt: apiKey.rotatedAt,
      },
    };
  }

  async revokeKey(keyId: string, organizationId: string, actorId?: string) {
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { id: keyId, organizationId },
      select: { organizationId: true, prefix: true, name: true },
    });

    if (!apiKey) throw new NotFoundException("Key not found");

    await this.prisma.apiKey.update({
      where: { id: keyId, organizationId },
      data: { status: ResourceStatus.REVOKED, revokedAt: new Date() },
    });

    // Freeze usage summaries so the final state is auditable.
    // Fire-and-forget — revocation must not be blocked by summary writes.
    void this.apiKeyUsageService.freezeOnRevocation(keyId);

    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: actorId ?? null,
        action: "api_key.revoked",
        resourceType: "api_key",
        resourceId: keyId,
        metadata: {
          prefix: apiKey.prefix,
          name: apiKey.name,
          organizationId: apiKey.organizationId,
          revokedAt: new Date().toISOString(),
        },
      },
    });
  }

  /**
   * List all API keys for an organization (metadata only, no secrets).
   *
   * @param organizationId - Organization to list keys for
   * @returns List of key metadata (id, prefix, name, status, scopes, dates)
   */
  async listKeysForOrganization(
    organizationId: string,
    pagination: { cursor?: string; limit?: number } = {},
  ) {
    const limit = pagination.limit ?? 20;
    const cursorWhere = cursorWhereFragment(pagination.cursor, "createdAt");

    const rows = await this.prisma.apiKey.findMany({
      where: { organizationId, ...cursorWhere },
      select: {
        id: true,
        prefix: true,
        name: true,
        status: true,
        scopeAssignments: { select: { scope: true } },
        createdAt: true,
        rotatedAt: true,
        revokedAt: true,
        expiresAt: true,
        lastUsedAt: true,
      },
      orderBy: cursorOrderBy("createdAt"),
      take: limit + 1,
    });

    return buildPage(rows, limit, "createdAt");
  }

  /**
   * Kept for backward compatibility with existing tests.
   * New code should prefer ApiKeyUsageService.recordUsage() directly.
   */
  async recordKeyUsage(keyId: string, organizationId?: string) {
    try {
      const updated = await this.prisma.apiKey.update({
        where: { id: keyId },
        data: { lastUsedAt: new Date() },
        select: { prefix: true, name: true, organizationId: true },
      });

      if (organizationId && organizationId === updated.organizationId) {
        await this.prisma.auditLog.create({
          data: {
            actorType: "api_key",
            actorId: keyId,
            action: "api_key.authenticated",
            resourceType: "api_key",
            resourceId: keyId,
            metadata: {
              prefix: updated.prefix,
              organizationId: updated.organizationId,
              timestamp: new Date().toISOString(),
            },
          },
        });
      }
    } catch {
      this.logger.warn(`Failed to record API key usage for ${keyId}`);
    }
  }
}