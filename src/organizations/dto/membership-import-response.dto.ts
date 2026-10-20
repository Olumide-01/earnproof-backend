import { ApiProperty } from "@nestjs/swagger";
import { MembershipImportStatus, MembershipImportRowResult, OrganizationMemberRole } from "@prisma/client";

export class MembershipImportResultDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rowIndex!: number;

  @ApiProperty()
  walletAddress!: string;

  @ApiProperty({ enum: OrganizationMemberRole })
  requestedRole!: OrganizationMemberRole;

  @ApiProperty({ enum: MembershipImportRowResult })
  result!: MembershipImportRowResult;

  @ApiProperty({ required: false })
  reasonCode?: string;

  @ApiProperty({ required: false })
  errorMessage?: string;

  @ApiProperty({ required: false })
  processedAt?: Date;

  @ApiProperty()
  createdAt!: Date;
}

export class MembershipImportResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  createdById!: string;

  @ApiProperty()
  version!: string;

  @ApiProperty({ required: false })
  filename?: string;

  @ApiProperty()
  rowCount!: number;

  @ApiProperty({ enum: MembershipImportStatus })
  status!: MembershipImportStatus;

  @ApiProperty()
  progress!: number;

  @ApiProperty({ required: false })
  cancelledAt?: Date;

  @ApiProperty({ required: false })
  completedAt?: Date;

  @ApiProperty({ required: false })
  errorMessage?: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ type: [MembershipImportResultDto], required: false })
  results?: MembershipImportResultDto[];
}

export class ListMembershipImportsDto {
  @ApiProperty({ required: false, enum: MembershipImportStatus })
  status?: MembershipImportStatus;

  @ApiProperty({ required: false, minimum: 1, default: 1 })
  page?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 20 })
  limit?: number;
}