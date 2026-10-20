import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../database/prisma.service";
import { IdempotencyStatus } from "@prisma/client";
import * as crypto from "crypto";

export interface IdempotencyCheckResult {
  isNew: boolean;
  record?: {
    status: IdempotencyStatus;
    responseBody?: any;
    responseStatusCode?: number;
    resourceType?: string | null;
    resourceId?: string | null;
    consistencyToken?: string | null;
  };
}

export interface OperationStatusOutput {
  idempotencyKey: string;
  organizationId: string;
  status: "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED" | "EXPIRED";
  operationType?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  attemptCount: number;
  responseStatusCode?: number | null;
  responseBody?: any;
  consistencyToken?: string | null;
  expiresAt: Date;
  cancellationReason?: string | null;
  retryable: boolean;
  terminal: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * IdempotencyService enforces idempotency on selected mutations using idempotency keys.
 *
 * Usage:
 * 1. Call `check()` at the start of a mutation handler to determine if this is a replay.
 * 2. If `isNew === true`, execute the mutation as normal, then call `success()` to store the response.
 * 3. If `isNew === false` and status === COMPLETED, replay the stored response.
 * 4. If `isNew === false` and status === PENDING, return 408 or wait for the previous attempt.
 * 5. If `isNew === false` and status === FAILED, return the stored error or allow retry.
 *
 * Idempotency keys are scoped per organization. All records are stored with an expiry time.
 * Cleanup is delegated to the retention policy (see retention-cleanup.service.ts).
 */
@Injectable()
export class IdempotencyService {
  // Default TTL for idempotency records: 24 hours
  private readonly defaultTtlMs: number;

  // Max length for idempotency key: 255 characters
  private readonly maxKeyLength = 255;

  // Allowed characters in idempotency key: alphanumeric, dash, underscore
  private readonly keyPattern = /^[a-zA-Z0-9_-]+$/;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    const ttlHours = parseInt(
      configService.get("IDEMPOTENCY_RECORD_TTL_HOURS", "24"),
      10,
    );
    this.defaultTtlMs = ttlHours * 60 * 60 * 1000;
  }

  /**
   * Validates an idempotency key for length and character constraints.
   * Throws BadRequestException if invalid.
   */
  validateKey(key: string): void {
    if (!key || key.length === 0) {
      throw new BadRequestException(
        "Idempotency key is required and must not be empty",
      );
    }

    if (key.length > this.maxKeyLength) {
      throw new BadRequestException(
        `Idempotency key exceeds maximum length of ${this.maxKeyLength} characters`,
      );
    }

    if (!this.keyPattern.test(key)) {
      throw new BadRequestException(
        "Idempotency key must contain only alphanumeric characters, dashes, and underscores",
      );
    }
  }

