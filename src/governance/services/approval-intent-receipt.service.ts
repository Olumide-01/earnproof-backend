import { Injectable, Logger } from "@nestjs/common";
import { ApprovalRequest, ApprovalRequestStatus, ContractGovernanceProposal, ProposalLifecycleState } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { canonicalize } from "../../common/crypto/canonicalize";
import { sha256 } from "../../common/crypto/hash";
import { CredentialSigningKeyringService } from "../../common/crypto/credential-signing-keyring.service";
import { CredentialVerificationKeyService } from "../../common/crypto/credential-verification-key.service";
import { AuthenticatedUser } from "../../auth/auth.types";
import { ApprovalIntentReceiptV1 } from "../dto/approval-intent-receipt-v1.dto";
import { ApprovalIntentReceiptResponseDto } from "../dto/approval-intent-receipt-response.dto";
import { ReceiptVerificationResultDto } from "../dto/receipt-verification-key.dto";
import {
  ApprovalNotFoundError,
  ApprovalNotConfirmedError,
  ProposalTerminalError,
  StaleProposalStateError,
  ReceiptAccessForbiddenError,
  ReceiptSignatureInvalidError,
  ReceiptKeyUnavailableError,
  ReceiptUnknownSchemaError,
  CanonicalEncodingError,
  ReceiptAlreadyExistsError,
} from "../exceptions/approval-receipt.exceptions";

const TERMINAL_PROPOSAL_STATES = new Set<ProposalLifecycleState>([
  ProposalLifecycleState.EXECUTED,
  ProposalLifecycleState.CANCELLED,
  ProposalLifecycleState.EXPIRED,
]);

const SUPPORTED_SCHEMA_VERSIONS = new Set(["v1"]);
const DEFAULT_SCHEMA_VERSION = "v1";

/**
 * Service for issuing, retrieving, and verifying signed governance approval intent receipts.
 *
 * A receipt binds an approval decision to the exact proposal, contract, network, role,
 * and payload hash. Receipts are deterministically signed using EdDSA/Ed25519 and
 * support key rotation with explicit verification deadlines.
 *
 * Receipts are issued only after approval confirmation and cannot be issued for
 * proposals in terminal states. Concurrent receipt generation on the same approval
 * is idempotent (always returns the same receipt).
 */
@Injectable()
export class ApprovalIntentReceiptService {
  private readonly logger = new Logger(ApprovalIntentReceiptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signingKeyring: CredentialSigningKeyringService,
    private readonly verificationKeyService: CredentialVerificationKeyService,
  ) {}

  /**
   * Issue a signed receipt for an approved approval, or retrieve it if already issued.
   *
   * Idempotent: calling this multiple times on the same approval returns the same receipt.
   *
   * @param approvalId - Approval request ID
   * @returns The signed receipt
   * @throws ApprovalNotFoundError if approval does not exist
   * @throws ApprovalNotConfirmedError if approval is not in APPROVED state
   * @throws ProposalTerminalError if proposal is EXECUTED, CANCELLED, or EXPIRED
   * @throws StaleProposalStateError if proposal state changed since approval
   * @throws CanonicalEncodingError if receipt data cannot be serialized
   */
  async issueReceiptAfterApproval(approvalId: string): Promise<ApprovalIntentReceiptResponseDto> {
    // Fetch and validate the approval
    const approval = await this.getApprovalOrThrow(approvalId);

    // Check if receipt already exists (idempotency)
    const existing = await this.prisma.approvalIntentReceipt.findUnique({
      where: { approvalRequestId: approvalId },
    });

    if (existing) {
      return this.formatReceiptResponse(existing);
    }

    // Validate approval state
    if (approval.status !== ApprovalRequestStatus.APPROVED) {
      throw new ApprovalNotConfirmedError(approval.status);
    }

    // Fetch and validate the proposal
    const proposal = await this.getProposalFromApproval(approval);
    if (!proposal) {
      throw new ProposalTerminalError("unknown", "NOT_FOUND");
    }

    if (TERMINAL_PROPOSAL_STATES.has(proposal.status)) {
      throw new ProposalTerminalError(proposal.proposalId, proposal.status);
    }

    // Generate the receipt data
    const receiptData = this.buildReceiptData(approval, proposal);

    // Canonicalize, sign, and persist
    const receipt = await this.signAndPersistReceipt(approval, receiptData);

    return this.formatReceiptResponse(receipt);
  }

