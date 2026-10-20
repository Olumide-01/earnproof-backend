import { Injectable, BadRequestException, NotFoundException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import { PrismaService } from "../database/prisma.service";
import { SharingOutcome } from "@prisma/client";
import { sha256 } from "../common/crypto/hash";

/**
 * Proof Sharing Service
 * 
 * Manages secure proof sharing through time-limited tokens.
 * 
 * Security features:
 * - Cryptographically secure token generation
 * - Privacy-safe event logging (IP subnets, hashed tokens/UAs)
 * - Automatic cleanup of expired events
 * - Owner-scoped access controls
 * 
 * Privacy considerations:
 * - Never stores raw sharing tokens (only SHA-256 hashes)
 * - IP addresses are anonymized to /24 subnets before hashing
 * - User agents are hashed before storage
 * - No PII is logged in sharing events
 */
@Injectable()
export class ProofSharingService {
  private readonly logger = new Logger(ProofSharingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Generate a secure sharing token with 32 bytes of entropy
   */
  private generateToken(): { token: string; tokenHash: string } {
    const tokenBytes = randomBytes(32);
    const token = tokenBytes.toString("hex");
    const tokenHash = sha256(token);

    return { token, tokenHash };
  }

  /**
   * Anonymize IP address to subnet for privacy
   */
  private anonymizeIpAddress(ip: string): string {
    if (ip === "::1") return "::1";
    // IPv4: Use /24 subnet (e.g., 192.168.1.50 -> 192.168.1.0)
    // IPv6: Use /64 subnet approximation
    if (ip.includes(".")) {
      const parts = ip.split(".");
      if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
      }
    } else if (ip.includes("::")) {
      const prefix = ip.split("::")[0];
      return prefix ? `${prefix}::` : ip;
    } else if (ip.includes(":")) {
      // IPv6 - use first 4 segments for /64 approximation
      const parts = ip.split(":");
      if (parts.length >= 4) {
        return `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}::`;
      }
    }
    
    // Fallback for unusual formats
    return ip;
  }

  /**
   * Sanitize purpose string to prevent injection attacks
   */
  private sanitizePurpose(purpose: string): string {
    return purpose
      .replace(/<[^>]*>/g, "") // Remove HTML tags
      .replace(/[<>&"']/g, "") // Remove dangerous characters
      .trim()
      .substring(0, 500); // Enforce length limit
  }

  /**
   * Generate sharing token for approved proof disclosure
   */
  async generateSharingToken(
    organizationId: string,
    proofId: string,
    approvalData: {
      purpose: string;
      requestedBy: string;
    },
    clientContext: {
      ipAddress: string;
      userAgent: string;
    },
  ): Promise<{
    token: string;
    expiresAt: Date;
    purpose: string;
  }> {
    // Verify proof exists and is active
    const proof = await this.prisma.proof.findFirst({
      where: {
        id: proofId,
        user: {
          organizationMemberships: {
            some: {
              organizationId,
              status: "ACTIVE",
            },
          },
        },
      },
      select: {
        id: true,
        status: true,
        expiresAt: true,
      },
    });

    if (!proof) {
      throw new NotFoundException("Proof not found or access denied");
    }

    if (proof.status !== "ACTIVE") {
      throw new BadRequestException("Cannot share inactive proof");
    }

    if (proof.expiresAt && proof.expiresAt <= new Date()) {
      throw new BadRequestException("Cannot share expired proof");
    }

    // Generate secure token
    const { token, tokenHash } = this.generateToken();

    // Calculate token expiration (configured TTL or proof expiry, whichever is sooner)
    const ttlMs = (this.config.get<number>("proofSharingTokenTtl") ?? 86400) * 1000;
    const maxExpiry = new Date(Date.now() + ttlMs);
    const expiresAt = proof.expiresAt && proof.expiresAt < maxExpiry 
      ? proof.expiresAt 
      : maxExpiry;

    // Sanitize inputs
    const sanitizedPurpose = this.sanitizePurpose(approvalData.purpose);

    // Log token generation event with privacy protection
    await this.prisma.proofSharingEvent.create({
      data: {
        organizationId,
        proofId,
        tokenHash,
        ipHash: sha256(this.anonymizeIpAddress(clientContext.ipAddress)),
        userAgentHash: sha256(clientContext.userAgent),
        outcome: SharingOutcome.TOKEN_GENERATED,
        purpose: sanitizedPurpose,
        requestedBy: approvalData.requestedBy,
        expiresAt,
      },
    });

    this.logger.log(
      `Generated sharing token for proof ${proofId} in org ${organizationId}`,
    );

    return {
      token,
      expiresAt,
      purpose: sanitizedPurpose,
    };
  }

  /**
   * Verify sharing token and return proof data if valid
   */
  async verifyWithSharingToken(
    token: string,
    clientContext: {
      ipAddress: string;
      userAgent: string;
    },
  ): Promise<{
    isValid: boolean;
    proof: any | null;
    error?: string;
  }> {
    const tokenHash = sha256(token);
    let outcome: SharingOutcome = SharingOutcome.INVALID_TOKEN;
    let proofId: string | null = null;
    let organizationId: string | null = null;
    let proof = null;

    try {
      // Find valid token event
      const tokenEvents = await this.prisma.proofSharingEvent.findMany({
        where: {
          tokenHash,
          outcome: SharingOutcome.TOKEN_GENERATED,
          expiresAt: {
            gt: new Date(),
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
      });

      if (tokenEvents.length === 0 || (tokenEvents[0].expiresAt && tokenEvents[0].expiresAt <= new Date())) {
        // Check if token exists but is expired
        const expiredEvents = await this.prisma.proofSharingEvent.findMany({
          where: {
            tokenHash,
            outcome: SharingOutcome.TOKEN_GENERATED,
          },
          take: 1,
        });

        outcome = (expiredEvents.length > 0 || (tokenEvents.length > 0 && tokenEvents[0].expiresAt && tokenEvents[0].expiresAt <= new Date()))
          ? SharingOutcome.EXPIRED_TOKEN 
          : SharingOutcome.INVALID_TOKEN;
      } else {
        const tokenEvent = tokenEvents[0];
        proofId = tokenEvent.proofId;
        organizationId = tokenEvent.organizationId;

        // Fetch proof data
        proof = await this.prisma.proof.findUnique({
          where: { id: proofId },
          include: {
            user: {
              select: {
                id: true,
                // Don't include PII
              },
            },
          },
        });

        if (!proof) {
          outcome = SharingOutcome.PROOF_NOT_FOUND;
        } else if (proof.status !== "ACTIVE") {
          outcome = SharingOutcome.PROOF_INACTIVE;
        } else {
          outcome = SharingOutcome.SUCCESS;
        }
      }
    } catch (error) {
      this.logger.error("Token verification failed:", error);
      outcome = SharingOutcome.ERROR;
    }

    // Log verification attempt
    await this.prisma.proofSharingEvent.create({
      data: {
        organizationId: organizationId || "unknown",
        proofId: proofId || "unknown",
        tokenHash,
        ipHash: sha256(this.anonymizeIpAddress(clientContext.ipAddress)),
        userAgentHash: sha256(clientContext.userAgent),
        outcome,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 day retention
      },
    });

    const isValid = outcome === SharingOutcome.SUCCESS;
    
    if (!isValid) {
      let errorMessage = "Invalid or expired sharing token";
      if (outcome === SharingOutcome.PROOF_NOT_FOUND) {
        errorMessage = "Proof no longer available";
      } else if (outcome === SharingOutcome.PROOF_INACTIVE) {
        errorMessage = "Proof is inactive";
      }

      return {
        isValid: false,
        proof: null,
        error: errorMessage,
      };
    }

    return {
      isValid: true,
      proof,
    };
  }

  /**
   * Get sharing events for organization (owner view)
   */
  async getSharingEvents(
    organizationId: string,
    filters: {
      proofId?: string;
      limit?: number;
    },
  ): Promise<any[]> {
    const limit = Math.min(filters.limit ?? 50, 100); // Cap at 100

    return this.prisma.proofSharingEvent.findMany({
      where: {
        organizationId,
        ...(filters.proofId ? { proofId: filters.proofId } : {}),
      },
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
    });
  }

  /**
   * Clean up expired sharing events (for background job)
   */
  async cleanupExpiredEvents(): Promise<{ deletedCount: number }> {
    const retentionDays = this.config.get<number>("proofSharingEventRetentionDays") ?? 90;
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const result = await this.prisma.proofSharingEvent.deleteMany({
      where: {
        createdAt: {
          lte: cutoffDate,
        },
      },
    });

    return {
      deletedCount: result.count,
    };
  }
}