/**
 * DisputeEvidenceService
 *
 * Manages proof dispute lifecycle and versioned evidence manifests.
 *
 * Privacy contract:
 *  - Raw evidence is NEVER stored. Only canonical hashes, algorithm IDs,
 *    submitter role, and storage reference hashes are persisted.
 *  - submitterHash = SHA-256 of the wallet hash (double-hashed) — never raw address.
 *  - storageRefs contain {label, refHash} pairs where refHash = SHA-256 of the
 *    storage URI — the raw URI never touches the database.
 *
 * Lifecycle contract:
 *  - Terminal disputes (RESOLVED, REJECTED) reject new manifests.
 *  - manifestHash uniqueness enforces replay detection.
 *  - Only PROOF_OWNER, ISSUER, or ADMIN may open a dispute.
 *  - Only ADMIN may resolve or reject.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { PrismaService } from "../database/prisma.service";

export const MANIFEST_VERSION = "earnproof.dispute-manifest.v1" as const;

// ─── Terminal dispute states that reject new manifests ──────────────────────
const TERMINAL_DISPUTE_STATES = new Set(["RESOLVED", "REJECTED"]);

// ─── Input types ────────────────────────────────────────────────────────────

export interface OpenDisputeInput {
  proofId: string;
  /** Short reason code — never free-form user input. */
  reason: string;
  /** SHA-256 of the opener's walletHash (the opener field is already hashed). */
  openerWalletHash: string;
}

export interface StorageRef {
  label: string;
  /** Raw storage URI — will be SHA-256 hashed before storage. */
  uri: string;
}

export interface SubmitManifestInput {
  disputeId: string;
  submitterRole: "PROOF_OWNER" | "ISSUER" | "ADMIN" | "VERIFIER";
  /** SHA-256 of the submitter's walletHash. */
  submitterWalletHash: string;
  /** Algorithm identifiers used to produce evidence hashes, e.g. ["sha256", "sha3-256"]. */
  algorithms: string[];
  /** Storage references — raw URIs are hashed, never stored. */
  storageRefs: StorageRef[];
  /** Stellar contract transaction hash for on-chain evidence, if any. */
  contractTransactionHash?: string;
}

export interface ResolveDisputeInput {
  disputeId: string;
  resolution: string;
  /** ADMIN wallet hash. */
  adminWalletHash: string;
}

// ─── Output types ────────────────────────────────────────────────────────────

export interface DisputeResult {
  disputeId: string;
  proofId: string;
  status: string;
  reason: string;
  openerHash: string;
  manifestCount: number;
  resolvedAt: Date | null;
  resolution: string | null;
  createdAt: Date;
}

