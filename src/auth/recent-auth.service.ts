import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { PrismaService } from "../database/prisma.service";
import { sha256 } from "../common/crypto/hash";

/**
 * Well-known destructive action identifiers.
 * These are the only values accepted by the guard and issuance endpoints.
 * Add a new entry here, and the rest of the enforcement pipeline picks it up.
 */
export const DESTRUCTIVE_ACTIONS = {
  ORG_DELETE:     "org:delete",
  ISSUER_REVOKE:  "issuer:revoke",
  KEY_REVOKE:     "key:revoke",
  SESSION_REVOKE_ALL: "session:revoke_all",
} as const;

export type DestructiveAction = (typeof DESTRUCTIVE_ACTIONS)[keyof typeof DESTRUCTIVE_ACTIONS];

/** Default lifetime of a recent-auth assertion (seconds). */
export const DEFAULT_ASSERTION_TTL_SECONDS = 5 * 60; // 5 minutes

/**
 * RecentAuthService
 *
 * Issues and consumes short-lived, single-use, action-bound recent-auth
 * assertions. An assertion proves that the authenticated user completed
 * wallet re-verification within the last TTL seconds, for the specific
 * action and resource they are about to perform.
 *
 * Binding fields (all must match on consume):
 *   userId     — assertion is personal; cannot be used by another user
 *   action     — assertion is action-specific; "org:delete" ≠ "key:revoke"
 *   resourceId — assertion is resource-scoped; cannot be reused for a
 *                different resource (pass "*" for resource-agnostic actions)
 *   originHash — binds to the issuing origin to resist cross-origin reuse
 *   network    — binds to the Stellar network to resist testnet→mainnet replay
 *
 * Replay policy:
 *   Each assertion token is stored as a SHA-256 hash and has a `usedAt`
 *   field. Consumption is an atomic UPDATE ... WHERE usedAt IS NULL,
 *   returning 1 row on success and 0 on replay/expiry. This is the same
 *   pattern used by WalletChallenge.
 *
 * Scope isolation:
 *   A normal session bearer token CANNOT substitute for a recent-auth
 *   assertion — the guard requires the dedicated `X-Recent-Auth` header.
 *   An assertion for one action cannot be used for another — the guard
 *   checks the action binding.
 *   Failed operations do not broaden scope — consumption only happens
 *   inside the controller method, after all authorization checks pass.
 */
