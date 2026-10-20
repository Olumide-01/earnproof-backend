import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { StructuredLogger } from "../common/logger";
import { PrismaService } from "../database/prisma.service";

/**
 * Backend state digest for a checkpoint.
 * Computed from backend projections to compare against live contract digests.
 */
export interface BackendStateDigest {
  digestVersion: string;
  components: Record<string, string>;
  computedAt: Date;
}

/**
 * BackendStateDigestCalculator
 *
 * Computes backend projection digests for comparison against live contract state.
 * Digests are deterministic: same checkpoint always produces same digest.
 * This enables idempotent comparisons and replay-safe reconciliation.
 *
 * Current implementation supports digest version "1.0" with basic components:
 * - issuerCount: count of active issuers
 * - registrationHash: SHA-256 of canonicalized issuer registry
 * - attestationCount: count of active attestations
 *
 * Future versions can add more components (payment aggregates, proof counts, etc.).
 */
@Injectable()
export class BackendStateDigestCalculator {
  private readonly logger = new StructuredLogger(
    BackendStateDigestCalculator.name,
  );

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Compute backend state digest for a checkpoint.
   *
   * @param network - Network identifier (e.g., "testnet")
   * @param checkpointNumber - Checkpoint number (unused in v1; for future use)
   * @returns BackendStateDigest with version "1.0" and component values
   */
  async computeDigest(
    network: string,
    checkpointNumber: string,
  ): Promise<BackendStateDigest> {
    const computedAt = new Date();
    const components: Record<string, string> = {};

    try {
      // Compute each component
      components["issuerCount"] = await this.computeIssuerCount();
      components["registrationHash"] = await this.computeRegistrationHash();
      components["attestationCount"] = await this.computeAttestationCount();

      return {
        digestVersion: "1.0",
        components,
        computedAt,
      };
    } catch (error) {
      this.logger.error(
        "Error computing backend state digest",
        error as Error,
        {
          network,
          checkpointNumber,
        },
      );
      throw error;
    }
  }

  /**
   * Compute issuer count component.
   * Counts ACTIVE issuers in the database.
   * @private
   */
  private async computeIssuerCount(): Promise<string> {
    const count = await this.prisma.issuer.count({
      where: { status: "ACTIVE" },
    });
    return count.toString();
  }

  /**
   * Compute registration hash component.
   * SHA-256 hash of canonicalized issuer registry (sorted by stellar address).
   * Deterministic: same set of issuers always produces same hash.
   * @private
   */
  private async computeRegistrationHash(): Promise<string> {
    // Fetch all active issuers, sorted by stellar address
    const issuers = await this.prisma.issuer.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        stellarAddress: true,
        organizationId: true,
      },
      orderBy: { stellarAddress: "asc" },
    });

    // Canonicalize: sort keys, recursively normalize, then hash
    const canonical = issuers.map((issuer) => ({
      id: issuer.id,
      organizationId: issuer.organizationId,
      stellarAddress: issuer.stellarAddress,
    }));

    const json = JSON.stringify(canonical);
    const hash = createHash("sha256").update(json).digest("hex");

    return `sha256:${hash}`;
  }

  /**
   * Compute attestation count component.
   * Counts ACTIVE attestations in the database.
   * @private
   */
  private async computeAttestationCount(): Promise<string> {
    const count = await this.prisma.attestation.count({
      where: { status: "ACTIVE" },
    });
    return count.toString();
  }
}