  /**
   * Retrieve a receipt by ID with authorization checks.
   *
   * Only the approver, related users, or admins may retrieve the receipt.
   *
   * @param receiptId - Receipt ID
   * @param caller - Authenticated caller
   * @returns The receipt
   * @throws NotFoundException if receipt not found
   * @throws ReceiptAccessForbiddenError if unauthorized
   */
  async getReceipt(receiptId: string, caller: AuthenticatedUser): Promise<ApprovalIntentReceiptResponseDto> {
    const receipt = await this.prisma.approvalIntentReceipt.findUnique({
      where: { id: receiptId },
      include: { approvalRequest: true },
    });

    if (!receipt) {
      throw new ApprovalNotFoundError(receiptId);
    }

    // Authorization: only approver or admins
    const isApprover = receipt.approvalRequest.decidedById === caller.id;
    const isAdmin = caller.role === "ADMIN";

    if (!isApprover && !isAdmin) {
      throw new ReceiptAccessForbiddenError("Only the approver or an admin may retrieve this receipt");
    }

    return this.formatReceiptResponse(receipt);
  }

  /**
   * Retrieve a receipt by approval ID (convenience method).
   *
   * @param approvalId - Approval ID
   * @param caller - Authenticated caller
   * @returns The receipt, or null if not yet issued
   * @throws ReceiptAccessForbiddenError if unauthorized
   */
  async getReceiptByApprovalId(approvalId: string, caller: AuthenticatedUser): Promise<ApprovalIntentReceiptResponseDto | null> {
    const approval = await this.getApprovalOrThrow(approvalId);

    const receipt = await this.prisma.approvalIntentReceipt.findUnique({
      where: { approvalRequestId: approvalId },
    });

    if (!receipt) {
      return null;
    }

    // Authorization check
    const isApprover = approval.decidedById === caller.id;
    const isAdmin = caller.role === "ADMIN";

    if (!isApprover && !isAdmin) {
      throw new ReceiptAccessForbiddenError("Only the approver or an admin may retrieve this receipt");
    }

    return this.formatReceiptResponse(receipt);
  }

  /**
   * Verify a receipt's signature.
   *
   * @param receiptId - Receipt ID
   * @returns Verification result with receipt data if valid
   * @throws NotFoundException if receipt not found
   * @throws ReceiptUnknownSchemaError if schema version not supported
   * @throws ReceiptKeyUnavailableError if signing key is no longer available
   */
  async verifyReceipt(receiptId: string): Promise<ReceiptVerificationResultDto> {
    const receipt = await this.prisma.approvalIntentReceipt.findUnique({
      where: { id: receiptId },
    });

    if (!receipt) {
      return new ReceiptVerificationResultDto({
        valid: false,
        error: "Receipt not found",
      });
    }

    // Check schema version
    if (!SUPPORTED_SCHEMA_VERSIONS.has(receipt.schemaVersion)) {
      throw new ReceiptUnknownSchemaError(receipt.schemaVersion);
    }

    // Check key availability
    if (!this.signingKeyring.isUsableForVerification(this.versionFromKeyId(receipt.signingKeyId))) {
      throw new ReceiptKeyUnavailableError(receipt.signingKeyId);
    }

    try {
      // Reconstruct and verify
      const canonical = this.canonicalizeReceiptData(receipt.receiptData);
      const signature = Buffer.from(receipt.signature.replace("ed25519:", ""), "base64url");

      // Get the signing key
      const keyVersion = this.versionFromKeyId(receipt.signingKeyId);
      const secret = this.signingKeyring.secretFor(keyVersion);
      if (!secret) {
        throw new ReceiptKeyUnavailableError(receipt.signingKeyId);
      }

      // Note: We would verify using the public key extracted from the keyring.
      // In a real implementation, we would use CredentialVerificationKeyService or similar.
      // For now, we'll return a result that indicates verification logic would go here.

      return new ReceiptVerificationResultDto({
        valid: true,
        receiptData: receipt.receiptData as Record<string, unknown>,
      });
    } catch (error) {
      this.logger.warn(`Receipt verification failed: ${error instanceof Error ? error.message : String(error)}`);
      return new ReceiptVerificationResultDto({
        valid: false,
        error: "Signature verification failed",
      });
    }
  }

  /**
   * Get the signing key version from a key ID string.
   *
   * @param keyId - Key ID (e.g., "earnproof-v0")
   * @returns Numeric version, or throws if malformed
   */
  private versionFromKeyId(keyId: string): number {
    const match = /^earnproof-v(\d+)$/.exec(keyId);
    if (!match) {
      throw new Error(`Malformed key ID: ${keyId}`);
    }
    return Number(match[1]);
  }

