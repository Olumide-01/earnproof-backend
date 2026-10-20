import { Injectable, Logger } from "@nestjs/common";

export interface CacheEntry<T> {
  value: T;
  cachedAt: number;
  expiresAt: number;
  contractEpoch: number;
  network: string;
  contractId: string;
  isRevoked: boolean;
  isDisputed: boolean;
  isPaused: boolean;
}

export interface CacheFreshnessMetadata {
  freshness: "fresh" | "stale" | "authoritative";
  source: "cache" | "contract" | "fail-closed";
  cacheAgeSeconds?: number;
  contractEpoch: number;
}

export interface RevocationCacheOptions {
  ttlSeconds?: number;
  maxStaleGraceSeconds?: number;
}

@Injectable()
export class RevocationCachePolicy {
  private readonly logger = new Logger(RevocationCachePolicy.name);
  private readonly cache = new Map<string, CacheEntry<any>>();
  private readonly inFlightResolvers = new Map<string, Promise<any>>();
  private readonly defaultTtlMs = 60 * 1000; // 60s
  private readonly currentContractEpochs = new Map<string, number>();

  /**
   * Generates a deterministic cache key scoped by network, contract, and resource ID.
   */
  buildKey(network: string, contractId: string, resourceId: string): string {
    return `${network}:${contractId}:${resourceId}`;
  }

  /**
   * Records or updates the known authoritative contract epoch for targeted invalidation.
   */
  updateContractEpoch(network: string, contractId: string, epoch: number): void {
    const scope = `${network}:${contractId}`;
    const prev = this.currentContractEpochs.get(scope) ?? 0;
    if (epoch > prev) {
      this.currentContractEpochs.set(scope, epoch);
      this.logger.debug(`Contract epoch advanced to ${epoch} for ${scope}`);
    }
  }

  /**
   * Invalidates a specific resource or all resources tied to a changed contract state.
   */
  invalidate(network: string, contractId: string, resourceId?: string): void {
    if (resourceId) {
      const key = this.buildKey(network, contractId, resourceId);
      this.cache.delete(key);
    } else {
      const prefix = `${network}:${contractId}:`;
      for (const k of this.cache.keys()) {
        if (k.startsWith(prefix)) {
          this.cache.delete(k);
        }
      }
    }
  }

  /**
   * Signals a transition event (revocation, dispute, or pause) which immediately invalidates
   * or marks the cache entry as fail-closed to avoid serving stale state through lag.
   */
  recordTransitionEvent(
    network: string,
    contractId: string,
    resourceId: string,
    event: { revoked?: boolean; disputed?: boolean; paused?: boolean },
  ): void {
    const key = this.buildKey(network, contractId, resourceId);
    const existing = this.cache.get(key);
    if (existing) {
      if (event.revoked) existing.isRevoked = true;
      if (event.disputed) existing.isDisputed = true;
      if (event.paused) existing.isPaused = true;
      existing.expiresAt = 0; // force immediate expiry/fail-closed
    }
    // Always invalidate immediately to ensure queries go to source
    this.cache.delete(key);
  }

  /**
   * Retrieves an item with thundering-herd protection and fail-closed freshness semantics.
   */
  async getOrFetch<T>(
    network: string,
    contractId: string,
    resourceId: string,
    fetchAuthoritative: () => Promise<{ value: T; isRevoked?: boolean; isDisputed?: boolean; isPaused?: boolean; epoch?: number }>,
    options?: RevocationCacheOptions,
  ): Promise<{ data: T; metadata: CacheFreshnessMetadata }> {
    const key = this.buildKey(network, contractId, resourceId);
    const now = Date.now();
    const scope = `${network}:${contractId}`;
    const authoritativeEpoch = this.currentContractEpochs.get(scope) ?? 0;

    const entry = this.cache.get(key);

    if (entry) {
      const isExpired = now > entry.expiresAt;
      const isEpochStale = entry.contractEpoch < authoritativeEpoch;
      const isFailClosed = entry.isRevoked || entry.isDisputed || entry.isPaused;

      if (!isExpired && !isEpochStale && !isFailClosed) {
        return {
          data: entry.value,
          metadata: {
            freshness: "fresh",
            source: "cache",
            cacheAgeSeconds: Math.floor((now - entry.cachedAt) / 1000),
            contractEpoch: entry.contractEpoch,
          },
        };
      }
    }

    // Thundering herd protection via shared in-flight promise
    let inFlight = this.inFlightResolvers.get(key);
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const fresh = await fetchAuthoritative();
          const epoch = fresh.epoch ?? authoritativeEpoch;
          const ttlMs = (options?.ttlSeconds ?? 60) * 1000;

          // If the authoritative state indicates revoked, disputed, or paused, fail closed
          const isRevoked = Boolean(fresh.isRevoked);
          const isDisputed = Boolean(fresh.isDisputed);
          const isPaused = Boolean(fresh.isPaused);

          const newEntry: CacheEntry<T> = {
            value: fresh.value,
            cachedAt: Date.now(),
            expiresAt: (isRevoked || isDisputed || isPaused) ? 0 : Date.now() + ttlMs,
            contractEpoch: epoch,
            network,
            contractId,
            isRevoked,
            isDisputed,
            isPaused,
          };

          if (!isRevoked && !isDisputed && !isPaused) {
            this.cache.set(key, newEntry);
          } else {
            this.cache.delete(key);
          }

          return {
            data: fresh.value,
            metadata: {
              freshness: "authoritative" as const,
              source: "contract" as const,
              cacheAgeSeconds: 0,
              contractEpoch: epoch,
            },
          };
        } finally {
          this.inFlightResolvers.delete(key);
        }
      })();

      this.inFlightResolvers.set(key, inFlight);
    }

    return inFlight;
  }
}
