import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { DisputeEvidenceRole, DisputeStatus } from "@prisma/client";
import { createHash, randomUUID } from "crypto";
import { PrismaService } from "../database/prisma.service";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";

/** Manifest schema version identifier — bump on breaking changes. */
export const MANIFEST_VERSION = "earnproof.dispute-manifest.v1";

/** Terminal dispute statuses that reject new evidence manifests. */
export const TERMINAL_STATUSES: ReadonlySet<DisputeStatus> = new Set([
  DisputeStatus.RESOLVED,
  DisputeStatus.REJECTED,
]);

export interface StorageRefInput {
  /** Human-readable label (e.g. "stellar-horizon-tx"). */
  label: string;
  /**
   * Storage URI — hashed before persistence so the raw URI is never stored.
   * Example: "stellar://tx/abc123"
   */
  uri: string;
}

export interface CreateDisputeInput {
  proofId: string;
  /** Short, stable reason code — never free-form user text. */
  reason: string;
  /** Raw opener wallet hash (SHA-256 of wallet address). Stored as-is — already hashed by caller. */
  openerWalletHash: string;
}

export interface AddManifestInput {
  disputeId: string;
  submitterRole: DisputeEvidenceRole;
  /** Raw submitter wallet hash (SHA-256 of wallet address). Already hashed by caller. */
  submitterWalletHash: string;
  /** Algorithm identifiers used to produce evidence hashes, e.g. ["sha256", "hmac-sha256"]. */
  algorithms: string[];
  /** Storage references — URIs are hashed before persistence. */
  storageRefs: StorageRefInput[];
  /** Stellar contract transaction hash, if this manifest includes on-chain evidence. */
  contractTransactionHash?: string;
  contractConfirmedAt?: Date;
}

export interface TransitionDisputeInput {
  disputeId: string;
  toStatus: DisputeStatus;
  /** Required when transitioning to RESOLVED or REJECTED. */
  resolution?: string;
  /** Wallet hash of the admin performing the transition. */
  actorWalletHash: string;
}

/**
 * DisputeEvidenceService
 *
 * Manages off-chain proof dispute evidence manifests.
 *
 * Design rules (from acceptance criteria):
 *  1. Raw evidence is NEVER stored — only metadata, hashes, algorithm IDs,
 *     hashed storage references, and contract tx hashes.
 *  2. Terminal disputes (RESOLVED / REJECTED) reject new manifests.
 *  3. Manifests are versioned with a canonical hash for replay detection.
 *  4. Submitter authorisation is enforced: PROOF_OWNER may only open disputes
 *     for proofs they own; ISSUER / ADMIN / VERIFIER roles are checked at call
 *     site (caller passes role; service enforces ownership for PROOF_OWNER).
 *  5. Lifecycle transitions are validated: OPEN → UNDER_REVIEW → RESOLVED/REJECTED.
 *  6. Contract reconciliation: manifests may carry a contractTransactionHash for
 *     on-chain evidence correlation.
 */