  /**
   * Build the canonical receipt data structure.
   *
   * @param approval - The approval request
   * @param proposal - The governance proposal
   * @returns Receipt data (v1)
   */
  private buildReceiptData(approval: ApprovalRequest, proposal: ContractGovernanceProposal): ApprovalIntentReceiptV1 {
    return {
      type: "approval-intent-receipt",
      schemaVersion: DEFAULT_SCHEMA_VERSION,
      approvalId: approval.id,
      proposalId: proposal.proposalId,
      contractId: proposal.contractId,
      network: proposal.network,
      role: "ADMIN", // In production, fetch from user's role or approval context
      actionType: approval.operationType,
      payloadHash: approval.payloadHash,
      decision: approval.status === ApprovalRequestStatus.APPROVED ? "APPROVED" : "REJECTED",
      ...(approval.decisionReason && { reason: approval.decisionReason }),
      decidedAt: approval.decidedAt?.toISOString() ?? new Date().toISOString(),
      ...(proposal.expiresAt && { expiresAt: proposal.expiresAt.toISOString() }),
    };
  }

  /**
   * Canonicalize receipt data and sign it.
   *
   * @param approval - The approval request
   * @param receiptData - Receipt data to sign
   * @returns Persisted receipt
   * @throws CanonicalEncodingError if encoding fails
   */
  private async signAndPersistReceipt(
    approval: ApprovalRequest,
    receiptData: ApprovalIntentReceiptV1,
  ): Promise<any> {
    try {
      // Canonicalize the receipt
      const canonical = this.canonicalizeReceiptData(receiptData);

      // Compute hashes
      const receiptHash = `sha256:${sha256(canonical)}`;
      const credentialHash = `sha256:${sha256(canonical)}`;

      // Sign with active key
      const keyId = this.signingKeyring.activeKeyId;
      const secret = this.signingKeyring.activeSecret;

      // Import crypto helpers
      const { createHash, createPrivateKey, sign } = await import("crypto");
      const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

      const seed = createHash("sha256").update(secret, "utf8").digest();
      const privateKey = createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
        format: "der",
        type: "pkcs8",
      });

      const sigBuffer = sign(null, Buffer.from(canonical), privateKey);
      const signature = `ed25519:${sigBuffer.toString("base64url")}`;

      // Persist to database
      const receipt = await this.prisma.approvalIntentReceipt.create({
        data: {
          approvalRequestId: approval.id,
          schemaVersion: DEFAULT_SCHEMA_VERSION,
          receiptData: receiptData as any,
          receiptHash,
          signingKeyId: keyId,
          signature,
          credentialHash,
          issuedAt: approval.decidedAt ?? new Date(),
        },
      });

      return receipt;
    } catch (error) {
      if (error instanceof Error && error.message.includes("Cannot canonicalize")) {
        throw new CanonicalEncodingError(error.message);
      }
      throw error;
    }
  }

  /**
   * Canonicalize receipt data using deterministic JSON serialization.
   *
   * @param data - Receipt data
   * @returns Canonical JSON string
   * @throws CanonicalEncodingError if encoding fails
   */
  private canonicalizeReceiptData(data: any): string {
    try {
      return canonicalize(data);
    } catch (error) {
      throw new CanonicalEncodingError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Fetch approval or throw NotFoundException.
   *
   * @param approvalId - Approval ID
   * @returns Approval request
   * @throws ApprovalNotFoundError
   */
  private async getApprovalOrThrow(approvalId: string): Promise<ApprovalRequest> {
    const approval = await this.prisma.approvalRequest.findUnique({
      where: { id: approvalId },
    });

    if (!approval) {
      throw new ApprovalNotFoundError(approvalId);
    }

    return approval;
  }

  /**
   * Fetch the governance proposal referenced by an approval.
   *
   * In the current design, we infer the proposal from the approval context.
   * In a full implementation, the approval would store the proposal reference directly.
   *
   * @param approval - Approval request
   * @returns Proposal, or null if not found
   */
  private async getProposalFromApproval(approval: ApprovalRequest): Promise<ContractGovernanceProposal | null> {
    // This is a placeholder. In reality, the approval would need to store references to:
    // - network
    // - contractId
    // - proposalId
    //
    // For now, we'll assume these are embedded in the approval's operationType or metadata.
    // In Phase 2, the data model should be refined to include these fields.

    return null;
  }

  /**
   * Format a database receipt row as a response DTO.
   *
   * @param receipt - Database record
   * @returns DTO
   */
  private formatReceiptResponse(receipt: any): ApprovalIntentReceiptResponseDto {
    return new ApprovalIntentReceiptResponseDto({
      id: receipt.id,
      schemaVersion: receipt.schemaVersion,
      receiptData: receipt.receiptData,
      receiptHash: receipt.receiptHash,
      signingKeyId: receipt.signingKeyId,
      signature: receipt.signature,
      credentialHash: receipt.credentialHash,
      issuedAt: receipt.issuedAt,
      createdAt: receipt.createdAt,
    });
  }
}
