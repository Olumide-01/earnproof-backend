import { ApiProperty } from "@nestjs/swagger";
import { 
  AccessReviewCampaignStatus, 
  AccessReviewDecision, 
  OrganizationMemberRole 
} from "@prisma/client";

export class AccessReviewEntryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  campaignId!: string;

  @ApiProperty()
  memberId!: string;

  @ApiProperty()
  memberWalletAddress!: string;

  @ApiProperty({ enum: OrganizationMemberRole })
  snapshotRole!: OrganizationMemberRole;

  @ApiProperty({ enum: AccessReviewDecision, required: false })
  decision?: AccessReviewDecision;

  @ApiProperty({ enum: OrganizationMemberRole, required: false })
  recommendedRole?: OrganizationMemberRole;

  @ApiProperty({ required: false })
  reviewedById?: string;

  @ApiProperty({ required: false })
  reviewedAt?: Date;

  @ApiProperty({ required: false })
  appliedAt?: Date;

  @ApiProperty()
  conflictDetected!: boolean;

  @ApiProperty({ required: false })
  notes?: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class AccessReviewCampaignDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  createdById!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ required: false })
  description?: string;

  @ApiProperty({ enum: AccessReviewCampaignStatus })
  status!: AccessReviewCampaignStatus;

  @ApiProperty()
  snapshotVersion!: number;

  @ApiProperty({ required: false })
  completedAt?: Date;

  @ApiProperty({ required: false })
  cancelledAt?: Date;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ type: [AccessReviewEntryDto], required: false })
  entries?: AccessReviewEntryDto[];

  @ApiProperty({ required: false })
  entryCount?: number;

  @ApiProperty({ required: false })
  pendingCount?: number;

  @ApiProperty({ required: false })
  reviewedCount?: number;
}

export class ListAccessReviewsDto {
  @ApiProperty({ required: false, enum: AccessReviewCampaignStatus })
  status?: AccessReviewCampaignStatus;

  @ApiProperty({ required: false, minimum: 1, default: 1 })
  page?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 20 })
  limit?: number;
}