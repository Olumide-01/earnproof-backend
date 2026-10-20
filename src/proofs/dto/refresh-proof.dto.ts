import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEnum, IsNumber, IsOptional, Min, Max } from "class-validator";
import { VerifyProofResponseDto } from "./verify-proof-response.dto";

/**
 * Source selection for bounded live verification refresh.
 * Determines where the verification result is sourced from.
 */
export enum RefreshSource {
  /**
   * CACHE: Use cached state (fastest, may be stale).
   * Fallback to cache if live refresh exceeds maxLatency.
   */
  CACHE = "cache",

  /**
   * LIVE: Require live on-chain status check within maxLatency.
   * If contract check exceeds maxLatency or fails, return error.
   */
  LIVE = "live",

  /**
   * PREFER_LIVE: Attempt live refresh within maxLatency, fallback to cache if exceeded.
   * Result provenance indicates whether source was live or cached.
   */
  PREFER_LIVE = "prefer_live",
}

/**
 * Result provenance: indicates whether the result came from cache or live lookup.
 */
export enum ResultProvenance {
  /**
   * Result sourced from local cache (may be stale).
   */
  CACHE = "cache",

  /**
   * Result sourced from live on-chain contract check within latency bound.
   */
  LIVE = "live",

  /**
   * Live refresh was requested but exceeded maxLatency; fell back to cache.
   */
  CACHE_FALLBACK = "cache_fallback",

  /**
   * Live refresh was requested, latency bound was hit, and cache was also unavailable.
   * Verification proceeded with local state only (no contract check).
   */
  LOCAL_ONLY = "local_only",
}

/**
 * Request DTO for bounded live verification refresh.
 */
export class RefreshProofRequestDto {
  @ApiProperty({
    description: "Source selection for the verification refresh.",
    enum: RefreshSource,
    example: RefreshSource.PREFER_LIVE,
  })
  @IsEnum(RefreshSource)
  source!: RefreshSource;

  @ApiPropertyOptional({
    description:
      "Maximum milliseconds to wait for live contract status check. " +
      "If exceeded and source is PREFER_LIVE, falls back to cache. " +
      "If LIVE, returns error. " +
      "Bounds to [100, 30000] ms.",
    example: 5000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(100)
  @Max(30000)
  maxLatencyMs?: number;

  @ApiPropertyOptional({
    description:
      "Maximum number of concurrent live refresh operations allowed globally. " +
      "Queued refreshes wait for available slot. Bounds to [1, 100].",
    example: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  maxConcurrency?: number;
}

/**
 * Freshness metadata in the refresh response.
 */
export class FreshnessMetadataDto {
  @ApiProperty({
    description: "When the result was sourced (cache, live, or fallback).",
    enum: ResultProvenance,
    example: ResultProvenance.LIVE,
  })
  provenance!: ResultProvenance;

  @ApiPropertyOptional({
    description: "ISO-8601 UTC timestamp when the live check was performed, if provenance is LIVE.",
    example: "2025-01-15T12:34:56.789Z",
  })
  checkedAt?: string;

  @ApiPropertyOptional({
    description: "Actual milliseconds taken to perform the live check, if applicable.",
    example: 234,
  })
  latencyMs?: number;

  @ApiPropertyOptional({
    description: "Human-readable reason if the refresh was rate-limited or queued.",
    example: "queued_for_concurrency_slot",
  })
  reason?: string;
}

/**
 * Response DTO for bounded live verification refresh.
 * Extends the standard VerifyProofResponseDto with freshness provenance.
 */
export class RefreshProofResponseDto extends VerifyProofResponseDto {
  @ApiProperty({
    type: () => FreshnessMetadataDto,
    description: "Metadata indicating the source and freshness of the verification result.",
  })
  freshness!: FreshnessMetadataDto;
}
