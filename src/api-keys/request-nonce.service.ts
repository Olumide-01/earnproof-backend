import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../database/prisma.service";
import { DEFAULT_CLOCK_WINDOW_SECONDS } from "../common/crypto/request-signing";

/**
 * Nonce persistence and replay detection for signed API requests.
 *
 * Privacy rules:
 *   - Only a SHA-256 hash of (keyId + ":" + rawNonce) is stored — raw nonce
 *     values are never persisted.
 *   - No IP addresses, request bodies, paths, or user agents are stored.
 *
 * Replay detection algorithm:
 *   INSERT … ON CONFLICT DO NOTHING returns the row count.
 *   0 rows inserted  → nonce already seen → REPLAY
 *   1 row inserted   → nonce is fresh → OK
 *
 * This is a single atomic round-trip — safe under concurrent requests for
 * the same nonce without advisory locks.
 *
 * Expiry:
 *   Each nonce row expires at (requestTimestamp + clockWindowSeconds).
 *   A periodic sweep (retention job) deletes rows past expiresAt.
 *   The guard also filters by expiresAt > now when looking up, so even
 *   without a sweep, stale rows don't produce false positives.
 */
@Injectable()
export class RequestNonceService {
  private readonly logger = new Logger(RequestNonceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Try to claim a nonce. Returns true if the nonce is fresh (first use),
   * false if it has already been seen (replay).
   *
   * @param keyId           The API key ID that presented this nonce.
   * @param rawNonce        The raw nonce value from the request header.
   * @param requestTimestamp Unix seconds of the signed request.
   * @param clockWindowSeconds How long (s) the nonce window stays open.
   */
  async claimNonce(
    keyId: string,
    rawNonce: string,
    requestTimestamp: number,
    clockWindowSeconds: number = DEFAULT_CLOCK_WINDOW_SECONDS,
  ): Promise<boolean> {
    const nonceHash = this.hashNonce(keyId, rawNonce);
    const expiresAt = new Date((requestTimestamp + clockWindowSeconds) * 1000);

    try {
      // Atomic INSERT … ON CONFLICT DO NOTHING.
      // If inserted count is 0, the nonce was already claimed.
      const count = await this.prisma.$executeRaw`
        INSERT INTO "RequestNonce" ("id", "nonceHash", "apiKeyId", "expiresAt", "createdAt")
        VALUES (gen_random_uuid()::text, ${nonceHash}, ${keyId}, ${expiresAt}, NOW())
        ON CONFLICT ("nonceHash") DO NOTHING
      `;
      return count === 1;
    } catch (error) {
      // Fail CLOSED — if we cannot persist the nonce we cannot guarantee
      // replay protection, so we reject the request.
      this.logger.error(
        `Nonce persistence failed for key ${keyId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Delete all expired nonce rows (called by the retention job).
   * Returns the number of rows deleted.
   */
  async purgeExpiredNonces(): Promise<number> {
    try {
      const result = await this.prisma.requestNonce.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      this.logger.log(`Nonce sweep: deleted ${result.count} expired rows`);
      return result.count;
    } catch (error) {
      this.logger.error(
        `Nonce sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /**
   * Hash (keyId + ":" + rawNonce) with SHA-256 so raw nonce values are never persisted.
   * Internal — exposed for testing via the spec file.
   */
  hashNonce(keyId: string, rawNonce: string): string {
    return createHash("sha256")
      .update(`${keyId}:${rawNonce}`, "utf8")
      .digest("hex");
  }
}