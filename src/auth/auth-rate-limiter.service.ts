import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthEventType } from "@prisma/client";
import { StructuredLogger } from "../common/logger";
import { AuthAuditService } from "./auth-audit.service";

export interface RateLimitConfig {
  maxChallengeCreations: number;
  challengeCreationWindowMs: number;
  maxVerifications: number;
  verificationWindowMs: number;
}

/**
 * Custom exception for rate limiting with retry-after guidance.
 */
class TooManyRequestsException extends HttpException {
  constructor(message: string, retryAfter: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message,
        retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Rate limiting service for authentication operations.
 *
 * Protects against abuse by limiting:
 * - Challenge creation per wallet identifier
 * - Challenge verification per wallet identifier
 * - Operations per client metadata (optional)
 *
 * All limits are configurable via environment variables.
 *
 * Privacy guarantees:
 * - Never stores raw IP addresses
 * - Only hashed wallet addresses and client metadata
 * - Leverages AuthAuditService for privacy-safe tracking
 *
 * Failure modes:
 * - Fails open: if rate limit check fails, allows operation to proceed
 * - Never blocks auth due to audit system failure
 * - Logs all failures for monitoring
 */
@Injectable()
export class AuthRateLimiterService {
  private readonly logger = new StructuredLogger(AuthRateLimiterService.name);
  private readonly config: RateLimitConfig;

  constructor(
    private readonly auditService: AuthAuditService,
    configService: ConfigService,
  ) {
    this.config = {
      maxChallengeCreations: Number(
        configService.get<number>("auth.rateLimits.maxChallengeCreations") ?? 10,
      ),
      challengeCreationWindowMs: Number(
        configService.get<number>("auth.rateLimits.challengeCreationWindowMs") ??
          15 * 60 * 1000, // 15 minutes
      ),
      maxVerifications: Number(
        configService.get<number>("auth.rateLimits.maxVerifications") ?? 5,
      ),
      verificationWindowMs: Number(
        configService.get<number>("auth.rateLimits.verificationWindowMs") ??
          15 * 60 * 1000, // 15 minutes
      ),
    };
  }

  /**
   * Check if challenge creation is allowed for the given wallet.
   *
   * Throws TooManyRequestsException if rate limit exceeded.
   * Fails open: if check fails, allows operation to proceed.
   *
   * @param walletAddress - The wallet address requesting a challenge
   * @param clientMetadata - Optional client metadata for additional limiting
   */
  async checkChallengeCreationLimit(
    walletAddress: string,
    clientMetadata?: string,
  ): Promise<void> {
    try {
      const walletCount = await this.auditService.getEventCount(
        walletAddress,
        AuthEventType.CHALLENGE_CREATED,
        this.config.challengeCreationWindowMs,
      );

      if (walletCount >= this.config.maxChallengeCreations) {
        this.logger.warn("Challenge creation rate limit exceeded", {
          walletCount,
          limit: this.config.maxChallengeCreations,
        });

        // Record the rate limit event
        await this.auditService.recordEvent(
          AuthEventType.RATE_LIMITED,
          walletAddress,
          {
            success: false,
            failureReason: "Challenge creation rate limit exceeded",
            clientMetadata,
          },
        );

        throw new TooManyRequestsException(
          "Too many challenge requests. Please try again later.",
          Math.ceil(this.config.challengeCreationWindowMs / 1000),
        );
      }

      // Optional: also check client metadata if provided
      if (clientMetadata) {
        const clientCount = await this.auditService.getClientEventCount(
          clientMetadata,
          AuthEventType.CHALLENGE_CREATED,
          this.config.challengeCreationWindowMs,
        );

        if (clientCount >= this.config.maxChallengeCreations) {
          this.logger.warn("Client challenge creation rate limit exceeded", {
            clientCount,
            limit: this.config.maxChallengeCreations,
          });

          await this.auditService.recordEvent(
            AuthEventType.RATE_LIMITED,
            walletAddress,
            {
              success: false,
              failureReason: "Client challenge creation rate limit exceeded",
              clientMetadata,
            },
          );

          throw new TooManyRequestsException(
            "Too many challenge requests. Please try again later.",
            Math.ceil(this.config.challengeCreationWindowMs / 1000),
          );
        }
      }
    } catch (error) {
      // If it's already a TooManyRequestsException, re-throw it
      if (error instanceof TooManyRequestsException) {
        throw error;
      }

      // Otherwise, fail open: log the error but allow the operation
      this.logger.error("Rate limit check failed, allowing operation", error);
    }
  }

  /**
   * Check if challenge verification is allowed for the given wallet.
   *
   * Throws TooManyRequestsException if rate limit exceeded.
   * Fails open: if check fails, allows operation to proceed.
   *
   * @param walletAddress - The wallet address attempting verification
   * @param clientMetadata - Optional client metadata for additional limiting
   */
  async checkVerificationLimit(
    walletAddress: string,
    clientMetadata?: string,
  ): Promise<void> {
    try {
      const walletCount = await this.auditService.getEventCount(
        walletAddress,
        AuthEventType.CHALLENGE_VERIFIED,
        this.config.verificationWindowMs,
      );

      if (walletCount >= this.config.maxVerifications) {
        this.logger.warn("Verification rate limit exceeded", {
          walletCount,
          limit: this.config.maxVerifications,
        });

        await this.auditService.recordEvent(
          AuthEventType.RATE_LIMITED,
          walletAddress,
          {
            success: false,
            failureReason: "Verification rate limit exceeded",
            clientMetadata,
          },
        );

        throw new TooManyRequestsException(
          "Too many verification attempts. Please try again later.",
          Math.ceil(this.config.verificationWindowMs / 1000),
        );
      }

      // Optional: also check client metadata if provided
      if (clientMetadata) {
        const clientCount = await this.auditService.getClientEventCount(
          clientMetadata,
          AuthEventType.CHALLENGE_VERIFIED,
          this.config.verificationWindowMs,
        );

        if (clientCount >= this.config.maxVerifications) {
          this.logger.warn("Client verification rate limit exceeded", {
            clientCount,
            limit: this.config.maxVerifications,
          });

          await this.auditService.recordEvent(
            AuthEventType.RATE_LIMITED,
            walletAddress,
            {
              success: false,
              failureReason: "Client verification rate limit exceeded",
              clientMetadata,
            },
          );

          throw new TooManyRequestsException(
            "Too many verification attempts. Please try again later.",
            Math.ceil(this.config.verificationWindowMs / 1000),
          );
        }
      }
    } catch (error) {
      // If it's already a TooManyRequestsException, re-throw it
      if (error instanceof TooManyRequestsException) {
        throw error;
      }

      // Otherwise, fail open
      this.logger.error("Rate limit check failed, allowing operation", error);
    }
  }

  /**
   * Get the current rate limit configuration.
   *
   * Useful for debugging and monitoring.
   */
  getConfig(): RateLimitConfig {
    return { ...this.config };
  }
}
