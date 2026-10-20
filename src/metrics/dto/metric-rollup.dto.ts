import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsISO8601, IsString, MaxLength } from "class-validator";
import { METRIC_NAMES } from "../../common/observability/metrics.catalog";
import { MetricTier, type MetricTierValue } from "../metric-rollup";

const TIERS = Object.values(MetricTier);
const METRICS = Object.values(METRIC_NAMES);

export class QueryMetricRollupsDto {
  @ApiProperty({ enum: TIERS, description: "Aggregation tier." })
  @IsIn(TIERS)
  tier!: MetricTierValue;

  @ApiProperty({ enum: METRICS, description: "Metric from the SLI catalog." })
  @IsString()
  @MaxLength(64)
  @IsIn(METRICS)
  metric!: string;

  @ApiProperty({
    description: "Inclusive lower bound on bucket start (ISO-8601 UTC).",
    example: "2030-01-01T00:00:00.000Z",
  })
  @IsISO8601({ strict: true })
  from!: string;

  @ApiProperty({
    description:
      "Exclusive upper bound on bucket start (ISO-8601 UTC). The span may not exceed " +
      "1 day for MINUTE, 31 days for HOUR, or 731 days for DAY.",
    example: "2030-01-02T00:00:00.000Z",
  })
  @IsISO8601({ strict: true })
  to!: string;
}

export class MetricRollupPointDto {
  @ApiProperty({ example: "2030-01-01T00:00:00.000Z" })
  bucketStart!: string;

  @ApiProperty({ description: "Counter increments, or histogram observation sum." })
  sum!: number;

  @ApiProperty({ nullable: true, description: "Histogram observation count; null for counters." })
  count!: number | null;

  @ApiProperty({
    nullable: true,
    type: [Number],
    description: "Histogram cumulative bucket counts (+Inf last); null for counters.",
  })
  bucketCounts!: number[] | null;

  @ApiProperty({ description: "Inputs folded into this aggregate." })
  sampleCount!: number;
}

export class MetricRollupSeriesDto {
  @ApiProperty({
    description: "Bounded label set from the metric label vocabulary. Never an identifier.",
    example: { route: "/proofs", method: "GET", status_class: "2xx" },
    type: "object",
    additionalProperties: { type: "string" },
  })
  labels!: Record<string, string>;

  @ApiProperty({ type: [MetricRollupPointDto] })
  points!: MetricRollupPointDto[];
}

export class MetricRollupResponseDto {
  @ApiProperty({ enum: TIERS })
  tier!: MetricTierValue;

  @ApiProperty()
  metric!: string;

  @ApiProperty({ type: [MetricRollupSeriesDto] })
  series!: MetricRollupSeriesDto[];
}

export class MetricRollupStatusDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ description: "Random per-process identity; not a hostname." }) sourceId!: string;
  @ApiProperty() captureSeq!: number;
  @ApiProperty() pendingCaptures!: number;
  @ApiProperty() lateContributionsDropped!: number;
  @ApiProperty() overflowCapturesDropped!: number;
  @ApiProperty() rejectedRollupInputs!: number;
  @ApiProperty({
    description: "Exclusive end of the newest rolled-up bucket per tier.",
    type: "object",
    additionalProperties: { type: "string", nullable: true },
  })
  watermarks!: Record<MetricTierValue, string | null>;
}