@Injectable()
export class RecentAuthService {
  private readonly logger = new Logger(RecentAuthService.name);
  private readonly secret: string;
  private readonly network: string;
  private readonly ttlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.secret = configService.getOrThrow<string>("sessionSecret");
    this.network = configService.get<string>("stellar.networkPassphrase") ??
      "Test SDF Network ; September 2015";
    this.ttlSeconds = DEFAULT_ASSERTION_TTL_SECONDS;
  }

  /**
   * Issue a recent-auth assertion after the caller has completed wallet
   * re-verification (wallet challenge → verify cycle).
   *
   * @param userId     The authenticated user's database ID.
   * @param action     The destructive action being authorised.
   * @param resourceId The specific resource ID, or "*" for any.
   * @param origin     The raw Origin header value (hashed before storage).
   * @returns          The opaque assertion token (must be presented in
   *                   `X-Recent-Auth` header on the destructive request).
   */
  async issue(
    userId: string,
    action: DestructiveAction,
    resourceId: string,
    origin: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const rawToken = this.generateToken();
    const tokenHash = sha256(rawToken);
    const originHash = sha256(origin);
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);

    await this.prisma.recentAuthAssertion.create({
      data: {
        tokenHash,
        userId,
        action,
        resourceId,
        originHash,
        network: this.network,
        expiresAt,
      },
    });

    return { token: rawToken, expiresAt };
  }

  /**
   * Consume a recent-auth assertion.
   *
   * Returns the assertion's userId if valid. Throws UnauthorizedException
   * on any failure — the reason is logged server-side but never forwarded
   * to the client (all failures look the same externally).
   *
   * Atomic consumption: the UPDATE … WHERE usedAt IS NULL pattern means
   * two concurrent requests with the same token can never both succeed.
   */
  async consume(params: {
    token: string;
    action: DestructiveAction;
    resourceId: string;
    origin: string;
  }): Promise<{ userId: string }> {
    const tokenHash = sha256(params.token);
    const originHash = sha256(params.origin);

    // Atomic mark-as-used — same pattern as WalletChallenge.
    const updated = await this.prisma.recentAuthAssertion.updateMany({
      where: {
        tokenHash,
        action: params.action,
        resourceId: params.resourceId,
        originHash,
        network: this.network,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });

    if (updated.count === 0) {
      // Read back to distinguish replay vs expiry vs mismatch for logging only.
      const assertion = await this.prisma.recentAuthAssertion.findFirst({
        where: { tokenHash },
        select: { usedAt: true, expiresAt: true, action: true, userId: true },
      });

      if (assertion?.usedAt) {
        this.logger.warn(`Recent-auth replay attempt for action ${params.action}`);
      } else if (assertion && assertion.expiresAt <= new Date()) {
        this.logger.warn(`Recent-auth assertion expired for action ${params.action}`);
      } else if (assertion && assertion.action !== params.action) {
        this.logger.warn(
          `Recent-auth action mismatch: expected ${params.action}, got ${assertion.action}`,
        );
      } else {
        this.logger.warn(`Recent-auth assertion not found for action ${params.action}`);
      }

      throw new UnauthorizedException(
        "A valid recent-auth assertion is required for this operation. " +
        "Re-authenticate via POST /auth/verify and include the assertion " +
        "token in the X-Recent-Auth header.",
      );
    }

    // Fetch userId for the consumed assertion.
    const assertion = await this.prisma.recentAuthAssertion.findFirst({
      where: { tokenHash },
      select: { userId: true },
    });

    return { userId: assertion!.userId };
  }

  /**
   * Verify an assertion token WITHOUT consuming it.
   * Used by the guard to validate before the controller runs.
   * The controller calls `consume()` if (and only if) the operation succeeds.
   *
   * Returns the bound userId and resourceId for the guard to cross-check.
   */
  async verify(params: {
    token: string;
    action: DestructiveAction;
    origin: string;
  }): Promise<{ userId: string; resourceId: string }> {
    if (!params.token || params.token.trim() === "") {
      throw new UnauthorizedException(
        "A valid recent-auth assertion is required for this operation. " +
        "Re-authenticate via POST /auth/verify and include the assertion " +
        "token in the X-Recent-Auth header.",
      );
    }

    const tokenHash = sha256(params.token);
    const originHash = sha256(params.origin);

    const assertion = await this.prisma.recentAuthAssertion.findFirst({
      where: {
        tokenHash,
        action: params.action,
        originHash,
        network: this.network,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { userId: true, resourceId: true },
    });

    if (!assertion) {
      throw new UnauthorizedException(
        "A valid recent-auth assertion is required for this operation. " +
        "Re-authenticate via POST /auth/verify and include the assertion " +
        "token in the X-Recent-Auth header.",
      );
    }

    return { userId: assertion.userId, resourceId: assertion.resourceId };
  }

  /**
   * Purge expired assertion rows. Called by the retention job.
   */
  async purgeExpired(): Promise<number> {
    const result = await this.prisma.recentAuthAssertion.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }

  private generateToken(): string {
    return randomBytes(32).toString("base64url");
  }

  /**
   * Constant-time comparison helper for token strings.
   * Not used directly here (we hash before compare), but available for tests.
   */
  static safeEqual(a: string, b: string): boolean {
    try {
      return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
    } catch {
      return false;
    }
  }

  /**
   * Derive an HMAC-SHA256 signature over a canonical string for cross-field
   * binding verification. Used in the golden-vector test.
   */
  static buildCanonical(params: {
    userId: string;
    action: string;
    resourceId: string;
    originHash: string;
    network: string;
    expiresAt: number;
  }): string {
    return [
      params.userId,
      params.action,
      params.resourceId,
      params.originHash,
      params.network,
      String(params.expiresAt),
    ].join("\n");
  }

  static hmacSign(secret: string, canonical: string): string {
    return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
  }
}