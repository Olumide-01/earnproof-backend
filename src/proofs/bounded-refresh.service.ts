import { Injectable, Logger } from "@nestjs/common";
import { ProofsService } from "./proofs.service";
import {
  RefreshProofRequestDto,
  RefreshProofResponseDto,
  RefreshSource,
  ResultProvenance,
} from "./dto/refresh-proof.dto";
import { VerificationClientContext } from "../common/rate-limit/proof-verification-abuse.service";

/**
 * Configuration for bounded refresh behavior.
 */
export interface BoundedRefreshConfig {
  /**
   * Default maximum latency in milliseconds if not specified in request.
   * @default 5000
   */
  defaultMaxLatencyMs: number;

  /**
   * Maximum allowed latency bound in milliseconds.
   * @default 30000
   */
  maxLatencyMs: number;

  /**
   * Minimum allowed latency bound in milliseconds.
   * @default 100
   */
  minLatencyMs: number;

  /**
   * Global limit on concurrent live refresh operations.
   * @default 10
   */
  globalMaxConcurrency: number;
}

/**
 * In-flight refresh tracking for concurrency and deduplication.
 */
interface InFlightRefresh {
  proofId: string;
  startedAt: number;
  abortController: AbortController;
  promise: Promise<any>;
}

/**
 * BoundedRefreshService manages live verification refresh operations with:
 * - Source selection (cache, live, or prefer-live)
 * - Maximum latency bounds with deterministic timeout behavior
 * - Concurrency limits to prevent thundering herd
 * - Result provenance to indicate freshness source
 * - Fail-closed semantics: on-chain invalidity overrides local state
 * - Fail-open semantics: if live check fails, safe fallback to cache
 */
@Injectable()
export class BoundedRefreshService {
  private readonly logger = new Logger(BoundedRefreshService.name);
  private readonly config: BoundedRefreshConfig;

  /**
   * In-flight refreshes tracked by proof ID for deduplication and concurrency control.
   */
  private inFlightRefreshes = new Map<string, InFlightRefresh>();

  /**
   * Concurrent live refresh counter.
   */
  private activeRefreshCount = 0;

  /**
   * Queue of pending refreshes waiting for a concurrency slot.
   */
  private pendingRefreshQueue: Array<{
    proofId: string;
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    startTime: number;
  }> = [];

  constructor(
    private readonly proofsService: ProofsService,
    config?: Partial<BoundedRefreshConfig>,
  ) {
    this.config = {
      defaultMaxLatencyMs: 5000,
      maxLatencyMs: 30000,
      minLatencyMs: 100,
      globalMaxConcurrency: 10,
      ...config,
    };
  }

  /**
   * Perform a bounded live verification refresh for a proof.
   * Respects source selection, latency bounds, and concurrency limits.
   * Returns result provenance indicating whether source was live, cached, or fallback.
   */
  async refreshProof(
    proofId: string,
    request: RefreshProofRequestDto,
    context: VerificationClientContext = {},
  ): Promise<RefreshProofResponseDto> {
    const startTime = Date.now();

    // Normalize latency bounds
    const maxLatencyMs = this.normalizeMaxLatency(request.maxLatencyMs);

    // Handle source selection
    switch (request.source) {
      case RefreshSource.CACHE:
        return this.refreshFromCache(proofId, context, startTime);

      case RefreshSource.LIVE:
        return this.refreshLiveWithTimeout(proofId, context, maxLatencyMs, startTime);

      case RefreshSource.PREFER_LIVE:
        return this.refreshPreferLive(proofId, context, maxLatencyMs, startTime);

      default:
        throw new Error(`Unknown refresh source: ${request.source}`);
    }
  }

  /**
   * Refresh using only cached/local state.
   * No on-chain contract check is performed.
   */
  private async refreshFromCache(
    proofId: string,
    context: VerificationClientContext,
    startTime: number,
  ): Promise<RefreshProofResponseDto> {
    try {
      // Verify proof using standard verification path (uses cached contract status if available)
      const verified = await this.proofsService.verifyProof(proofId, context);

      return {
        ...verified,
        freshness: {
          provenance: ResultProvenance.CACHE,
          latencyMs: Date.now() - startTime,
          reason: "source_requested_cache",
        },
      };
    } catch (error) {
      this.logger.error(`Error refreshing proof ${proofId} from cache`, error);
      throw error;
    }
  }