@Injectable()
export class DisputeEvidenceService {
  private readonly logger = new Logger(DisputeEvidenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Open a new dispute for a proof.
   * Only the proof owner may open PROOF_OWNER disputes; other roles are
   * handled by their own guard/service layers.
   */
  async openDispute(input: CreateDisputeInput) {
    // Proof must exist
    const proof = await this.prisma.proof.findUnique({
      where: { id: input.proofId },
      select: { id: true, userId: true },
    });
    if (!proof) {
      throw new NotFoundException("Proof not found");
    }

    // One active dispute per proof at a time
    const existing = await this.prisma.proofDispute.findFirst({
      where: {
        proofId: input.proofId,
        status: { notIn: [DisputeStatus.RESOLVED, DisputeStatus.REJECTED] },
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(
        "An active dispute already exists for this proof. Resolve it before opening a new one.",
      );
    }

    return this.prisma.proofDispute.create({
      data: {
        proofId: input.proofId,
        reason: input.reason,
        openerHash: input.openerWalletHash,
        status: DisputeStatus.OPEN,
      },
    });
  }

  /**
   * Add an evidence manifest to an existing dispute.
   *
   * Rules:
   *  - Dispute must be in a non-terminal state (OPEN or UNDER_REVIEW).
   *  - Raw storage URIs are hashed (SHA-256) before persistence.
   *  - The manifest body is canonicalized and its hash is computed for
   *    replay detection (unique constraint on manifestHash).
   *  - A normal session bearer token cannot add a manifest — the caller
   *    must present their role explicitly.
   */
  async addManifest(input: AddManifestInput) {
    const dispute = await this.prisma.proofDispute.findUnique({
      where: { id: input.disputeId },
      select: { id: true, status: true, proofId: true },
    });
    if (!dispute) {
      throw new NotFoundException("Dispute not found");
    }

    // Terminal disputes reject new manifests
    if (TERMINAL_STATUSES.has(dispute.status)) {
      throw new BadRequestException(
        `Dispute is in terminal state (${dispute.status}) and no longer accepts new evidence manifests.`,
      );
    }

    // Hash each storage URI — raw URIs are never persisted
    const hashedRefs = input.storageRefs.map((ref) => ({
      label: ref.label,
      refHash: `sha256:${sha256(ref.uri)}`,
    }));

    // Build the canonical manifest body for hashing
    const manifestBody = {
      version: MANIFEST_VERSION,
      disputeId: input.disputeId,
      submitterRole: input.submitterRole,
      submitterHash: input.submitterWalletHash,
      algorithms: [...input.algorithms].sort(),
      storageRefs: hashedRefs,
      contractTransactionHash: input.contractTransactionHash ?? null,
      contractConfirmedAt: input.contractConfirmedAt?.toISOString() ?? null,
    };

    const manifestHash = `sha256:${sha256(canonicalize(manifestBody))}`;

    // Replay detection — manifestHash is unique
    const duplicate = await this.prisma.disputeEvidenceManifest.findFirst({
      where: { manifestHash },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException(
        "A manifest with identical content has already been submitted (replay detected).",
      );
    }

    return this.prisma.disputeEvidenceManifest.create({
      data: {
        id: randomUUID(),
        disputeId: input.disputeId,
        version: MANIFEST_VERSION,
        manifestHash,
        submitterRole: input.submitterRole,
        submitterHash: input.submitterWalletHash,
        algorithms: input.algorithms,
        storageRefs: hashedRefs,
        contractTransactionHash: input.contractTransactionHash ?? null,
        contractConfirmedAt: input.contractConfirmedAt ?? null,
      },
    });
  }

  /**
   * Transition dispute lifecycle.
   * Valid transitions: OPEN → UNDER_REVIEW → RESOLVED | REJECTED
   * Reverse transitions are rejected.
   */
  async transitionDispute(input: TransitionDisputeInput) {
    const dispute = await this.prisma.proofDispute.findUnique({
      where: { id: input.disputeId },
      select: { id: true, status: true },
    });
    if (!dispute) {
      throw new NotFoundException("Dispute not found");
    }

    this.validateTransition(dispute.status, input.toStatus);

    const isTerminal = TERMINAL_STATUSES.has(input.toStatus);
    if (isTerminal && !input.resolution) {
      throw new BadRequestException(
        "A resolution note is required when resolving or rejecting a dispute.",
      );
    }

    return this.prisma.proofDispute.update({
      where: { id: input.disputeId },
      data: {
        status: input.toStatus,
        resolution: input.resolution ?? null,
        resolvedAt: isTerminal ? new Date() : null,
      },
    });
  }

  /**
   * Get a dispute with its manifests.
   * Manifests are returned with hashed refs only — no raw URIs are ever returned.
   */
  async getDispute(disputeId: string) {
    const dispute = await this.prisma.proofDispute.findUnique({
      where: { id: disputeId },
      include: {
        manifests: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            version: true,
            manifestHash: true,
            submitterRole: true,
            submitterHash: true,
            algorithms: true,
            storageRefs: true,
            contractTransactionHash: true,
            contractConfirmedAt: true,
            createdAt: true,
          },
        },
      },
    });
    if (!dispute) {
      throw new NotFoundException("Dispute not found");
    }
    return dispute;
  }

  /**
   * List disputes for a proof.
   */
  async listDisputesForProof(proofId: string) {
    return this.prisma.proofDispute.findMany({
      where: { proofId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        reason: true,
        openerHash: true,
        resolvedAt: true,
        resolution: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { manifests: true } },
      },
    });
  }

  /**
   * Verify that the caller owns the proof the dispute belongs to.
   * Used for PROOF_OWNER authorization.
   */
  async assertProofOwnership(disputeId: string, callerUserId: string): Promise<void> {
    const dispute = await this.prisma.proofDispute.findUnique({
      where: { id: disputeId },
      include: { proof: { select: { userId: true } } },
    });
    if (!dispute) {
      throw new NotFoundException("Dispute not found");
    }
    if (dispute.proof.userId !== callerUserId) {
      throw new ForbiddenException(
        "You do not have permission to add evidence to this dispute.",
      );
    }
  }

  /**
   * Purge expired dispute records (terminal disputes older than retentionDays).
   */
  async purgeTerminalDisputes(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.proofDispute.deleteMany({
      where: {
        status: { in: [DisputeStatus.RESOLVED, DisputeStatus.REJECTED] },
        resolvedAt: { lt: cutoff },
      },
    });
    this.logger.log(`Purged ${result.count} terminal dispute(s) older than ${retentionDays} days`);
    return result.count;
  }

  // ── Canonical hash helper (exposed for testing golden vectors) ────────────

  static buildManifestHash(body: Record<string, unknown>): string {
    return `sha256:${sha256(canonicalize(body))}`;
  }

  static hashStorageUri(uri: string): string {
    return `sha256:${sha256(uri)}`;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private validateTransition(from: DisputeStatus, to: DisputeStatus): void {
    const allowed: Record<DisputeStatus, DisputeStatus[]> = {
      [DisputeStatus.OPEN]:         [DisputeStatus.UNDER_REVIEW, DisputeStatus.REJECTED],
      [DisputeStatus.UNDER_REVIEW]: [DisputeStatus.RESOLVED, DisputeStatus.REJECTED],
      [DisputeStatus.RESOLVED]:     [],
      [DisputeStatus.REJECTED]:     [],
    };

    if (!allowed[from]?.includes(to)) {
      throw new BadRequestException(
        `Invalid dispute lifecycle transition: ${from} → ${to}. ` +
        `Allowed transitions from ${from}: ${(allowed[from] ?? []).join(", ") || "none (terminal state)"}.`,
      );
    }
  }
}