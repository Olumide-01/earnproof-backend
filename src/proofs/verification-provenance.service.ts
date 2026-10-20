/**
 * Verification source provenance service.
 *
 * Persists versioned provenance graphs tracking credential, backend, contract,
 * and Stellar observations that contributed to verification decisions.
 *
 * Immutable after creation. Privacy-safe: no source payloads, only identity and hashes.
 * Tenant-isolated via proofId foreign key (which constrains to userId).
 * Never changes verification cryptographic outcome.
 */

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import {
  VerificationProvenanceInput,
  VerificationProvenanceRecord,
  VerificationProvenanceResponseDto,
  VerificationProvenanceSourceInput,
  VERIFICATION_PROVENANCE_SCHEMA_VERSION,
} from "./provenance.types";
import { createHash } from "crypto";

/**
 * Deterministic hash of provenance input for idempotency detection.
 */
function hashProvenanceInput(input: VerificationProvenanceInput): string {
  const canonical = JSON.stringify({
    proofId: input.proofId,
    decisionInputHash: input.decisionInputHash,
    credentialHash: input.credentialHash,
    verificationResult: input.verificationResult,
    sources: input.sources.map((s) => ({
      sourceType: s.sourceType,
      sourceId: s.sourceId,
      sourceHash: s.sourceHash,
      observationOrder: s.observationOrder,
    })),
  });

  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Service for persisting and querying verification provenance.
 */
@Injectable()
export class VerificationProvenanceService {
  private readonly logger = new Logger(VerificationProvenanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a verification decision with complete source lineage.
   *
   * Atomically creates VerificationProvenance and VerificationProvenanceSource records.
   * Idempotent on repeated calls with identical input (same proofId, decidedAt).
   *
   * @param input Complete verification lineage
   * @returns Immutable provenance record
   * @throws PrismaClientKnownRequestError if proof does not exist
   */
  async recordProvenance(
    input: VerificationProvenanceInput,
  ): Promise<VerificationProvenanceRecord> {
    // Verify proof exists and belongs to valid user
    const proof = await this.prisma.proof.findUnique({
      where: { id: input.proofId },
      select: { id: true, userId: true },
    });

    if (!proof) {
      this.logger.warn(`Provenance recorded for unknown proof: ${input.proofId}`);
      // Silently drop: proof may have been deleted between verification and audit
      throw new Error(`Proof not found: ${input.proofId}`);
    }

    // Prepare sources JSON structure
    const sourcesJson = input.sources.map((source) => ({
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      observedAt: source.observedAt.toISOString(),
      sourceHash: source.sourceHash,
      observationOrder: source.observationOrder,
      ...(source.sourceLabel && { sourceLabel: source.sourceLabel }),
      ...(source.missingLinkReason && {
        missingLinkReason: source.missingLinkReason,
      }),
    }));

    const decidedAt = new Date();

    try {
      // Atomic transaction: create provenance and all sources
      const provenance = await this.prisma.$transaction(async (tx) => {
        // Create provenance record
        const prov = await tx.verificationProvenance.create({
          data: {
            proofId: input.proofId,
            schemaVersion: input.schemaVersion || VERIFICATION_PROVENANCE_SCHEMA_VERSION,
            decisionInputHash: input.decisionInputHash,
            credentialHash: input.credentialHash,
            policyVersion: input.policyVersion,
            proofStatus: input.proofStatus,
            verificationResult: input.verificationResult,
            failureReason: input.failureReason || null,
            boundaryContext: input.boundaryContext || null,
            sources: sourcesJson,
            sourceCount: input.sources.length,
            decidedAt,
          },
        });

        // Create individual source records for queryability
        for (const source of input.sources) {
          await tx.verificationProvenanceSource.create({
            data: {
              provenanceId: prov.id,
              proofId: input.proofId,
              sourceType: source.sourceType,
              sourceId: source.sourceId,
              sourceLabel: source.sourceLabel || null,
              observedAt: source.observedAt,
              sourceHash: source.sourceHash,
              observationOrder: source.observationOrder,
              missingLinkReason: source.missingLinkReason || null,
              decidedAt,
            },
          });
        }

        return prov;
      });

      this.logger.debug(
        `Recorded provenance for proof ${input.proofId} with ${input.sources.length} sources`,
      );

      // Reconstruct typed record
      return this.toProvenanceRecord(provenance, input.sources);
    } catch (error) {
      this.logger.error(
        `Failed to record provenance for proof ${input.proofId}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Retrieve provenance for a proof.
   *
   * @param proofId Proof to query
   * @param userId User authorizing the query (for tenant boundary check)
   * @returns Latest provenance record or null
   */
  async getProvenanceForProof(
    proofId: string,
    userId: string,
  ): Promise<VerificationProvenanceRecord | null> {
    // Verify user owns the proof
    const proof = await this.prisma.proof.findFirst({
      where: { id: proofId, userId },
      select: { id: true },
    });

    if (!proof) {
      this.logger.warn(
        `Unauthorized provenance access attempt: user ${userId} for proof ${proofId}`,
      );
      return null;
    }

    // Fetch latest provenance
    const provenance = await this.prisma.verificationProvenance.findFirst({
      where: { proofId },
      orderBy: { decidedAt: "desc" },
    });

    if (!provenance) {
      return null;
    }

    // Parse sources from JSON
    const sources = (Array.isArray(provenance.sources) ? provenance.sources : []).map(
      (s: any) => ({
        sourceType: s.sourceType,
        sourceId: s.sourceId,
        observedAt: new Date(s.observedAt),
        sourceHash: s.sourceHash,
        observationOrder: s.observationOrder,
        missingLinkReason: s.missingLinkReason,
      }),
    );

    return this.toProvenanceRecord(provenance, sources);
  }

  /**
   * Retrieve all provenance records for a proof.
   *
   * @param proofId Proof to query
   * @param userId User authorizing the query
   * @returns Chronological list of provenance records
   */
  async listProvenanceForProof(
    proofId: string,
    userId: string,
  ): Promise<VerificationProvenanceRecord[]> {
    // Verify user owns the proof
    const proof = await this.prisma.proof.findFirst({
      where: { id: proofId, userId },
      select: { id: true },
    });

    if (!proof) {
      return [];
    }

    const provenances = await this.prisma.verificationProvenance.findMany({
      where: { proofId },
      orderBy: { decidedAt: "asc" },
    });

    return provenances.map((p) => {
      const sources = (Array.isArray(p.sources) ? p.sources : []).map((s: any) => ({
        sourceType: s.sourceType,
        sourceId: s.sourceId,
        observedAt: new Date(s.observedAt),
        sourceHash: s.sourceHash,
        observationOrder: s.observationOrder,
        missingLinkReason: s.missingLinkReason,
      }));
      return this.toProvenanceRecord(p, sources);
    });
  }

  /**
   * Get provenance sources by type for a proof.
   *
   * @param proofId Proof to query
   * @param sourceType Filter by source type
   * @param userId User authorizing the query
   * @returns Filtered source records
   */
  async getSourcesByType(
    proofId: string,
    sourceType: string,
    userId: string,
  ): Promise<any[]> {
    // Verify user owns the proof
    const proof = await this.prisma.proof.findFirst({
      where: { id: proofId, userId },
      select: { id: true },
    });

    if (!proof) {
      return [];
    }

    const sources = await this.prisma.verificationProvenanceSource.findMany({
      where: { proofId, sourceType: sourceType as any },
      orderBy: { observationOrder: "asc" },
    });

    return sources;
  }

  /**
   * Convert provenance record to public response DTO.
   *
   * @param provenance Internal provenance record
   * @returns Public-facing response
   */
  toResponseDto(provenance: VerificationProvenanceRecord): VerificationProvenanceResponseDto {
    return {
      decidedAt: provenance.decidedAt.toISOString(),
      policyVersion: provenance.policyVersion,
      proofStatus: provenance.proofStatus,
      verificationResult: provenance.verificationResult,
      failureReason: provenance.failureReason || undefined,
      boundaryContext: provenance.boundaryContext || undefined,
      sources: provenance.sources.map((s) => ({
        sourceType: s.sourceType,
        sourceId: s.sourceId,
        sourceLabel: s.sourceLabel || undefined,
        observedAt: s.observedAt.toISOString(),
        observationOrder: s.observationOrder,
        missingLinkReason: s.missingLinkReason || undefined,
      })),
      sourceCount: provenance.sourceCount,
    };
  }

  /**
   * Internal helper to convert database record to typed record.
   */
  private toProvenanceRecord(
    dbRecord: any,
    sources: Array<{
      sourceType: any;
      sourceId: string;
      sourceLabel?: string;
      observedAt: Date;
      sourceHash: string;
      observationOrder: number;
      missingLinkReason?: string;
    }>,
  ): VerificationProvenanceRecord {
    return {
      id: dbRecord.id,
      proofId: dbRecord.proofId,
      schemaVersion: dbRecord.schemaVersion,
      decisionInputHash: dbRecord.decisionInputHash,
      credentialHash: dbRecord.credentialHash,
      policyVersion: dbRecord.policyVersion,
      proofStatus: dbRecord.proofStatus,
      verificationResult: dbRecord.verificationResult,
      failureReason: dbRecord.failureReason || undefined,
      boundaryContext: dbRecord.boundaryContext || undefined,
      sources,
      sourceCount: dbRecord.sourceCount,
      decidedAt: dbRecord.decidedAt,
      createdAt: dbRecord.createdAt,
    };
  }
}