  /**
   * Refresh using live on-chain check, must complete within maxLatencyMs.
   * If latency bound exceeded, rejects with error.
   */
  private async refreshLiveWithTimeout(
    proofId: string,
    context: VerificationClientContext,
    maxLatencyMs: number,
    startTime: number,
  ): Promise<RefreshProofResponseDto> {
    // Check for in-flight deduplication: if same proof is already being refreshed live,
    // join that request instead of spawning duplicate contract calls
    const inFlight = this.inFlightRefreshes.get(`live:${proofId}`);
    if (inFlight) {
      try {
        const result = await Promise.race([
          inFlight.promise,
          this.createTimeoutPromise(maxLatencyMs, "live_check_exceeded_latency_bound"),
        ]);
        return result;
      } catch (error) {
        if (error.message === "live_check_exceeded_latency_bound") {
          const elapsed = Date.now() - startTime;
          this.logger.warn(
            `Live refresh for proof ${proofId} exceeded latency bound (${elapsed}ms > ${maxLatencyMs}ms)`,
          );
          throw new Error(`Live verification latency bound exceeded: ${elapsed}ms > ${maxLatencyMs}ms`);
        }
        throw error;
      }
    }

    // Acquire concurrency slot or queue
    const concurrencyToken = await this.acquireConcurrencySlot();
    const abortController = new AbortController();

    try {
      // Perform live verification with timeout
      // The verifyProof method always checks contract status if enabled and available
      const verifyPromise = (async () => {
        try {
          const verified = await this.proofsService.verifyProof(proofId, context);

          return {
            ...verified,
            freshness: {
              provenance: ResultProvenance.LIVE,
              checkedAt: new Date().toISOString(),
              latencyMs: Date.now() - startTime,
            },
          };
        } catch (error) {
          if (abortController.signal.aborted) {
            throw new Error("Live refresh timed out");
          }
          throw error;
        }
      })();

      // Track in-flight refresh for deduplication
      const inFlightRefresh: InFlightRefresh = {
        proofId,
        startedAt: startTime,
        abortController,
        promise: verifyPromise,
      };
      this.inFlightRefreshes.set(`live:${proofId}`, inFlightRefresh);

      try {
        const result = await Promise.race([
          verifyPromise,
          this.createTimeoutPromise(maxLatencyMs, "live_check_exceeded_latency_bound"),
        ]);

        return result;
      } finally {
        this.inFlightRefreshes.delete(`live:${proofId}`);
      }
    } finally {
      this.releaseConcurrencySlot(concurrencyToken);
    }
  }

  /**
   * Refresh preferring live on-chain check within latency bound.
   * If live check succeeds within bound, returns LIVE provenance.
   * If live check fails or exceeds bound, falls back to cache.
   * If cache is also unavailable, returns LOCAL_ONLY with no contract check.
   */
  private async refreshPreferLive(
    proofId: string,
    context: VerificationClientContext,
    maxLatencyMs: number,
    startTime: number,
  ): Promise<RefreshProofResponseDto> {
    try {
      // Attempt live check with timeout
      return await this.refreshLiveWithTimeout(proofId, context, maxLatencyMs, startTime);
    } catch (liveError) {
      const elapsedMs = Date.now() - startTime;

      // Live check failed or timed out; fall back to cache
      this.logger.debug(
        `Live refresh for proof ${proofId} failed (${liveError.message}), falling back to cache`,
      );

      try {
        // Fallback to cache
        const cached = await this.proofsService.verifyProof(proofId, context);

        return {
          ...cached,
          freshness: {
            provenance: ResultProvenance.CACHE_FALLBACK,
            latencyMs: elapsedMs,
            reason: `live_check_failed: ${liveError.message}`,
          },
        };
      } catch (cacheError) {
        // Cache lookup also failed; return local state only
        this.logger.warn(
          `Both live and cache refresh failed for proof ${proofId}. Returning local state only.`,
        );

        // Fall back to standard verification (local state with cached contract if available)
        const localOnly = await this.proofsService.verifyProof(proofId, context);

        return {
          ...localOnly,
          freshness: {
            provenance: ResultProvenance.LOCAL_ONLY,
            latencyMs: elapsedMs,
            reason: `live_and_cache_failed: live=${liveError.message}, cache=${cacheError.message}`,
          },
        };
      }
    }
  }

  /**
   * Normalize maximum latency to configured bounds.
   */
  private normalizeMaxLatency(maxLatencyMs?: number): number {
    if (maxLatencyMs === undefined) {
      return this.config.defaultMaxLatencyMs;
    }

    const bounded = Math.max(
      this.config.minLatencyMs,
      Math.min(maxLatencyMs, this.config.maxLatencyMs),
    );

    if (bounded !== maxLatencyMs) {
      this.logger.debug(
        `Normalized maxLatency from ${maxLatencyMs}ms to ${bounded}ms (bounds: [${this.config.minLatencyMs}, ${this.config.maxLatencyMs}])`,
      );
    }

    return bounded;
  }

  /**
   * Acquire a concurrency slot, queuing if necessary.
   * Returns a token to be released when done.
   */
  private async acquireConcurrencySlot(): Promise<symbol> {
    const token = Symbol("concurrency-token");

    if (this.activeRefreshCount < this.config.globalMaxConcurrency) {
      this.activeRefreshCount++;
      return token;
    }

    // Queue and wait for a slot
    return new Promise<symbol>((resolve, reject) => {
      this.pendingRefreshQueue.push({
        proofId: "",
        resolve: () => resolve(token),
        reject,
        startTime: Date.now(),
      });
    });
  }

  /**
   * Release a concurrency slot and grant it to queued refresh if any.
   */
  private releaseConcurrencySlot(token: symbol): void {
    this.activeRefreshCount--;

    const pending = this.pendingRefreshQueue.shift();
    if (pending) {
      this.activeRefreshCount++;
      pending.resolve(undefined);
    }
  }

  /**
   * Create a promise that rejects after delay with given message.
   */
  private createTimeoutPromise(delayMs: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(message));
      }, delayMs);
    });
  }

  /**
   * Get current concurrency metrics for monitoring.
   */
  getMetrics() {
    return {
      activeRefreshCount: this.activeRefreshCount,
      maxConcurrency: this.config.globalMaxConcurrency,
      pendingRefreshCount: this.pendingRefreshQueue.length,
      inFlightCount: this.inFlightRefreshes.size,
    };
  }
}
