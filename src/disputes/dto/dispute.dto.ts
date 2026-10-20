import { ApiProperty } from "@nestjs/swagger";
import { DisputeCategory, DisputeStatus } from "@prisma/client";
import { Transform } from "class-transformer";
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  IsObject,
  IsUUID,
  Matches,
} from "class-validator";

export class CreateDisputeDto {
  @ApiProperty({
    description: "ID of the proof being disputed",
    example: "cuid_abc123",
  })
  @IsNotEmpty()
  @IsUUID()
  proofId!: string;

  @ApiProperty({
    description: "Category of the dispute",
    enum: DisputeCategory,
    example: DisputeCategory.ACCURACY,
  })
  @IsEnum(DisputeCategory)
  category!: DisputeCategory;

  @ApiProperty({
    description: "SHA-256 commitment of evidence (format: sha256:hexstring)",
    required: false,
    example: "sha256:a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3",
  })
  @IsOptional()
  @IsString()
  @Matches(/^sha256:[a-fA-F0-9]{64}$/, {
    message: "Evidence commitment must be in format sha256:hexstring",
  })
  evidenceCommitment?: string;

  @ApiProperty({
    description: "Additional metadata about the dispute",
    required: false,
    example: { source: "internal_audit", priority: "high" },
  })
  @IsOptional()
  @IsObject()
  @Transform(({ value }) => {
    // Ensure metadata doesn't exceed size limit
    if (value && JSON.stringify(value).length > 10_000) {
      throw new Error("Metadata too large (max 10KB)");
    }
    return value;
  })
  metadata?: Record<string, any>;
}

export class ListDisputesQueryDto {
  @ApiProperty({
    description: "Filter by dispute status",
    enum: DisputeStatus,
    required: false,
  })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;

  @ApiProperty({
    description: "Filter by dispute category",
    enum: DisputeCategory,
    required: false,
  })
  @IsOptional()
  @IsEnum(DisputeCategory)
  category?: DisputeCategory;

  @ApiProperty({
    description: "Filter by assigned reviewer ID",
    required: false,
  })
  @IsOptional()
  @IsString()
  assignedTo?: string;

  @ApiProperty({
    description: "Maximum number of results (1-100)",
    required: false,
    default: 20,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number;

  @ApiProperty({
    description: "Pagination cursor (dispute ID to start after)",
    required: false,
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class AssignDisputeDto {
  @ApiProperty({
    description: "User ID to assign the dispute to",
    example: "cuid_user123",
  })
  @IsNotEmpty()
  @IsString()
  assignedTo!: string;
}

export class ResolveDisputeDto {
  @ApiProperty({
    description: "Outcome of the dispute resolution",
    example: "UPHELD",
    maxLength: 100,
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  resolutionOutcome!: string;

  @ApiProperty({
    description: "Detailed reason for the resolution",
    example: "Evidence supports the dispute. Proof accuracy verified through independent audit.",
    maxLength: 2000,
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  resolutionReason!: string;
}

export class DisputeResponseDto {
  @ApiProperty({
    description: "Unique dispute identifier",
    example: "cuid_dispute123",
  })
  id!: string;

  @ApiProperty({
    description: "ID of the disputed proof",
    example: "cuid_proof123",
  })
  proofId!: string;

  @ApiProperty({
    description: "Dispute category",
    enum: DisputeCategory,
  })
  category!: DisputeCategory;

  @ApiProperty({
    description: "Current dispute status",
    enum: DisputeStatus,
  })
  status!: DisputeStatus;

  @ApiProperty({
    description: "Evidence commitment hash",
    required: false,
  })
  evidenceCommitment?: string;

  @ApiProperty({
    description: "User ID who submitted the dispute",
  })
  submittedBy!: string;

  @ApiProperty({
    description: "User ID assigned to review the dispute",
    required: false,
  })
  assignedTo?: string;

  @ApiProperty({
    description: "Outcome of resolution",
    required: false,
  })
  resolutionOutcome?: string;

  @ApiProperty({
    description: "Detailed resolution reason",
    required: false,
  })
  resolutionReason?: string;

  @ApiProperty({
    description: "User ID who resolved the dispute",
    required: false,
  })
  resolvedBy?: string;

  @ApiProperty({
    description: "When the dispute was submitted",
  })
  submittedAt!: string;

  @ApiProperty({
    description: "When the dispute was assigned",
    required: false,
  })
  assignedAt?: string;

  @ApiProperty({
    description: "When the dispute was resolved",
    required: false,
  })
  resolvedAt?: string;

  @ApiProperty({
    description: "When the dispute was withdrawn",
    required: false,
  })
  withdrawnAt?: string;

  @ApiProperty({
    description: "Additional dispute metadata",
    required: false,
  })
  metadata?: Record<string, any>;

  @ApiProperty({
    description: "Basic proof information",
    required: false,
  })
  proof?: {
    id: string;
    type: string;
    status: string;
    createdAt?: string;
    expiresAt?: string;
  };
}

export class DisputeListResponseDto {
  @ApiProperty({
    description: "List of disputes",
    type: [DisputeResponseDto],
  })
  items!: DisputeResponseDto[];

  @ApiProperty({
    description: "Pagination information",
  })
  pageInfo!: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export class DisputeStatsResponseDto {
  @ApiProperty({
    description: "Dispute counts by status and category",
    example: {
      OPEN: { ACCURACY: 5, FRAUD: 2 },
      RESOLVED: { ACCURACY: 15, FRAUD: 8, TECHNICAL: 3 },
    },
  })
  counts!: Record<string, Record<string, number>>;
}