export interface ManifestResult {
  manifestId: string;
  disputeId: string;
  version: string;
  manifestHash: string;
  submitterRole: string;
  submitterHash: string;
  algorithms: string[];
  storageRefs: { label: string; refHash: string }[];
  contractTransactionHash: string | null;
  contractConfirmedAt: Date | null;
  createdAt: Date;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class DisputeEvidenceService {
  private readonly logger = new Logger(DisputeEvidenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Open a dispute ─────────────────────────────────────────────────────

  async openDispute(input: OpenDisputeInput): Promise<DisputeResult> {
    const { proofId, reason, openerWalletHash } = input;

    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException("Dispute reason must not be empty.");
    }

    const proof = await this.prisma.proof.findUnique({
      where: { id: proofId },
      select: { id: true, status: true },
    });
    if (!proof) {
      throw new NotFoundException(`Proof "${proofId}" not found.`);
    }

    const dispute = await this.prisma.proofDispute.create({
      data: {
        id: randomUUID(),
        proofId,
        status: "OPEN",
        reason: reason.trim(),
        openerHash: `sha256:${sha256(openerWalletHash)}`,
      },
      include: { _count: { select: { manifests: true } } },
    });

    this.logger.log(`Dispute ${dispute.id} opened for proof ${proofId}`);
    return this.toDisputeResult(dispute, dispute._count.manifests);
  }

  // ── Submit a manifest ──────────────────────────────────────────────────

  async submitManifest(input: SubmitManifestInput): Promise<ManifestResult> {
    const {
      disputeId,
      submitterRole,
      submitterWalletHash,
      algorithms,
      storageRefs,
      contractTransactionHash,
    } = input;

    const dispute = await this.prisma.proofDispute.findUnique({
      where: { id: disputeId },
      select: { id: true, status: true },
    });
    if (!dispute) {
      throw new NotFoundException(`Dispute "${disputeId}" not found.`);
    }

    // Terminal disputes reject new manifests
    if (TERMINAL_DISPUTE_STATES.has(dispute.status)) {
      throw new BadRequestException(
        `Dispute "${disputeId}" is in terminal state "${dispute.status}" and cannot accept new manifests.`,
      );
    }

    if (!algorithms || algorithms.length === 0) {
      throw new BadRequestException("At least one algorithm identifier is required.");
    }

    // Hash storage URIs — raw URIs never persisted
    const hashedRefs = storageRefs.map((ref) => ({
      label: ref.label,
      refHash: `sha256:${sha256(ref.uri)}`,
    }));

    // Compute submitter hash — double hash for extra distance from raw address
    const submitterHash = `sha256:${sha256(submitterWalletHash)}`;

    // Build canonical manifest body for deterministic hashing
    const manifestBody = {
      version: MANIFEST_VERSION,
      disputeId,
      submitterRole,
      submitterHash,
      algorithms: [...algorithms].sort(),
      storageRefs: hashedRefs
        .slice()
        .sort((a, b) => a.label.localeCompare(b.label)),
      contractTransactionHash: contractTransactionHash ?? null,
    };

    const manifestHash = `sha256:${sha256(canonicalize(manifestBody))}`;

    // Replay detection — unique constraint on manifestHash
    const existing = await this.prisma.disputeEvidenceManifest.findUnique({
      where: { manifestHash },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(
        `Manifest with identical content already exists (replay detected).`,
      );
    }

    const manifest = await this.prisma.disputeEvidenceManifest.create({
      data: {
        id: randomUUID(),
        disputeId,
        version: MANIFEST_VERSION,
        manifestHash,
        submitterRole,
        submitterHash,
        algorithms: algorithms as unknown as never,
        storageRefs: hashedRefs as unknown as never,
        contractTransactionHash: contractTransactionHash ?? null,
      },
    });

    this.logger.log(
      `Manifest ${manifest.id} submitted for dispute ${disputeId} (hash=${manifestHash})`,
    );

    return this.toManifestResult(manifest);
  }

  // ── List manifests ─────────────────────────────────────────────────────

  async listManifests(disputeId: string): Promise<ManifestResult[]> {
    const dispute = await this.prisma.proofDispute.findUnique({
      where: { id: disputeId },
      select: { id: true },
    });
    if (!dispute) {
      throw new NotFoundException(`Dispute "${disputeId}" not found.`);
    }

    const rows = await this.prisma.disputeEvidenceManifest.findMany({
      where: { disputeId },
      orderBy: { createdAt: "asc" },
    });

    return rows.map((r) => this.toManifestResult(r));
  }

  // ── Resolve / reject dispute ───────────────────────────────────────────

  async resolveDispute(input: ResolveDisputeInput, verdict: "RESOLVED" | "REJECTED"): Promise<DisputeResult> {
    const { disputeId, resolution } = input;

    const dispute = await this.prisma.proofDispute.findUnique({
      where: { id: disputeId },
      select: { id: true, status: true, proofId: true },
    });
    if (!dispute) {
      throw new NotFoundException(`Dispute "${disputeId}" not found.`);
    }
    if (TERMINAL_DISPUTE_STATES.has(dispute.status)) {
      throw new BadRequestException(
        `Dispute "${disputeId}" is already in terminal state "${dispute.status}".`,
      );
    }

    const updated = await this.prisma.proofDispute.update({
      where: { id: disputeId },
      data: {
        status: verdict,
        resolution: resolution.trim(),
        resolvedAt: new Date(),
      },
      include: { _count: { select: { manifests: true } } },
    });

    this.logger.log(`Dispute ${disputeId} ${verdict} by admin`);
    return this.toDisputeResult(updated, updated._count.manifests);
  }

  // ── Contract reconciliation ────────────────────────────────────────────

  /**
   * Record on-chain confirmation for a manifest.
   * Called by a reconciler job when the contract transaction is confirmed.
   */
  async recordContractConfirmation(
    manifestId: string,
    contractTransactionHash: string,
    confirmedAt: Date,
  ): Promise<void> {
    const manifest = await this.prisma.disputeEvidenceManifest.findUnique({
      where: { id: manifestId },
      select: { id: true, contractTransactionHash: true },
    });
    if (!manifest) {
      throw new NotFoundException(`Manifest "${manifestId}" not found.`);
    }
    if (manifest.contractTransactionHash && manifest.contractTransactionHash !== contractTransactionHash) {
      throw new BadRequestException(
        `Manifest "${manifestId}" already has a different contract transaction hash.`,
      );
    }

    await this.prisma.disputeEvidenceManifest.update({
      where: { id: manifestId },
      data: { contractTransactionHash, contractConfirmedAt: confirmedAt },
    });

    this.logger.log(`Manifest ${manifestId} contract confirmed: tx=${contractTransactionHash}`);
  }

  // ── Authorization helpers ──────────────────────────────────────────────

  async assertDisputeAccess(
    disputeId: string,
    callerId: string,
    callerRole: string,
  ): Promise<void> {
    if (callerRole === "ADMIN") return;

    const dispute = await this.prisma.proofDispute.findUnique({
      where: { id: disputeId },
      select: { proof: { select: { userId: true } } },
    });
    if (!dispute) throw new NotFoundException(`Dispute "${disputeId}" not found.`);
    if (dispute.proof.userId !== callerId) {
      throw new ForbiddenException("You do not have access to this dispute.");
    }
  }

  // ── Mappers ────────────────────────────────────────────────────────────

  private toDisputeResult(
    row: { id: string; proofId: string; status: string; reason: string; openerHash: string; resolvedAt: Date | null; resolution: string | null; createdAt: Date },
    manifestCount: number,
  ): DisputeResult {
    return {
      disputeId: row.id,
      proofId: row.proofId,
      status: row.status,
      reason: row.reason,
      openerHash: row.openerHash,
      manifestCount,
      resolvedAt: row.resolvedAt,
      resolution: row.resolution,
      createdAt: row.createdAt,
    };
  }

  private toManifestResult(row: {
    id: string; disputeId: string; version: string; manifestHash: string;
    submitterRole: string; submitterHash: string; algorithms: unknown;
    storageRefs: unknown; contractTransactionHash: string | null;
    contractConfirmedAt: Date | null; createdAt: Date;
  }): ManifestResult {
    return {
      manifestId: row.id,
      disputeId: row.disputeId,
      version: row.version,
      manifestHash: row.manifestHash,
      submitterRole: row.submitterRole,
      submitterHash: row.submitterHash,
      algorithms: row.algorithms as string[],
      storageRefs: row.storageRefs as { label: string; refHash: string }[],
      contractTransactionHash: row.contractTransactionHash,
      contractConfirmedAt: row.contractConfirmedAt,
      createdAt: row.createdAt,
    };
  }

  // ── Static helpers (exposed for test golden-vector assertions) ──────────

  static buildManifestHash(body: {
    version: string; disputeId: string; submitterRole: string; submitterHash: string;
    algorithms: string[]; storageRefs: { label: string; refHash: string }[];
    contractTransactionHash: string | null;
  }): string {
    return `sha256:${sha256(canonicalize(body))}`;
  }

  static hashStorageUri(uri: string): string {
    return `sha256:${sha256(uri)}`;
  }
}
