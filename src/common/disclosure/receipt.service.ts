import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { canonicalize } from "../crypto/canonicalize";
import { sha256 } from "../crypto/hash";
import { CredentialVerificationKeyService } from "../crypto/credential-verification-key.service";
import { PrismaService } from "../../database/prisma.service";

/**
 * Disclosure Receipt Service
 * 
 * Generates and manages signed receipts for proof disclosure consent.
 * Uses existing canonicalization and signing patterns for tamper-evident receipts.
 * 
 * Design decisions:
 * - Reuse existing EdDSA signing infrastructure
 * - Canonical receipt payload for deterministic signatures
 * - Versioned receipt format for future compatibility
 * - Minimal payload to avoid duplicating sensitive proof data
 * - Expiration handling for receipt validity periods
 */
@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);
  private readonly RECEIPT_VERSION = "1.0";

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly credentialKeyService: CredentialVerificationKeyService,
  ) {}

  /**
   * Generate a signed disclosure receipt for an approved consent request.
   * Only creates receipts for valid, authorized disclosure requests.
   */
  async generateDisclosureReceipt(
    organizationId: string,
    proofId: string,
    requesterContext: {
      userId: string;
      purpose: string;
      approvalTimestamp: Date;
    },
    options: {
      expiresAt?: Date;
      policyVersion?: string;
    } = {},
  ): Promise<{
    receiptId: string;
    receipt: DisclosureReceiptPayload;
    signature: ReceiptSignature;
  }> {
    // Validate that the proof exists and belongs to the organization
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
        proofType: true,
        status: true,
        expiresAt: true,
        userId: true,
      },
    });

    if (!proof) {
      throw new BadRequestException("Proof not found or access denied");
    }

    if (proof.status !== "ACTIVE") {
      throw new BadRequestException("Cannot create receipt for inactive proof");
    }

    // Calculate default expiration (30 days or proof expiry, whichever is sooner)
    const defaultExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const expiresAt = options.expiresAt ?? 
      (proof.expiresAt < defaultExpiresAt ? proof.expiresAt : defaultExpiresAt);

    if (expiresAt <= new Date()) {
      throw new BadRequestException("Receipt expiration must be in the future");
    }

    // Build canonical receipt payload
    const receiptPayload: DisclosureReceiptPayload = {
      version: this.RECEIPT_VERSION,
      organizationId,
      proofId,
      proofType: proof.proofType,
      requester: {
        userId: requesterContext.userId,
        purpose: requesterContext.purpose,
      },
      disclosure: {
        approvedAt: requesterContext.approvalTimestamp.toISOString(),
        policyVersion: options.policyVersion || "default",
        expiresAt: expiresAt.toISOString(),
      },
      issuedAt: new Date().toISOString(),
    };

    // Generate canonical hash and signature
    const canonicalPayload = canonicalize(receiptPayload);
    const receiptHash = sha256(canonicalPayload);
    
    // Sign the receipt using existing credential signing infrastructure
    const signatureProof = this.credentialKeyService.signCredential(receiptPayload as unknown as Record<string, unknown>);
    
    const signature: ReceiptSignature = {
      algorithm: signatureProof.algorithm,
      keyId: signatureProof.keyId,
      signature: signatureProof.signature,
      credentialHash: receiptHash,
    };

    // Store receipt metadata (not the full payload to avoid duplication)
    const disclosureReceipt = await this.prisma.disclosureReceipt.create({
      data: {
        organizationId,
        proofId,
        receiptHash,
        signatureData: {
          version: this.RECEIPT_VERSION,
          algorithm: signature.algorithm,
          keyId: signature.keyId,
          signature: signature.signature,
          issuedAt: receiptPayload.issuedAt,
        },
        expiresAt,
      },
    });

    return {
      receiptId: disclosureReceipt.id,
      receipt: receiptPayload,
      signature,
    };
  }

  /**
   * Verify a disclosure receipt signature and validity.
   * Returns verification result without exposing signing keys.
   */
  async verifyDisclosureReceipt(
    receipt: DisclosureReceiptPayload,
    signature: ReceiptSignature,
  ): Promise<{
    isValid: boolean;
    status: "valid" | "expired" | "invalid_signature" | "unknown_key" | "malformed";
    verifiedAt: Date;
    expiresAt?: Date;
  }> {
    try {
      // Validate receipt format
      if (!this.isValidReceiptFormat(receipt)) {
        return {
          isValid: false,
          status: "malformed",
          verifiedAt: new Date(),
        };
      }

      // Check expiration
      const expiresAt = new Date(receipt.disclosure.expiresAt);
      if (expiresAt <= new Date()) {
        return {
          isValid: false,
          status: "expired",
          verifiedAt: new Date(),
          expiresAt,
        };
      }

      // Verify signature using existing credential verification
      const isSignatureValid = this.credentialKeyService.verifyCredential(
        receipt as unknown as Record<string, unknown>,
        {
          type: "Ed25519",
          algorithm: signature.algorithm,
          keyId: signature.keyId,
          credentialHash: signature.credentialHash,
          signature: signature.signature,
        },
      );

      if (!isSignatureValid) {
        // Check if key exists to distinguish between invalid signature and unknown key
        const hasKey = this.credentialKeyService.hasKey(signature.keyId);
        return {
          isValid: false,
          status: hasKey ? "invalid_signature" : "unknown_key",
          verifiedAt: new Date(),
          expiresAt,
        };
      }

      return {
        isValid: true,
        status: "valid",
        verifiedAt: new Date(),
        expiresAt,
      };
    } catch (error) {
      this.logger.warn("Receipt verification failed:", error);
      return {
        isValid: false,
        status: "malformed",
        verifiedAt: new Date(),
      };
    }
  }

  /**
   * Retrieve owner-scoped disclosure receipts.
   * Returns receipts for proofs owned by the specified user/organization.
   */
  async getOwnerReceipts(
    userId: string,
    organizationId: string,
    options: {
      proofId?: string;
      limit?: number;
      includeExpired?: boolean;
    } = {},
  ): Promise<Array<{
    id: string;
    proofId: string;
    receiptHash: string;
    issuedAt: Date;
    expiresAt: Date;
    signatureKeyId: string;
  }>> {
    // Build query filters
    const whereClause: any = {
      organizationId,
      proof: {
        userId,
      },
    };

    if (options.proofId) {
      whereClause.proofId = options.proofId;
    }

    if (!options.includeExpired) {
      whereClause.expiresAt = {
        gt: new Date(),
      };
    }

    const receipts = await this.prisma.disclosureReceipt.findMany({
      where: whereClause,
      select: {
        id: true,
        proofId: true,
        receiptHash: true,
        signatureData: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: options.limit || 50,
    });

    return receipts.map((receipt) => {
      const sigData = (receipt.signatureData ?? {}) as Record<string, any>;
      return {
        id: receipt.id,
        proofId: receipt.proofId,
        receiptHash: receipt.receiptHash,
        issuedAt: new Date((sigData.issuedAt as string) ?? receipt.createdAt),
        expiresAt: receipt.expiresAt,
        signatureKeyId: (sigData.keyId as string) ?? "",
      };
    });
  }

  /**
   * Clean up expired receipts.
   * Called by background job to maintain storage bounds.
   */
  async cleanupExpiredReceipts(): Promise<{ deletedCount: number }> {
    try {
      const result = await this.prisma.disclosureReceipt.deleteMany({
        where: {
          expiresAt: {
            lte: new Date(),
          },
        },
      });

      if (result.count > 0) {
        this.logger.log(`Cleaned up ${result.count} expired disclosure receipts`);
      }

      return { deletedCount: result.count };
    } catch (error) {
      this.logger.error("Failed to cleanup expired disclosure receipts:", error);
      throw error;
    }
  }

  /**
   * Validate receipt payload format.
   */
  private isValidReceiptFormat(receipt: any): receipt is DisclosureReceiptPayload {
    return (
      receipt &&
      typeof receipt === "object" &&
      typeof receipt.version === "string" &&
      typeof receipt.organizationId === "string" &&
      typeof receipt.proofId === "string" &&
      typeof receipt.proofType === "string" &&
      receipt.requester &&
      typeof receipt.requester.userId === "string" &&
      typeof receipt.requester.purpose === "string" &&
      receipt.disclosure &&
      typeof receipt.disclosure.approvedAt === "string" &&
      typeof receipt.disclosure.expiresAt === "string" &&
      typeof receipt.issuedAt === "string"
    );
  }
}

/**
 * Canonical disclosure receipt payload.
 * Contains minimal information needed for consent verification.
 */
export interface DisclosureReceiptPayload {
  version: string;
  organizationId: string;
  proofId: string;
  proofType: string;
  requester: {
    userId: string;
    purpose: string;
  };
  disclosure: {
    approvedAt: string; // ISO 8601
    policyVersion: string;
    expiresAt: string; // ISO 8601
  };
  issuedAt: string; // ISO 8601
}

/**
 * Receipt signature data structure.
 */
export interface ReceiptSignature {
  algorithm: "EdDSA";
  keyId: string;
  signature: string;
  credentialHash: string;
}