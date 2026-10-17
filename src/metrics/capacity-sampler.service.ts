/**
 * CapacitySamplerService
 *
 * Collects bounded aggregate samples from the registry and persists them.
 *
 * Privacy contract:
 *  - Only aggregate counts are stored (issuer count, proof count, etc.).
 *  - No wallet addresses, proof IDs, user IDs, or any private data.
 *  - Sample hashes enable replay detection and deduplication.
 *
 * Bounded series:
 *  - A maximum number of samples per resource type is retained.
 *  - Older samples are pruned after each sampling run.
 *  - Default: 288 samples (one every 5 min for 24h, or one per hour for 12 days).
 */

import { Injectable, Logger } from "@nestjs/common";
import { canonicalize } from "../common/crypto/canonicalize";
import { sha256 } from "../common/crypto/hash";
import { redactError } from "../common/observability/redaction";
import { PrismaService } from "../database/prisma.service";
import {
  CAPACITY_SAMPLE_VERSION,
  CapacitySample,
  ResourceType,
  ResourceTypeValue,
} from "./capacity-types";

/** Maximum samples retained per resource type. */
export const MAX_SAMPLES_PER_TYPE = 288;

/** Which resource types to sample on each run. */
const ALL_RESOURCE_TYPES: ResourceTypeValue[] = [
  ResourceType.ISSUER,
  ResourceType.SCHEMA,
  ResourceType.PROOF,
  ResourceType.STORAGE,
];

// ---------------------------------------------------------------------------
// Sample body for hashing
// ---------------------------------------------------------------------------

interface SampleBody {
  version: string;
  resourceType: ResourceTypeValue;
  count: number;
  sampledAt: string;
}

function computeSampleHash(
  resourceType: ResourceTypeValue,
  count: number,
  sampledAt: Date,
): string {
  const body: SampleBody = {
    version: CAPACITY_SAMPLE_VERSION,
    resourceType,
    count,
    sampledAt: sampledAt.toISOString(),
  };
  return `sha256:${sha256(canonicalize(body))}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class CapacitySamplerService {
  private readonly logger = new Logger(CapacitySamplerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Collect one sample for every resource type and persist them.
   *
   * Replay detection: if a sample with the same hash already exists, it is
   * skipped (idempotent).  After insertion, old samples beyond
   * MAX_SAMPLES_PER_TYPE are pruned per resource type.
   *
   * @returns the number of new samples persisted.
   */
  async sample(): Promise<number> {
    const sampledAt = new Date();
    let persisted = 0;

    for (const resourceType of ALL_RESOURCE_TYPES) {
      try {
        const count = await this.collectCount(resourceType);
        const sampleHash = computeSampleHash(resourceType, count, sampledAt);

        // Replay detection — skip if a sample with this hash exists
        const existing = await this.prisma.registryCapacitySample.findUnique({
          where: { sampleHash },
          select: { id: true },
        });

        if (existing) {
          this.logger.debug(
            `Sample for ${resourceType} at ${sampledAt.toISOString()} already exists (hash=${sampleHash}), skipping`,
          );
          continue;
        }

        await this.prisma.registryCapacitySample.create({
          data: {
            resourceType,
            count: BigInt(count),
            sampleHash,
            sampledAt,
          },
        });
        persisted++;

        // Prune old samples beyond the bound
        await this.pruneOldSamples(resourceType);
      } catch (err: unknown) {
        const safeError = redactError(err);
        this.logger.error(
          `Failed to sample ${resourceType}: ${safeError}`,
        );
      }
    }

    this.logger.log(
      `Capacity sampling complete: ${persisted}/${ALL_RESOURCE_TYPES.length} new samples`,
    );
    return persisted;
  }

  /**
   * Collect the aggregate count for a resource type.
   *
   * These are aggregate queries over indexed columns — no private data is
   * returned, just counts.
   */
  private async collectCount(resourceType: ResourceTypeValue): Promise<number> {
    switch (resourceType) {
      case ResourceType.ISSUER:
        return this.prisma.issuer.count({
          where: { status: "ACTIVE" },
        });

      case ResourceType.SCHEMA: {
        // Distinct proof types in active proofs
        const proofs = await this.prisma.proof.groupBy({
          by: ["proofType"],
          where: { status: "ACTIVE" },
          _count: true,
        });
        return proofs.length;
      }

      case ResourceType.PROOF:
        return this.prisma.proof.count({
          where: { status: "ACTIVE" },
        });

      case ResourceType.STORAGE:
        // Total anchoring intents (storage footprint proxy)
        return this.prisma.anchoringIntent.count({
          where: { status: "CONFIRMED" },
        });

      default:
        throw new Error(`Unknown resource type: ${resourceType}`);
    }
  }

  /**
   * Prune samples older than the bounded window for a resource type.
   *
   * Keeps the newest MAX_SAMPLES_PER_TYPE samples; deletes the rest.
   */
  private async pruneOldSamples(resourceType: ResourceTypeValue): Promise<void> {
    // Find the Nth-newest sample for this resource type
    const cutoff = await this.prisma.registryCapacitySample.findMany({
      where: { resourceType },
      orderBy: { sampledAt: "desc" },
      skip: MAX_SAMPLES_PER_TYPE,
      take: 1,
      select: { sampledAt: true },
    });

    if (cutoff.length === 0) return;

    await this.prisma.registryCapacitySample.deleteMany({
      where: {
        resourceType,
        sampledAt: { lt: cutoff[0].sampledAt },
      },
    });
  }

  /**
   * Retrieve recent samples for a resource type, ordered oldest to newest.
   */
  async getRecentSamples(
    resourceType: ResourceTypeValue,
    limit = 50,
  ): Promise<CapacitySample[]> {
    const rows = await this.prisma.registryCapacitySample.findMany({
      where: { resourceType },
      orderBy: { sampledAt: "desc" },
      take: limit,
    });

    return rows
      .reverse()
      .map((r) => ({
        resourceType: r.resourceType as ResourceTypeValue,
        count: Number(r.count),
        sampleHash: r.sampleHash,
        sampledAt: r.sampledAt,
      }));
  }
}
