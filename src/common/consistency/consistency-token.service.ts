import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import {
  ConsistencyFailureReason,
  ConsistencyTokenPayload,
  ConsistencyValidationResult,
  IssueTokenOptions,
} from "./consistency-token.types";

export const DEFAULT_CONSISTENCY_TOKEN_TTL_MS = 60_000; // 60 seconds

@Injectable()
export class ConsistencyTokenService {
  private primaryKeyId = "k1";
  private keys: Map<string, string> = new Map();
  private readonly defaultTtlMs: number;

  constructor(@Optional() configService?: ConfigService) {
    const secret =
      configService?.get<string>("CONSISTENCY_TOKEN_SECRET") ||
      "earnproof-consistency-default-secret-32-chars-long!";
    this.keys.set(this.primaryKeyId, secret);

    const ttlConfig = configService?.get<string>(
      "CONSISTENCY_TOKEN_TTL_MS",
      String(DEFAULT_CONSISTENCY_TOKEN_TTL_MS),
    );
    this.defaultTtlMs = parseInt(ttlConfig ?? String(DEFAULT_CONSISTENCY_TOKEN_TTL_MS), 10);
  }

  /**
   * Registers a key in the keyring. Allows key rotation by adding new primary
   * keys while keeping older keys valid for verification until retired.
   */
  addKey(keyId: string, secret: string, setAsPrimary = false): void {
    this.keys.set(keyId, secret);
    if (setAsPrimary) {
      this.primaryKeyId = keyId;
    }
  }

  /**
   * Revokes a key from the keyring (e.g. key retirement after grace period).
   */
  revokeKey(keyId: string): void {
    this.keys.delete(keyId);
  }

  /**
   * Issues a signed, resource-scoped consistency token after a mutation.
   */
  issueToken(options: IssueTokenOptions): string {
    const now = Date.now();
    const ttl = options.ttlMs ?? this.defaultTtlMs;
    const expiresAt = now + ttl;

    const payload: ConsistencyTokenPayload = {
      tenantId: options.tenantId,
      network: options.network,
      projectionId: options.projectionId,
      resources: options.resources,
      issuedAt: now,
      expiresAt,
      keyId: this.primaryKeyId,
    };

    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "EP-CTOK" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const dataToSign = `${header}.${body}`;

    const secret = this.keys.get(this.primaryKeyId);
    if (!secret) {
      throw new Error(`Primary consistency key "${this.primaryKeyId}" not found in keyring`);
    }

    const signature = crypto
      .createHmac("sha256", secret)
      .update(dataToSign)
      .digest("base64url");

    return `${dataToSign}.${signature}`;
  }

  /**
   * Convenience helper to issue a token for a single resource.
   */
  issueSingleResourceToken(
    tenantId: string,
    resourceType: string,
    resourceId: string,
    version: number,
    network?: string,
    projectionId?: string,
  ): string {
    return this.issueToken({
      tenantId,
      network,
      projectionId,
      resources: [{ resourceType, resourceId, version }],
    });
  }

  /**
   * Parses and cryptographically validates a consistency token string.
   * Fails closed on any format or signature discrepancy.
   */
  parseAndVerify(token: string): { payload?: ConsistencyTokenPayload; error?: ConsistencyFailureReason } {
    if (!token || typeof token !== "string") {
      return { error: "tampered" };
    }

    const parts = token.trim().split(".");
    if (parts.length !== 3) {
      return { error: "tampered" };
    }

    const [headerB64, bodyB64, signature] = parts;

    let payload: ConsistencyTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8"));
    } catch {
      return { error: "tampered" };
    }

    if (!payload || !payload.keyId || !payload.tenantId || !Array.isArray(payload.resources)) {
      return { error: "tampered" };
    }

    const secret = this.keys.get(payload.keyId);
    if (!secret) {
      return { error: "unknown_key" };
    }

    const dataToSign = `${headerB64}.${bodyB64}`;
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(dataToSign)
      .digest("base64url");

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { error: "tampered" };
    }

    if (Date.now() > payload.expiresAt) {
      return { error: "expired" };
    }

    return { payload };
  }

  /**
   * Validates consistency for read operations:
   * Compares observed resource versions from replicas/projections against required versions in the token.
   *
   * Guarantees:
   * - Cannot authorize access or reveal another tenant's resource (fails closed with tenant_mismatch).
   * - Tampered, expired, or mismatched tokens fail closed.
   * - Accurately reports replica lag or out-of-order writes.
   */
  validateConsistency(
    tokenString: string,
    expectedTenantId: string,
    observedResources: Record<string, number>, // Map of `${resourceType}:${resourceId}` -> observedVersion
    options?: {
      network?: string;
      projectionId?: string;
    },
  ): ConsistencyValidationResult {
    const { payload, error } = this.parseAndVerify(tokenString);

    if (error || !payload) {
      return {
        valid: false,
        consistent: false,
        reason: error ?? "tampered",
      };
    }

    // Tenant boundary: token cannot reveal existence or satisfy another tenant
    if (payload.tenantId !== expectedTenantId) {
      return {
        valid: false,
        consistent: false,
        reason: "tenant_mismatch",
      };
    }

    // Network check if specified
    if (options?.network && payload.network && options.network !== payload.network) {
      return {
        valid: false,
        consistent: false,
        reason: "network_mismatch",
      };
    }

    // Projection check if specified
    if (options?.projectionId && payload.projectionId && options.projectionId !== payload.projectionId) {
      return {
        valid: false,
        consistent: false,
        reason: "projection_mismatch",
      };
    }

    // Validate resource versions
    let maxLag = 0;
    let worstObserved = Number.MAX_SAFE_INTEGER;
    let worstRequired = 0;

    for (const res of payload.resources) {
      const key = `${res.resourceType}:${res.resourceId}`;
      const observed = observedResources[key];

      if (observed === undefined) {
        return {
          valid: true,
          consistent: false,
          reason: "resource_not_found",
          requiredVersion: res.version,
          payload,
        };
      }

      if (observed < res.version) {
        const lag = res.version - observed;
        if (lag > maxLag) {
          maxLag = lag;
          worstObserved = observed;
          worstRequired = res.version;
        }
      }
    }

    if (maxLag > 0) {
      return {
        valid: true,
        consistent: false,
        reason: "replica_lag",
        requiredVersion: worstRequired,
        observedVersion: worstObserved,
        lag: maxLag,
        payload,
      };
    }

    return {
      valid: true,
      consistent: true,
      requiredVersion: payload.resources[0]?.version,
      observedVersion: observedResources[`${payload.resources[0]?.resourceType}:${payload.resources[0]?.resourceId}`],
      lag: 0,
      payload,
    };
  }
}
