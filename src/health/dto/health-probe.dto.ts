import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class LivenessResponseDto {
  @ApiProperty({ example: "ok" })
  status!: string;

  @ApiProperty({ example: "earnproof-api" })
  service!: string;

  @ApiProperty({
    description: "ISO-8601 UTC timestamp of when the probe was answered.",
    example: "2025-01-15T12:00:00.000Z",
  })
  timestamp!: string;
}

export class DependencyResultDto {
  @ApiProperty({
    description: "Stable dependency identifier.",
    example: "database",
  })
  name!: string;

  @ApiProperty({
    description:
      "Whether this dependency can make the service unready. Only required " +
      "dependencies gate readiness.",
    enum: ["required", "optional"],
    example: "required",
  })
  kind!: string;

  @ApiProperty({
    description:
      "Stable status code. Callers should branch on this rather than on any " +
      "human-readable text.",
    enum: ["ok", "degraded", "timeout", "error", "disabled", "not_configured"],
    example: "ok",
  })
  status!: string;

  @ApiPropertyOptional({
    description: "Observed probe duration in milliseconds.",
    example: 12,
  })
  durationMs?: number;

  @ApiPropertyOptional({
    description:
      "Stable, non-identifying reason code for a non-ok status. Never contains " +
      "connection strings, credentials, hostnames, or raw driver errors.",
    example: "probe_timeout",
  })
  reason?: string;

  @ApiPropertyOptional({
    description: "True when this result was served from cache.",
    example: false,
  })
  cached?: boolean;

  @ApiPropertyOptional({
    description: "Age of a cached result in milliseconds.",
    example: 1200,
  })
  ageMs?: number;

  @ApiPropertyOptional({
    description:
      "Diagnostics only, on the `clock_skew` entry: provable local-vs-network " +
      "skew (ms, positive = local ahead), sustained-alert state, policy and " +
      "per-source outcome codes. See docs/clock-skew.md.",
    type: "object",
    additionalProperties: true,
  })
  clockSkew?: object;
}

export class ReadinessResponseDto {
  @ApiProperty({
    description:
      "Aggregate verdict. Only required dependencies can produce not_ready.",
    enum: ["ready", "not_ready"],
    example: "ready",
  })
  status!: string;

  @ApiProperty({ type: [DependencyResultDto] })
  dependencies!: DependencyResultDto[];
}
