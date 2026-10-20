import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min, ArrayMinSize, ArrayMaxSize } from "class-validator";

/**
 * Request to generate a bounded offline verification bundle.
 *
 * @example
 * {
 *   "proofIds": ["clx1abc2def3ghi4", "clx2xyz3def4ghi5"],
 *   "expiresAt": "2025-10-15T15:30:00.000Z",
 *   "maxFreshnessSeconds": 1800,
 *   "operations": ["verify"],
 *   "acknowledgeOfflineRisk": true
 * }
 */
export class CreateOfflineBundleDto {
  @ApiProperty({
    description: "List of proof IDs to include in the bundle.",
    type: [String],
    example: ["clx1abc2def3ghi4", "clx2xyz3def4ghi5"],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  proofIds!: string[];

  @ApiProperty({
    description: "ISO-8601 UTC timestamp when the bundle expires and becomes invalid.",
    example: "2025-10-15T15:30:00.000Z",
  })
  @IsDateString()
  expiresAt!: string;

  @ApiProperty({
    description:
      "Maximum age in seconds that included revocation checkpoints may be treated as current. " +
      "A checkpoint older than this is considered stale for offline verification.",
    minimum: 60,
    maximum: 86400,
    example: 1800,
  })
  @IsInt()
  @Min(60)
  @Max(86400)
  maxFreshnessSeconds!: number;

  @ApiProperty({
    description: "Authorized operations for this bundle (currently only 'verify' is supported).",
    type: [String],
    enum: ["verify", "audit"],
    example: ["verify"],
  })
  @IsEnum(["verify", "audit"], { each: true })
  @IsArray()
  @ArrayMinSize(1)
  operations!: string[];

  @ApiPropertyOptional({
    description:
      "Whether you acknowledge the risks of offline verification: bundles are time-limited evidence only " +
      "and must not replace online proof validity and revocation checks.",
    example: true,
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  acknowledgeOfflineRisk?: boolean;
}
