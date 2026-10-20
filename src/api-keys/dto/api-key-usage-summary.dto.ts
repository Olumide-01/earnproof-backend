import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ApiKeyEndpointCategory, ApiKeyUsageOutcome } from "@prisma/client";

export class ApiKeyUsageBucketDto {
  @ApiProperty({
    description: "Endpoint category (coarse resource type, never a raw path).",
    enum: ApiKeyEndpointCategory,
    example: ApiKeyEndpointCategory.PROOF,
  })
  category!: ApiKeyEndpointCategory;

  @ApiProperty({
    description: "Request outcome.",
    enum: ApiKeyUsageOutcome,
    example: ApiKeyUsageOutcome.SUCCESS,
  })
  outcome!: ApiKeyUsageOutcome;

  @ApiProperty({
    description: "Total requests in this bucket since the key was created.",
    example: 142,
  })
  requestCount!: number;

  @ApiPropertyOptional({
    description:
      "Rounded-to-minute UTC timestamp of the most recent request. Null if never used in this bucket.",
    example: "2026-08-29T14:23:00.000Z",
    nullable: true,
  })
  lastUsedAt!: string | null;

  @ApiPropertyOptional({
    description:
      "Set when the parent key was revoked. Once set, this bucket is no longer updated.",
    example: null,
    nullable: true,
  })
  revokedSummaryFrozenAt!: string | null;
}

export class ApiKeyUsageSummaryDto {
  @ApiProperty({ description: "The API key ID.", example: "clx1abc2def3ghi4" })
  keyId!: string;

  @ApiProperty({
    description: "Usage breakdown by endpoint category and outcome.",
    type: [ApiKeyUsageBucketDto],
  })
  buckets!: ApiKeyUsageBucketDto[];

  @ApiProperty({ description: "Total requests across all buckets.", example: 284 })
  totalRequests!: number;
}