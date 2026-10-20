import { ApiProperty } from "@nestjs/swagger";
import { SharingOutcome } from "@prisma/client";
import { IsDateString, IsInt, IsOptional, IsUUID, Min } from "class-validator";

export class CreateSharingTokenDto {
  @ApiProperty({
    description: "When the sharing token should expire (ISO 8601)",
    example: "2026-12-31T23:59:59Z",
    required: false,
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiProperty({
    description: "Maximum number of times this token can be used (not implemented in MVP)",
    example: 10,
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;

  @ApiProperty({
    description: "Purpose for creating this sharing token",
    example: "Verification by third-party lender",
    required: false,
  })
  @IsOptional()
  purpose?: string;
}

export class SharingTokenResponseDto {
  @ApiProperty({
    description: "The sharing token - display this EXACTLY ONCE to the user",
    example: "share_dGVzdGtleV8w_VlqXyz...",
  })
  token: string;

  @ApiProperty({
    description: "When this token expires",
  })
  expiresAt: Date;
}

export class SharingEventAggregateDto {
  @ApiProperty({
    enum: SharingOutcome,
    description: "The access outcome type",
  })
  outcome: SharingOutcome;

  @ApiProperty({
    description: "Number of events with this outcome",
    example: 25,
  })
  count: number;

  @ApiProperty({
    description: "When this outcome was last recorded",
    nullable: true,
  })
  lastAccessedAt: Date | null;
}

export class RecentSharingEventDto {
  @ApiProperty({
    description: "Proof ID that was accessed",
  })
  proofId: string;

  @ApiProperty({
    enum: SharingOutcome,
    description: "The access outcome",
  })
  outcome: SharingOutcome;

  @ApiProperty({
    description: "When the access occurred",
  })
  accessedAt: Date;
}

export class ProofSharingSummaryDto {
  @ApiProperty({
    type: [SharingEventAggregateDto],
    description: "Aggregate counts by outcome type",
  })
  aggregates: SharingEventAggregateDto[];

  @ApiProperty({
    type: [RecentSharingEventDto], 
    description: "Recent access events (up to 50 most recent)",
  })
  recentEvents: RecentSharingEventDto[];
}

export class SharingAccessQueryDto {
  @ApiProperty({
    description: "Organization ID to get sharing data for",
    required: false,
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({
    description: "Specific proof ID to filter by (optional)",
    required: false,
  })
  @IsOptional()
  @IsUUID()
  proofId?: string;
}