  /**
   * Computes a SHA-256 fingerprint of the request payload.
   * Used to detect if the same key is reused with a different request body.
   */
  computeFingerprint(method: string, path: string, body: any): string {
    const canonical = JSON.stringify({ method, path, body });
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  /**
   * Checks if an idempotency key has been used before in this organization.
   * If the key exists and the fingerprint differs, throws ConflictException.
   * Returns { isNew: true } if this is a new key, or { isNew: false, record } if it's a replay.
   */
  async check(
    organizationId: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<IdempotencyCheckResult> {
    this.validateKey(idempotencyKey);

    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId,
          idempotencyKey,
        },
      },
      select: {
        status: true,
        requestFingerprint: true,
        responseBody: true,
        responseStatusCode: true,
      },
    });

    if (!existing) {
      // New key — proceed with the mutation
      return { isNew: true };
    }

    // Key has been seen before. Check if the payload matches.
    if (existing.requestFingerprint !== requestFingerprint) {
      // Payload mismatch — reject with 409 Conflict
      throw new ConflictException(
        "Idempotency key was used with a different request payload. " +
          "Use a new key or retry with the same payload.",
      );
    }

    // Payload matches — return the stored record for replay or waiting logic
    return {
      isNew: false,
      record: {
        status: existing.status,
        responseBody: existing.responseBody,
        responseStatusCode: existing.responseStatusCode ?? undefined,
        resourceType: (existing as any).resourceType ?? undefined,
        resourceId: (existing as any).resourceId ?? undefined,
        consistencyToken: (existing as any).consistencyToken ?? undefined,
      },
    };
  }

  /**
   * Creates a new idempotency record in PENDING status.
   * Called at the start of a mutation to reserve the idempotency key.
   * Uses a database-level unique constraint to prevent race conditions.
   */
  async reserve(
    organizationId: string,
    idempotencyKey: string,
    requestFingerprint: string,
    options?: {
      operationType?: string;
      resourceType?: string;
      resourceId?: string;
      metadata?: any;
    },
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + this.defaultTtlMs);

    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          organizationId,
          idempotencyKey,
          requestFingerprint,
          status: IdempotencyStatus.PENDING,
          operationType: options?.operationType,
          resourceType: options?.resourceType,
          resourceId: options?.resourceId,
          metadata: options?.metadata,
          attemptCount: 1,
          expiresAt,
        },
      });
    } catch (error: any) {
      // If unique constraint fails, another concurrent request already reserved this key.
      if (error.code === "P2002") {
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId,
              idempotencyKey,
            },
          },
        });
        if (existing && existing.requestFingerprint !== requestFingerprint) {
          throw new ConflictException(
            "Idempotency key was used with a different request payload.",
          );
        }
        if (existing) {
          await this.prisma.idempotencyRecord.update({
            where: { id: existing.id },
            data: { attemptCount: existing.attemptCount + 1 },
          });
        }
        return;
      }
      throw error;
    }
  }

  /**
   * Updates an idempotency record to COMPLETED status with the response.
   * Strips sensitive fields from the response before storage.
   */
  async success(
    organizationId: string,
    idempotencyKey: string,
    responseBody: any,
    responseStatusCode: number,
    options?: {
      resourceType?: string;
      resourceId?: string;
      consistencyToken?: string;
    },
  ): Promise<void> {
    const strippedBody = this.stripSensitiveFields(responseBody);

    await this.prisma.idempotencyRecord.updateMany({
      where: {
        organizationId,
        idempotencyKey,
      },
      data: {
        status: IdempotencyStatus.COMPLETED,
        responseBody: strippedBody,
        responseStatusCode,
        resourceType: options?.resourceType,
        resourceId: options?.resourceId,
        consistencyToken: options?.consistencyToken,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Updates an idempotency record to FAILED status.
   * Used when the mutation encounters a permanent error.
   */
  async failure(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.prisma.idempotencyRecord.updateMany({
      where: {
        organizationId,
        idempotencyKey,
      },
      data: {
        status: IdempotencyStatus.FAILED,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Cancels a pending idempotency record.
   */
  async cancel(
    organizationId: string,
    idempotencyKey: string,
    reason?: string,
  ): Promise<void> {
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId,
          idempotencyKey,
        },
      },
    });

    if (!existing || existing.organizationId !== organizationId) {
      throw new NotFoundException("Idempotent operation not found");
    }

    if (existing.status === IdempotencyStatus.COMPLETED) {
      throw new ConflictException(
        "Cannot cancel an operation that has already completed",
      );
    }

    await this.prisma.idempotencyRecord.update({
      where: { id: existing.id },
      data: {
        status: IdempotencyStatus.CANCELLED,
        cancellationReason: reason ?? "Operation cancelled by client",
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Retrieves tenant-scoped operation status with bounded retention and consistency metadata.
   * Unknown keys reveal no resource existence across tenants.
   */
  async getOperationStatus(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<OperationStatusOutput> {
    this.validateKey(idempotencyKey);

    const record = await this.prisma.idempotencyRecord.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId,
          idempotencyKey,
        },
      },
    });

    if (!record || record.organizationId !== organizationId) {
      throw new NotFoundException("Idempotent operation not found");
    }

    const now = new Date();
    const isExpired = record.expiresAt.getTime() < now.getTime();
    const status: OperationStatusOutput["status"] = isExpired
      ? "EXPIRED"
      : (record.status as any);

    const terminal =
      status === "COMPLETED" ||
      status === "FAILED" ||
      status === "CANCELLED" ||
      status === "EXPIRED";

    const retryable =
      status === "FAILED" || status === "CANCELLED" || status === "EXPIRED";

    return {
      idempotencyKey: record.idempotencyKey,
      organizationId: record.organizationId,
      status,
      operationType: record.operationType,
      resourceType: record.resourceType,
      resourceId: record.resourceId,
      attemptCount: record.attemptCount,
      responseStatusCode: record.responseStatusCode,
      responseBody: record.responseBody,
      consistencyToken: record.consistencyToken,
      expiresAt: record.expiresAt,
      cancellationReason: record.cancellationReason,
      retryable,
      terminal,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Strips sensitive fields from a response object before persisting.
   * This prevents secrets and PII from being stored in the idempotency record.
   * Recursively processes nested objects and arrays.
   */
  private stripSensitiveFields(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj !== "object") {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.stripSensitiveFields(item));
    }

    // Sensitive field patterns to exclude
    const sensitivePatterns = [
      /^secret/i,
      /^token/i,
      /^password/i,
      /^apiKey/i,
      /^key$/i,
      /^private/i,
      /^signature/i,
      /^amountEncrypted/i,
      /^hash/i,
    ];

    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const isSensitive = sensitivePatterns.some((pattern) =>
        pattern.test(key),
      );

      if (!isSensitive) {
        cleaned[key] = this.stripSensitiveFields(value);
      }
    }

    return cleaned;
  }
}
